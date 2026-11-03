// SPDX-License-Identifier: GPL-3.0-or-later
// Pure side of Hide / Hide Others (macOS ⌘H, ⌥⌘H). Wayland has no "hidden app", so Guava
// minimizes the app's windows without the minimize effect and remembers which windows it hid,
// per app, so activating the app brings back exactly those. No gi imports
// (tests/windowsModel.test.js).
//
// Windows are WindowInfo values of core/desktopModel.js ({id, appId, type, minimized, ...}).

/** Hide requests ('app-hide-requested' payload `mode`). */
export const HIDE_MODES = Object.freeze(['hide', 'others', 'all']);

const hideable = w => !!w && !w.minimized && !w.skipTaskbar && w.type === 'normal' && !!w.appId;

/**
 * Which windows a request hides: the app's visible windows ('hide'), or those of every other
 * app ('others'). Windows already hidden by Guava are minimized, so they are never picked twice.
 *
 * @param {string} mode 'hide' | 'others'
 * @param {?string} appId the app the request is about (the focused one for 'others')
 * @param {object[]} windows WindowInfo[] of every workspace, most recently used first
 * @returns {Map<string, number[]>} appId -> window ids to hide, in MRU order
 */
export function planHide(mode, appId, windows) {
    const out = new Map();
    if (!appId && mode === 'hide')
        return out;
    for (const w of windows ?? []) {
        if (!hideable(w))
            continue;
        const pick = mode === 'hide' ? w.appId === appId : mode === 'others' && w.appId !== appId;
        if (!pick)
            continue;
        if (!out.has(w.appId))
            out.set(w.appId, []);
        out.get(w.appId).push(w.id);
    }
    return out;
}

/** The hidden apps and the windows Guava hid for each (MRU order at hide time). */
export class HiddenApps {
    constructor() {
        this._apps = new Map();   // appId -> number[]
        this._owner = new Map();  // window id -> appId
    }

    /** Record windows hidden for an app (added to any already hidden). */
    hide(appId, ids) {
        if (!ids.length)
            return;
        const list = this._apps.get(appId) ?? [];
        for (const id of ids) {
            if (this._owner.has(id))
                continue;
            list.push(id);
            this._owner.set(id, appId);
        }
        this._apps.set(appId, list);
    }

    has(appId) {
        return this._apps.has(appId);
    }

    /** @returns {?string} the hidden app a window belongs to */
    appOf(id) {
        return this._owner.get(id) ?? null;
    }

    /** Forget an app and return the windows to bring back (MRU order). */
    show(appId) {
        const ids = this._apps.get(appId) ?? [];
        this._apps.delete(appId);
        ids.forEach(id => this._owner.delete(id));
        return ids;
    }

    /** A hidden window went away (closed): forget it, and the app when it was the last. */
    forgetWindow(id) {
        const appId = this._owner.get(id);
        if (!appId)
            return null;
        this._owner.delete(id);
        const list = this._apps.get(appId).filter(x => x !== id);
        if (list.length)
            this._apps.set(appId, list);
        else
            this._apps.delete(appId);
        return list.length ? null : appId;
    }

    apps() {
        return [...this._apps.keys()];
    }

    /** Plain copy for keeping across a disable (screen lock) and back. */
    toJSON() {
        return [...this._apps].map(([appId, ids]) => [appId, [...ids]]);
    }

    /**
     * Restore from toJSON(), keeping only windows `alive(id)` says are still hidden.
     *
     * @param {[string, number[]][]} data
     * @param {(id: number) => boolean} alive
     */
    static from(data, alive) {
        const h = new HiddenApps();
        for (const [appId, ids] of data ?? [])
            h.hide(appId, ids.filter(alive));
        return h;
    }
}
