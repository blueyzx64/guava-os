// SPDX-License-Identifier: GPL-3.0-or-later
// FeatureRegistry: decides which features run and starts or stops them.
// The list of features lives in ../features.js; this file is the engine.
//
// No gi:// imports, so it runs under plain `gjs -m` for tests. It only needs a
// CleanupRegistry-like class, which it gets from the constructor.
//
// Entry shape (id and one of cls / load are required):
//   id            unique string
//   setting       boolean settings key; shorthand for when: ctx => ctx.settings.get_boolean(key)
//   when(ctx)     true when the feature should run (default: the `setting` shorthand, else true)
//   cls           the feature class: new cls(ctx, cleanup), then .enable() / .disable()
//   load()        async alternative to cls: resolves to the class. Called the first time the
//                 entry is wanted, so a feature that is off never has its modules parsed. The
//                 entry starts in the pass after the class arrives (status 'loading' until then)
//   restartOn     settings keys that force a stop before the next evaluation (a restart)
//   needs         ids that must run too, else this one is held off ('paused')
//   conflictsWith ids this entry beats: while this entry is wanted, they are held off
//   keys          extra settings keys of this entry: a change retries it after a failed enable()
//
// `cleanup` is a CleanupRegistry owned by the entry; the registry disposes it right after
// disable(), so a feature that registers everything there needs no manual teardown.
// enable() and disable() are only ever called on a state change (edge-triggered).

export class FeatureRegistry {
    /**
     * @param {typeof CleanupRegistry} CleanupClass class used for each entry's own registry
     * @param {{onChange?: (id: string, active: boolean) => void}} [opts] onChange runs after a
     *   feature started or stopped (extension.js turns it into the 'feature-changed' event)
     */
    constructor(CleanupClass, { onChange = () => {} } = {}) {
        this._Cleanup = CleanupClass;
        this._onChange = onChange;
        this._entries = [];
        this._byId = new Map();
        this._state = new Map();   // id -> {active, cleanup, instance, failed, cls, loading}
        this._ctx = null;
        this._status = new Map();  // id -> 'active' | 'paused' | 'loading' | 'off'
        this._generation = 0;      // bumps on stop(); a load that resolves later is dropped
        this._passing = false;     // a pass is running: refreshes asked meanwhile wait for it
        this._waiting = [];        // keys of those refreshes, in order (null: no key)
    }

    /**
     * Add a feature. Order of registration is order of start and refresh; stop runs in reverse.
     *
     * @param {object} entry see the file header
     */
    register(entry) {
        if (!entry?.id)
            throw new Error('feature entry needs an id');
        if (this._byId.has(entry.id))
            throw new Error(`duplicate feature id '${entry.id}'`);
        if (!entry.cls && !entry.load)
            throw new Error(`feature '${entry.id}' needs cls or load()`);
        this._entries.push(entry);
        this._byId.set(entry.id, entry);
        this._state.set(entry.id, {
            active: false, cleanup: null, instance: null, failed: false,
            cls: entry.cls ?? null, loading: null,
        });
        this._status.set(entry.id, 'off');
    }

    /** @param {object[]} entries */
    registerAll(entries) {
        entries.forEach(e => this.register(e));
    }

    /** 'active' (running), 'paused' (held off by needs/conflictsWith), 'loading' or 'off'. */
    status(id) {
        return this._status.get(id) ?? 'off';
    }

    isActive(id) {
        return this._state.get(id)?.active ?? false;
    }

    /**
     * The running instance of a feature, or null while it is off.
     * How features reach each other's public methods (e.g. Show Desktop asks Stage Manager);
     * callers look it up at use time and never keep it.
     */
    instance(id) {
        const st = this._state.get(id);
        return st?.active ? st.instance ?? null : null;
    }

    /** Resolves when no load() is pending (tests; the Shell never waits on it). */
    async settled() {
        for (;;) {
            const pending = [...this._state.values()].map(st => st.loading).filter(Boolean);
            if (!pending.length)
                return;
            await Promise.allSettled(pending);
        }
    }

    /**
     * First pass over every entry.
     *
     * @param {object} ctx passed to every when / constructor
     */
    start(ctx) {
        this._ctx = ctx;
        this._run([null]);
    }

    /**
     * Re-evaluate after a settings key changed (or null: something else changed).
     *
     * @param {string|null} key
     */
    refresh(key) {
        this.refreshKeys([key]);
    }

    /**
     * One evaluation after several settings keys changed (a reset writes hundreds).
     *
     * @param {(string|null)[]} keys
     */
    refreshKeys(keys) {
        if (this._ctx)
            this._run(keys);
    }

    /** Disable everything, newest registration first. */
    stop() {
        // First: a settings write made by a disable() must not start anything again
        this._ctx = null;
        this._waiting = [];
        for (const entry of [...this._entries].reverse()) {
            if (this._state.get(entry.id).active)
                this._disable(entry);
        }
        for (const id of this._status.keys())
            this._status.set(id, 'off');
        for (const st of this._state.values())
            st.failed = false;
        this._generation++;
    }

    _wanted(entry, ctx) {
        try {
            if (entry.when)
                return !!entry.when(ctx);
            if (entry.setting)
                return !!ctx.settings.get_boolean(entry.setting);
            return true;
        } catch (e) {
            console.error(`[Guava] feature '${entry.id}' when() failed:`, e);
            return false;
        }
    }

    // Wanted by settings, then reduced by needs/conflicts until stable.
    _effective(wanted) {
        const eff = new Map(wanted);
        let changed = true;
        for (let guard = this._entries.length + 1; changed && guard > 0; guard--) {
            changed = false;
            for (const entry of this._entries) {
                if (!eff.get(entry.id))
                    continue;
                const missing = (entry.needs ?? []).some(id => !eff.get(id));
                const beaten = this._entries.some(o =>
                    o !== entry && eff.get(o.id) && (o.conflictsWith ?? []).includes(entry.id));
                if (missing || beaten) {
                    eff.set(entry.id, false);
                    changed = true;
                }
            }
        }
        return eff;
    }

    // One pass at a time. A feature's enable() or disable() may write a Guava setting; the
    // refresh that write asks for waits until the running pass is over (it would otherwise see
    // the entry being started as not started yet and start it again).
    _run(keys) {
        this._waiting.push(...keys);
        if (this._passing)
            return;
        this._passing = true;
        try {
            while (this._waiting.length && this._ctx) {
                const batch = [...new Set(this._waiting)];
                this._waiting = [];
                this._pass(batch.filter(k => k !== null));
            }
        } finally {
            this._passing = false;
        }
    }

    // `keys`: the settings keys that changed since the last pass
    _pass(keys) {
        const ctx = this._ctx;

        if (keys.length) {
            for (const entry of this._entries) {
                if (keys.some(k => entry.restartOn?.includes(k)) && this._state.get(entry.id).active)
                    this._disable(entry);
            }
        }

        const wanted = new Map();
        for (const entry of this._entries)
            wanted.set(entry.id, this._wanted(entry, ctx));

        // A feature whose enable() threw is left out until it is turned off, or one of its own
        // keys changes: it does not pause its conflict losers or satisfy `needs`, and it is not
        // retried (and logged) on every unrelated refresh.
        for (const entry of this._entries) {
            const st = this._state.get(entry.id);
            if (st.failed && (!wanted.get(entry.id) || keys.some(k => this._ownKeys(entry).includes(k))))
                st.failed = false;
        }
        const candidates = new Map();
        for (const entry of this._entries)
            candidates.set(entry.id, wanted.get(entry.id) && !this._state.get(entry.id).failed);
        const effective = this._effective(candidates);
        let newlyFailed = false;

        // Features that must stop go first, so a loser of a conflict is gone before its
        // winner starts.
        for (const entry of this._entries) {
            if (!effective.get(entry.id) && this._state.get(entry.id).active)
                this._disable(entry);
        }

        // Starts keep registration order even with lazy classes: once one entry waits for its
        // class, the entries after it that would start now wait too (their classes load in
        // parallel), and the pass that follows the load starts them in order.
        let waiting = false;
        for (const entry of this._entries) {
            const st = this._state.get(entry.id);
            // A dependency that failed earlier in this same pass holds this one off right away
            const on = effective.get(entry.id) &&
                !(entry.needs ?? []).some(id => this._state.get(id)?.failed);
            let deferred = false;
            if (on && !st.active) {
                if (!st.cls)
                    this._load(entry);
                if (!st.cls || waiting) {
                    waiting = true;
                    deferred = true;
                } else {
                    this._enable(entry);
                    newlyFailed ||= st.failed;
                }
            }
            let status = 'off';
            if (on && st.active)
                status = 'active';
            else if (deferred && !st.failed)
                status = 'loading';
            else if (wanted.get(entry.id) && !st.failed)
                status = 'paused';
            this._status.set(entry.id, status);
        }

        // Losers paused for a winner that just failed come back now. Bounded: failed entries
        // are excluded from the next pass, so it can only shrink.
        if (newlyFailed)
            this._pass([]);
    }

    // Settings keys that belong to an entry: its `setting`, `restartOn` and optional `keys`.
    _ownKeys(entry) {
        return [entry.setting, ...(entry.restartOn ?? []), ...(entry.keys ?? [])].filter(Boolean);
    }

    _load(entry) {
        const st = this._state.get(entry.id);
        if (st.loading)
            return;
        const generation = this._generation;
        st.loading = Promise.resolve()
            .then(() => entry.load())
            .then(cls => {
                if (typeof cls !== 'function')
                    throw new Error('load() did not resolve to a class');
                st.cls = cls;
            })
            .catch(e => {
                console.error(`[Guava] feature '${entry.id}' failed to load:`, e);
                st.failed = true;
            })
            .finally(() => {
                st.loading = null;
                // Still the same enable cycle: evaluate again so the entry starts (or, when it
                // failed, so its conflict losers come back)
                if (this._ctx && generation === this._generation)
                    this._run([null]);
            });
    }

    _enable(entry) {
        const st = this._state.get(entry.id);
        if (!st.cleanup)
            st.cleanup = new this._Cleanup();
        try {
            st.instance = new st.cls(this._ctx, st.cleanup);
            st.instance.enable();
            st.active = true;
            st.failed = false;
            this._notify(entry.id, true);
        } catch (e) {
            console.error(`[Guava] feature '${entry.id}' enable failed:`, e);
            this._disable(entry);
            st.failed = true;
        }
    }

    _notify(id, active) {
        try {
            this._onChange(id, active);
        } catch (e) {
            console.error(`[Guava] feature '${id}' change listener failed:`, e);
        }
    }

    _disable(entry) {
        const st = this._state.get(entry.id);
        const wasActive = st.active;
        try {
            st.instance?.disable();
        } catch (e) {
            console.error(`[Guava] feature '${entry.id}' disable failed:`, e);
        }
        st.instance = null;
        try {
            st.cleanup?.dispose();
        } catch (e) {
            console.error(`[Guava] feature '${entry.id}' cleanup failed:`, e);
        }
        st.active = false;
        if (wasActive)
            this._notify(entry.id, false);
    }
}
