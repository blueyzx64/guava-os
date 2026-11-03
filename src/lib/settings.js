// SPDX-License-Identifier: GPL-3.0-or-later
// Typed access to Guava's GSettings and change-scoped dispatch.
//
// No gi:// imports: it only calls methods on the Gio.Settings object it is given,
// so it also runs under plain `gjs -m` with a fake settings object.

export class GuavaSettings {
    /**
     * @param {Gio.Settings} gsettings the extension's settings (this.getSettings())
     */
    constructor(gsettings) {
        this._gs = gsettings;
        this._watchers = new Map();   // key ('*' = all) -> Set<fn>
        this._token = 0;
        this._handlerId = 0;
    }

    /** The wrapped Gio.Settings, for code that still needs it. */
    get raw() {
        return this._gs;
    }

    has(key) {
        return this._gs.settings_schema?.has_key(key) ?? true;
    }

    bool(key) { return this._gs.get_boolean(key); }
    int(key) { return this._gs.get_int(key); }
    double(key) { return this._gs.get_double(key); }
    string(key) { return this._gs.get_string(key); }
    strv(key) { return this._gs.get_strv(key); }
    enum(key) { return this._gs.get_enum(key); }

    setBool(key, v) { return this._gs.set_boolean(key, v); }
    setInt(key, v) { return this._gs.set_int(key, v); }
    setDouble(key, v) { return this._gs.set_double(key, v); }
    setString(key, v) { return this._gs.set_string(key, v); }
    setStrv(key, v) { return this._gs.set_strv(key, v); }

    /**
     * Call fn(key) when one of `keys` changes. Use '*' for every key. One 'changed'
     * connection serves all watchers, and only the watchers of that key run.
     *
     * @param {string|string[]} keys
     * @param {Function} fn
     * @returns {Function} call it to stop watching
     */
    watch(keys, fn) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) {
            if (!this._watchers.has(key))
                this._watchers.set(key, new Set());
            this._watchers.get(key).add(fn);
        }
        return () => {
            for (const key of list)
                this._watchers.get(key)?.delete(fn);
        };
    }

    _dispatch(key) {
        const targets = new Set([
            ...(this._watchers.get(key) ?? []),
            ...(this._watchers.get('*') ?? []),
        ]);
        for (const fn of targets) {
            try {
                fn(key);
            } catch (e) {
                console.error(`[Guava] settings watcher for '${key}' failed:`, e);
            }
        }
    }

    /**
     * Start dispatching 'changed' to watchers. Undone by the registry on dispose().
     *
     * @param {CleanupRegistry} registry
     */
    attach(registry) {
        if (this._handlerId)
            return;
        this._handlerId = this._gs.connect('changed', (_s, key) => this._dispatch(key));
        registry.add(() => {
            this._gs.disconnect(this._handlerId);
            this._handlerId = 0;
            this._watchers.clear();
        });
    }
}
