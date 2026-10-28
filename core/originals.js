// SPDX-License-Identifier: GPL-3.0-or-later
// Saved originals: the user's own value of every GNOME setting Guava takes over.
//
// Guava sometimes has to write a setting that belongs to GNOME (the window button-layout today;
// later edge-tiling, dynamic-workspaces, hot corners, dock and keybinding keys). Each such key
// is owned through a SettingOwner, which first stores the user's value in Guava's own key
// `saved-originals` and only then writes Guava's value. Giving the key back writes the stored
// value and forgets it.
//
// Crash safety: the store lives in GSettings, so a value saved by a session that crashed, or
// that was killed before disable(), is still there. extension.js calls restoreStale() once,
// before any feature runs; every stored value is written back. Nothing depends on disable().
//
//   const owner = new SettingOwner(ctx.originals, wmSettings, 'button-layout', {
//       type: 's', transform: original => stripButtons(original),
//       onOriginalChanged: () => ...,   // the user changed the key while Guava held it
//   });
//   owner.sync(true);    // take it (saves the original once)
//   owner.reapply();     // Guava's inputs changed: write transform(original) again
//   owner.release();     // the user's value back
//
// A string list shared with the Shell and the user (org.gnome.shell enabled-extensions) is not
// owned whole: a ListMembersOwner takes only some members out (Dash to Dock while Guava's dock
// runs) and puts back just those, so every other change made meanwhile is kept. Its store entry
// has mode 'members' and holds the members that were present; restoreStale() adds them back.
//
// Damage control (each case has a test in tests/originals.test.js):
//   - the owner also keeps the original in memory: if the store is wiped while Guava owns the key
//     (gsettings reset, dconf reset), release() still gives the user's value back and the
//     entry is written again at once;
//   - each entry stores the value Guava forced; restoreStale() writes the original back only
//     while the live value still is that one, so a change the user made after a crash stands;
//   - an entry records whether the user had set the key at all: a default goes back with
//     reset(), not as an explicit value;
//   - two owners of one key share one entry: only the last release gives the value back;
//   - a store that does not parse is kept in `saved-originals-backup`, never silently dropped.
//
// No gi imports: settings objects are passed in (Gio.Settings in the Shell, fakes in tests).

/**
 * Guava key holding the store: JSON {"<schema>::<key>": {"type": "s", "value": ..., "forced": ...,
 * "user": true}}. `forced` is what Guava wrote, `user` false when the key was never set by the
 * user; both are absent in entries of older sessions (then restored unconditionally).
 */
export const STORE_KEY = 'saved-originals';
/** Guava key keeping the text of a store that could not be parsed. */
export const STORE_BACKUP_KEY = 'saved-originals-backup';

const GETTERS = {
    b: (gs, k) => gs.get_boolean(k),
    i: (gs, k) => gs.get_int(k),
    u: (gs, k) => gs.get_uint(k),
    d: (gs, k) => gs.get_double(k),
    s: (gs, k) => gs.get_string(k),
    as: (gs, k) => gs.get_strv(k),
};

const SETTERS = {
    b: (gs, k, v) => gs.set_boolean(k, !!v),
    i: (gs, k, v) => gs.set_int(k, v),
    u: (gs, k, v) => gs.set_uint(k, v),
    d: (gs, k, v) => gs.set_double(k, v),
    s: (gs, k, v) => gs.set_string(k, String(v)),
    as: (gs, k, v) => gs.set_strv(k, Array.isArray(v) ? v : []),
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Store id of one key of one schema. */
export function originalId(schemaId, key) {
    return `${schemaId}::${key}`;
}

/** Parse a store id back: {schemaId, key}, or null. */
export function parseOriginalId(id) {
    const i = id.lastIndexOf('::');
    return i > 0 ? { schemaId: id.slice(0, i), key: id.slice(i + 2) } : null;
}

/**
 * The store. Reads and writes the whole JSON text through the Guava settings object, so two
 * owners of different keys never lose each other's entry.
 */
export class OriginalsStore {
    /** @param {{get_string: Function, set_string: Function}} guavaSettings */
    constructor(guavaSettings) {
        this._gs = guavaSettings;
        this._holders = new Map();   // id -> number of owners holding it
        /**
         * While true, owners leave their keys and entries as they are when they release (the
         * Shell disables every extension on a screen lock and enables them at unlock: nothing
         * should flip meanwhile). The next take finds the entry and goes on from it.
         */
        this.keepStored = false;
    }

    _read() {
        const raw = this._gs.get_string(STORE_KEY);
        try {
            const data = JSON.parse(raw || '{}');
            if (data && typeof data === 'object' && !Array.isArray(data))
                return data;
            throw new Error('not an object');
        } catch (e) {
            // Keep what was there before the next write replaces it
            console.error('[Guava] saved originals unreadable, kept in the backup key:', e);
            try {
                this._gs.set_string(STORE_BACKUP_KEY, raw);
            } catch (e2) {
                console.error('[Guava] could not back up the saved originals:', e2);
            }
            this._gs.set_string(STORE_KEY, '');
            return {};
        }
    }

    _write(data) {
        const text = Object.keys(data).length ? JSON.stringify(data) : '';
        if (this._gs.get_string(STORE_KEY) !== text)
            this._gs.set_string(STORE_KEY, text);
    }

    /** @returns {string[]} stored ids */
    ids() {
        return Object.keys(this._read());
    }

    /** @returns {?{type: string, value: *, forced?: *, user?: boolean, mode?: string}} */
    get(id) {
        return this._read()[id] ?? null;
    }

    /**
     * Save a value, replacing any stored one.
     *
     * @param {string} id
     * @param {string} type GVariant type
     * @param {*} value
     * @param {{mode?: string, forced?: *, user?: boolean}} [extra] mode 'members' for a
     *   ListMembersOwner entry (value: the members to add back); forced: the value Guava
     *   wrote; user: false when the user had never set the key
     */
    set(id, type, value, extra = {}) {
        if (!GETTERS[type])
            throw new Error(`originals: unsupported type '${type}'`);
        const data = this._read();
        const entry = { type, value };
        if (extra.mode)
            entry.mode = extra.mode;
        if (extra.forced !== undefined)
            entry.forced = extra.forced;
        if (extra.user === false)
            entry.user = false;
        if (same(data[id], entry))
            return;
        data[id] = entry;
        this._write(data);
    }

    forget(id) {
        const data = this._read();
        if (!(id in data))
            return;
        delete data[id];
        this._write(data);
    }

    /** An owner takes `id`. @returns {number} owners now holding it */
    hold(id) {
        const n = (this._holders.get(id) ?? 0) + 1;
        this._holders.set(id, n);
        return n;
    }

    /** An owner lets go of `id`. @returns {number} owners still holding it */
    unhold(id) {
        const n = Math.max(0, (this._holders.get(id) ?? 0) - 1);
        if (n)
            this._holders.set(id, n);
        else
            this._holders.delete(id);
        return n;
    }

    /** True while an owner holds `id`. */
    isHeld(id) {
        return this._holders.has(id);
    }

    /**
     * Call `fn` whenever the stored text changes (also from outside: a settings reset).
     *
     * @returns {() => void} stops watching
     */
    watch(fn) {
        const handler = this._gs.connect(`changed::${STORE_KEY}`, fn);
        return () => this._gs.disconnect(handler);
    }
}

/** `list` with every one of `members` it lacks appended (order of `list` kept). */
export function withMembers(list, members) {
    const out = [...list];
    for (const m of members ?? []) {
        if (!out.includes(m))
            out.push(m);
    }
    return out;
}

/** True when the user had set `key` (a default is not the user's value). */
function userSet(gs, key) {
    return typeof gs.get_user_value === 'function' ? gs.get_user_value(key) !== null : true;
}

/** Write `value` back; a key the user never set returns to its default. */
function putBack(gs, type, key, value, user) {
    if (user === false && typeof gs.reset === 'function')
        gs.reset(key);
    else if (!same(GETTERS[type](gs, key), value))
        SETTERS[type](gs, key, value);
}

/**
 * Write back the stored originals and empty the store. Used at startup: anything still stored
 * was not given back by the last session.
 *
 * A whole value is written back only while the live value still is the one Guava forced: if the
 * user changed the key after the crash, their choice stands (entries of older sessions without
 * a forced value are written back as before).
 *
 * @param {OriginalsStore} store
 * @param {(schemaId: string) => ?object} openSettings a Gio.Settings for a schema, or null
 *   when the schema is not installed (the entry is then dropped)
 * @param {{members?: 'restore'|'leave'|'only'}} [opts] what to do with the 'members' entries
 *   (a ListMembersOwner's): 'restore' (default) adds them back, 'leave' keeps them in the
 *   store for the owner that will take them again (extension.js, first start), 'only' handles
 *   just those entries no owner holds, nothing else
 * @returns {string[]} ids written back
 */
export function restoreStale(store, openSettings, { members = 'restore' } = {}) {
    const restored = [];
    for (const id of store.ids()) {
        const entry = store.get(id);
        const isMembers = entry?.mode === 'members';
        if (isMembers ? members === 'leave' : members === 'only')
            continue;
        if (isMembers && store.isHeld(id))
            continue;
        const parsed = parseOriginalId(id);
        try {
            const gs = parsed ? openSettings(parsed.schemaId) : null;
            if (gs && entry && SETTERS[entry.type]) {
                const live = GETTERS[entry.type](gs, parsed.key);
                if (isMembers) {
                    const next = withMembers(live, entry.value);
                    if (!same(live, next))
                        SETTERS[entry.type](gs, parsed.key, next);
                    restored.push(id);
                } else if (entry.forced === undefined || same(live, entry.forced)) {
                    putBack(gs, entry.type, parsed.key, entry.value, entry.user);
                    restored.push(id);
                }
            }
        } catch (e) {
            console.error(`[Guava] could not restore ${id}:`, e);
        }
        store.forget(id);
    }
    return restored;
}

export class SettingOwner {
    /**
     * @param {OriginalsStore} store
     * @param {object} settings the Gio.Settings that has `key` (it needs schema_id)
     * @param {string} key
     * @param {object} opts
     * @param {string} opts.type GVariant type: b i u d s as
     * @param {(original: *) => *} [opts.transform] Guava's value for a given original
     *   (default: a fixed opts.value)
     * @param {*} [opts.value] the value Guava sets when there is no transform
     * @param {() => void} [opts.onOriginalChanged] the user changed the key while Guava owned it
     * @param {boolean} [opts.yieldToUser] on such a change, let the user's value stand and stop
     *   owning (Auto Light/Dark: picking a style yourself turns Auto off), instead of storing it
     *   as the new original and writing Guava's value again
     */
    constructor(store, settings, key, { type, transform, value, onOriginalChanged = () => {}, yieldToUser = false }) {
        if (!GETTERS[type])
            throw new Error(`SettingOwner: unsupported type '${type}'`);
        this._store = store;
        this._gs = settings;
        this._key = key;
        this._type = type;
        this._transform = transform ?? (() => value);
        this._onOriginalChanged = onOriginalChanged;
        this._yield = yieldToUser;
        this._id = originalId(settings.schema_id, key);
        this._owning = false;
        this._forced = undefined;
        this._orig = null;          // {value, user}: the user's value, also kept here
        this._changedId = 0;
        this._unwatch = null;
    }

    get owning() {
        return this._owning;
    }

    _live() {
        return GETTERS[this._type](this._gs, this._key);
    }

    _set(v) {
        if (!same(this._live(), v))
            SETTERS[this._type](this._gs, this._key, v);
    }

    /** The user's own value: the one saved while Guava owns the key, else the live one. */
    get original() {
        return this._owning ? this._orig.value : this._live();
    }

    _disconnect() {
        if (this._changedId) {
            this._gs.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._unwatch?.();
        this._unwatch = null;
    }

    // Save the original with the value Guava forces for it, then write that value
    _persist() {
        this._forced = this._transform(this._orig.value);
        this._store.set(this._id, this._type, this._orig.value, { forced: this._forced, user: this._orig.user });
        this._set(this._forced);
    }

    // The store was emptied or damaged from outside while Guava owns the key: write it again
    _restoreEntry() {
        if (this._owning && !this._store.get(this._id))
            this._store.set(this._id, this._type, this._orig.value, { forced: this._forced, user: this._orig.user });
    }

    /** Take (true) or give back (false) the key. */
    sync(want) {
        if (want && !this._owning)
            this._take();
        else if (!want && this._owning)
            this.release();
    }

    _take() {
        // An entry already stored (another owner instance of a crashed session, or another
        // owner of this key now) is the user's real value: never overwrite it with Guava's.
        const saved = this._store.get(this._id);
        this._orig = saved ? { value: saved.value, user: saved.user !== false }
            : { value: this._live(), user: userSet(this._gs, this._key) };
        this._owning = true;
        this._store.hold(this._id);
        this._persist();
        this._changedId = this._gs.connect(`changed::${this._key}`, () => this._onChanged());
        this._unwatch = this._store.watch(() => this._restoreEntry());
    }

    /** The transform's inputs changed (e.g. a Guava setting): write Guava's value again. */
    reapply() {
        if (this._owning)
            this._persist();
    }

    // Someone else (Tweaks, gsettings) wrote the key while Guava owns it: that is the user's
    // new choice. Store it as the original and keep Guava's value applied, or (yieldToUser)
    // keep theirs and let go.
    _onChanged() {
        const live = this._live();
        if (!this._owning || same(live, this._forced))
            return;
        if (this._yield) {
            this._disconnect();
            this._owning = false;
            this._forced = undefined;
            if (!this._store.unhold(this._id))
                this._store.forget(this._id);
            this._onOriginalChanged();
            return;
        }
        this._orig = { value: live, user: userSet(this._gs, this._key) };
        this._persist();
        this._onOriginalChanged();
    }

    /**
     * Put the user's value back exactly and forget it. Safe to call when not owning. With two
     * owners of one key, only the last one to let go gives the value back.
     */
    release() {
        this._disconnect();
        if (!this._owning)
            return;
        this._owning = false;
        this._forced = undefined;
        if (this._store.unhold(this._id) || this._store.keepStored)
            return;
        putBack(this._gs, this._type, this._key, this._orig.value, this._orig.user);
        this._store.forget(this._id);
    }
}

/**
 * Keeps some members out of a string-list key while Guava runs, and puts back only those.
 *
 *   const owner = new ListMembersOwner(ctx.originals, shellSettings, 'enabled-extensions',
 *       ['dash-to-dock@micxgx.gmail.com']);
 *   owner.sync(true);    // the members present are saved, then removed from the list
 *   owner.release();     // the saved members are added back to the list as it is now
 *
 * A member the user adds back while Guava holds the key is saved too and taken out again: it
 * returns with the rest on release. Entries other than the members are never touched.
 *
 * Taking the key while the store already holds members (a session that ended without
 * disable(), as every logout does) adopts them: the list is not touched and the entry stays.
 */
export class ListMembersOwner {
    /**
     * @param {OriginalsStore} store
     * @param {object} settings the Gio.Settings that has `key` (it needs schema_id)
     * @param {string} key a string-list ('as') key
     * @param {string[]} members
     * @param {{defer?: (fn: Function) => void}} [opts] defer: runs the strip that follows a
     *   change of the key (default: at once). A caller whose list is also read by an asynchronous
     *   consumer (the Shell enabling extensions) schedules it for after that consumer is done.
     */
    constructor(store, settings, key, members, { defer = fn => fn() } = {}) {
        this._store = store;
        this._gs = settings;
        this._key = key;
        this._members = [...members];
        this._defer = defer;
        this._stripQueued = false;
        this._id = originalId(settings.schema_id, key);
        this._owning = false;
        this._mem = [];             // the members taken out, also kept here
        this._changedId = 0;
        this._unwatch = null;
    }

    get owning() {
        return this._owning;
    }

    /** @returns {string[]} the members Guava took out and will add back */
    get held() {
        return withMembers(this._store.get(this._id)?.value ?? [], this._mem);
    }

    _live() {
        return this._gs.get_strv(this._key);
    }

    /** Take (true) or give back (false). */
    sync(want) {
        if (want && !this._owning)
            this._take();
        else if (!want && this._owning)
            this.release();
    }

    _take() {
        this._owning = true;
        this._mem = this.held;
        this._store.hold(this._id);
        this._strip();
        this._changedId = this._gs.connect(`changed::${this._key}`, () => this._stripLater());
        this._unwatch = this._store.watch(() => this._saveHeld());
    }

    _saveHeld() {
        if (this._owning && this._mem.length && !this._store.get(this._id))
            this._store.set(this._id, 'as', this._mem, { mode: 'members' });
    }

    // A change of the key: take the members out again once `defer` allows (one strip per burst)
    _stripLater() {
        if (this._stripQueued)
            return;
        this._stripQueued = true;
        this._defer(() => {
            this._stripQueued = false;
            if (this._owning)
                this._strip();
        });
    }

    // Save the members now in the list (added to any already stored), then take them out.
    // Runs on take and whenever the key changes; the write re-enters it with nothing to do.
    _strip() {
        const live = this._live();
        const present = this._members.filter(m => live.includes(m));
        if (!present.length)
            return;
        this._mem = withMembers(this.held, present);
        this._store.set(this._id, 'as', this._mem, { mode: 'members' });
        this._gs.set_strv(this._key, live.filter(m => !this._members.includes(m)));
    }

    /**
     * Add the saved members back to the list and forget them.
     *
     * @param {{keepStored?: boolean}} [opts] keepStored: leave the list and the store as they
     *   are (Guava is only being restarted, e.g. by the Shell re-basing its extension order); the
     *   next take, or restoreStale() at the next start, finds the entry
     */
    release({ keepStored = false } = {}) {
        if (this._changedId) {
            this._gs.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._unwatch?.();
        this._unwatch = null;
        if (!this._owning)
            return;
        this._owning = false;
        const remaining = this._store.unhold(this._id);
        if (keepStored || remaining || this._store.keepStored)
            return;
        const held = this.held;
        this._mem = [];
        const live = this._live();
        const next = withMembers(live, held);
        if (!same(live, next))
            this._gs.set_strv(this._key, next);
        this._store.forget(this._id);
    }
}
