// SPDX-License-Identifier: GPL-3.0-or-later
// Lock-screen rules (D-018, D-022), pure: no gi:// imports, runs under plain `gjs -m`.
//
// While the screen is locked ('unlock-dialog' session mode) Guava stays loaded, so unlocking costs
// nothing. Every feature is suspended (its surfaces hidden and not reactive) except the entries that
// declare `lockScreen: true` in features.js: those keep running and are told about lock and unlock.

/** @param {{lockScreen?: boolean}} entry @param {boolean} locked @returns {boolean} */
export function isSuspended(entry, locked) {
    return !!locked && entry.lockScreen !== true;
}

/**
 * What a lock change does to the running entries.
 *
 * @param {Array<{id: string, lockScreen?: boolean}>} entries registered entries
 * @param {boolean} locked the new state
 * @returns {{suspend: string[], resume: string[], notify: string[]}} `suspend`/`resume`: entries
 *   whose surfaces are hidden/restored; `notify`: lockScreen entries that get lock()/unlock()
 */
export function lockPlan(entries, locked) {
    const suspend = [], resume = [], notify = [];
    for (const e of entries) {
        if (e.lockScreen === true)
            notify.push(e.id);
        else
            (locked ? suspend : resume).push(e.id);
    }
    return { suspend, resume, notify };
}

/**
 * Hides actors and gives them back as they were. An actor already hidden stays hidden at restore
 * unless it was shown while held (guard() hides it again but remembers); one destroyed meanwhile
 * is skipped by the `alive` test.
 */
export class SurfaceLedger {
    /** @param {(actor: object) => boolean} [alive] false for a destroyed actor */
    constructor(alive = () => true) {
        this._alive = alive;
        this._saved = new Map(); // actor -> {reactive, visible}
    }

    get hidden() {
        return this._saved.size > 0;
    }

    /**
     * @param {Iterable<{visible: boolean, reactive: boolean}>} actors
     * @returns {object[]} the actors this call took into the ledger (hidden before or not)
     */
    hide(actors) {
        const done = [];
        for (const a of actors) {
            if (this._saved.has(a) || !this._alive(a))
                continue;
            this._saved.set(a, { reactive: a.reactive, visible: a.visible });
            a.reactive = false;
            a.visible = false;
            done.push(a);
        }
        return done;
    }

    /**
     * Something showed or re-enabled a held actor while the screen is locked (an ease() fade-in,
     * the Shell's chrome visibility pass, a feature reacting to input): put it back. What it
     * wanted is kept for restore().
     *
     * @param {{visible: boolean, reactive: boolean}} actor
     * @returns {boolean} true if the actor is held and had to be hidden again
     */
    guard(actor) {
        const s = this._saved.get(actor);
        if (!s || !this._alive(actor))
            return false;
        let fixed = false;
        if (actor.visible) {
            s.visible = true;
            actor.visible = false;
            fixed = true;
        }
        if (actor.reactive) {
            s.reactive = true;
            actor.reactive = false;
            fixed = true;
        }
        return fixed;
    }

    /** Drop an actor that was destroyed meanwhile (nothing is restored for it). */
    forget(actor) {
        this._saved.delete(actor);
    }

    restore() {
        for (const [a, s] of this._saved) {
            if (!this._alive(a))
                continue;
            a.visible = s.visible;
            a.reactive = s.reactive;
        }
        this._saved.clear();
    }
}

/**
 * Guava's naming convention: every actor Guava adds to the stage or the panel is named
 * `guava-*` or carries a `guava-*` style class.
 *
 * @param {{name?: ?string, style_class?: ?string}} actor
 * @returns {boolean}
 */
export function isGuavaActor(actor) {
    return /(^|\s)guava-/.test(`${actor.name ?? ''} ${actor.style_class ?? ''}`);
}

/**
 * Actors the lock sweep hides: the Guava-named ones among `candidates` (or holding a Guava-named
 * child: the wrapper of a panel button) that no `lockScreen` feature owns. A safety net for what a feature's own surfaces do not cover (panel buttons made
 * in a sub-registry, popups): the registry's per-feature hiding stays the main path.
 *
 * @param {Iterable<object>} candidates top-level children of the stage chrome and the panel boxes
 * @param {Set<object>} exempt surfaces of lockScreen features
 * @returns {object[]}
 */
export function sweepTargets(candidates, exempt) {
    return [...candidates].filter(a => !exempt.has(a) &&
        (isGuavaActor(a) || (a.get_children?.() ?? []).some(isGuavaActor)));
}
