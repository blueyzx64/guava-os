// SPDX-License-Identifier: GPL-3.0-or-later
// DesktopModel: the one picture of the desktop every feature reads. Windows, the apps they
// belong to, focus (with most-recently-used order), workspaces and monitors.
//
// Pure JS (no gi imports). core/desktop.js (DesktopService) feeds it from Mutter; tests feed
// it plain objects. Each change is announced on the EventHub given to the constructor, so a
// feature never needs its own window tracker:
//
//   const desktop = ctx.desktop.acquire(cleanup);        // starts tracking if needed
//   desktop.model.windows({ workspace: 0 });             // WindowInfo[], most recent first
//   desktop.model.apps();                                 // running app ids, most recent first
//   ctx.events.on('app-focused', ({ appId }) => ..., cleanup);
//
// WindowInfo (frozen): {id, appId, title, type, workspace (-1 = on all), monitor, minimized,
//   fullscreen, maximized, skipTaskbar, above, parent}. `id` is Meta.Window.get_stable_sequence();
//   `parent` is the id of the window it is transient for (a dialog's owner), or null.

/** Field names a WindowInfo carries (besides id). */
export const WINDOW_FIELDS = Object.freeze(['appId', 'title', 'type', 'workspace', 'monitor',
    'minimized', 'fullscreen', 'maximized', 'skipTaskbar', 'above', 'parent']);

const DEFAULTS = Object.freeze({
    appId: null, title: '', type: 'normal', workspace: 0, monitor: 0,
    minimized: false, fullscreen: false, maximized: false, skipTaskbar: false,
    above: false, parent: null,
});

/**
 * Desktop ids to try for a window the Shell's tracker could not match to an installed app
 * (it then makes a window-backed app). Web apps are the usual case:
 *   - Chrome/Chromium PWAs: WM_CLASS 'crx_<id>' (Xwayland) or app id 'chrome-<id>-<profile>'
 *     (Wayland); the browser writes 'chrome-<id>-<profile>.desktop'. `prefix` lists the start
 *     of an id to look for when the profile is unknown.
 *   - GNOME Web (Epiphany) web apps: app id 'org.gnome.Epiphany.WebApp_<id>' (older:
 *     'epiphany-<id>'), desktop file 'org.gnome.Epiphany.WebApp_<id>.desktop' (from the
 *     DynamicLauncher portal; also the '-' spelling of older versions).
 *   - Anything else: the class itself, and lower-cased, as '<class>.desktop'.
 *
 * @param {?string} wmClass WM_CLASS or the Wayland app id
 * @returns {{ids: string[], prefix: ?string}}
 */
export function appIdCandidates(wmClass) {
    const cls = (wmClass ?? '').trim();
    if (!cls)
        return { ids: [], prefix: null };
    const ids = [];
    const add = id => {
        if (!ids.includes(id))
            ids.push(id);
    };
    let prefix = null;
    const crx = /^crx_([a-p]{32})$/i.exec(cls);
    const chrome = /^chrome-([a-p]{32})-(.+)$/i.exec(cls);
    const web = /^(?:org\.gnome\.Epiphany\.WebApp[_-]|epiphany-)(.+)$/i.exec(cls);
    if (crx) {
        add(`chrome-${crx[1].toLowerCase()}-Default.desktop`);
        prefix = `chrome-${crx[1].toLowerCase()}-`;
    } else if (chrome) {
        add(`chrome-${chrome[1].toLowerCase()}-${chrome[2]}.desktop`);
        prefix = `chrome-${chrome[1].toLowerCase()}-`;
    } else if (web) {
        add(`org.gnome.Epiphany.WebApp_${web[1]}.desktop`);
        add(`org.gnome.Epiphany.WebApp-${web[1]}.desktop`);
        add(`epiphany-${web[1]}.desktop`);
    }
    add(`${cls}.desktop`);
    add(`${cls.toLowerCase()}.desktop`);
    return { ids, prefix };
}

/** True for windows the user switches between (dock dots, app switcher, Stage Manager). */
export function isUserFacing(info) {
    return !!info && !info.skipTaskbar && (info.type === 'normal' || info.type === 'dialog');
}

export class DesktopModel {
    /**
     * @param {{emit: Function}|null} [events] an EventHub; null for a silent model
     */
    constructor(events = null) {
        this._events = events;
        this._windows = new Map();   // id -> WindowInfo
        this._mru = [];              // ids, most recently focused first
        this._focus = null;
        this._focusApp = null;
        this._workspaces = Object.freeze({ count: 1, active: 0 });
        this._monitors = Object.freeze([]);
        this._primary = 0;
    }

    _emit(name, payload) {
        this._events?.emit(name, payload);
    }

    // ---- windows --------------------------------------------------------------------------

    /**
     * Add a window or update its fields. Unknown fields are ignored; missing or undefined ones
     * keep their value (or the default for a new window).
     *
     * @param {number} id
     * @param {object} fields part of WindowInfo
     * @returns {string[]} the fields that changed ([] if nothing; all fields for a new window)
     */
    upsertWindow(id, fields = {}) {
        const old = this._windows.get(id);
        const next = { id };
        const changed = [];
        for (const f of WINDOW_FIELDS) {
            const v = fields[f] !== undefined ? fields[f] : old ? old[f] : DEFAULTS[f];
            next[f] = v;
            if (!old || old[f] !== v)
                changed.push(f);
        }
        if (old && !changed.length)
            return [];
        const info = Object.freeze(next);
        this._windows.set(id, info);
        if (!old) {
            this._mru.push(id); // a new window is least recent until it gets focus
            this._emit('window-added', { window: info });
        } else {
            this._emit('window-changed', { window: info, fields: changed });
            if (id === this._focus && changed.includes('appId'))
                this._syncFocusApp();
        }
        return changed;
    }

    /** @returns {boolean} true if the window was known */
    removeWindow(id) {
        const info = this._windows.get(id);
        if (!info)
            return false;
        this._windows.delete(id);
        const i = this._mru.indexOf(id);
        if (i >= 0)
            this._mru.splice(i, 1);
        this._emit('window-removed', { window: info });
        if (this._focus === id)
            this.setFocus(null);
        return true;
    }

    /** @returns {?WindowInfo} */
    window(id) {
        return this._windows.get(id) ?? null;
    }

    /**
     * Windows in most-recently-focused order.
     *
     * @param {{workspace?: number, monitor?: number, appId?: string, minimized?: boolean,
     *   userFacing?: boolean}} [filter] workspace matches windows on it and windows on all
     *   (-1); minimized: true returns only minimized windows, false only the others; userFacing
     *   (default true) leaves out skip-taskbar and non-normal/dialog windows
     * @returns {WindowInfo[]}
     */
    windows(filter = {}) {
        const { workspace, monitor, appId, minimized, userFacing = true } = filter;
        const out = [];
        for (const id of this._mru) {
            const w = this._windows.get(id);
            if (userFacing && !isUserFacing(w))
                continue;
            if (workspace !== undefined && w.workspace !== workspace && w.workspace !== -1)
                continue;
            if (monitor !== undefined && w.monitor !== monitor)
                continue;
            if (appId !== undefined && w.appId !== appId)
                continue;
            if (minimized !== undefined && !!w.minimized !== minimized)
                continue;
            out.push(w);
        }
        return out;
    }

    /**
     * Running apps (those with a user-facing window), most recently used first.
     *
     * @param {{workspace?: number}} [filter] same as windows()
     * @returns {string[]}
     */
    apps(filter = {}) {
        const seen = new Set();
        for (const w of this.windows(filter)) {
            if (w.appId)
                seen.add(w.appId);
        }
        return [...seen];
    }

    // ---- focus ----------------------------------------------------------------------------

    /**
     * @param {?number} id the focused window, null for none (desktop, overview)
     * @returns {boolean} true when the focus changed
     */
    setFocus(id) {
        if (id !== null && !this._windows.has(id))
            id = null;
        if (id === this._focus)
            return false;
        this._focus = id;
        if (id !== null) {
            const i = this._mru.indexOf(id);
            if (i > 0) {
                this._mru.splice(i, 1);
                this._mru.unshift(id);
            }
        }
        this._emit('window-focused', { window: this.focusedWindow });
        this._syncFocusApp();
        return true;
    }

    _syncFocusApp() {
        const appId = this.focusedWindow?.appId ?? null;
        if (appId === this._focusApp)
            return;
        this._focusApp = appId;
        this._emit('app-focused', { appId });
    }

    /** @returns {?WindowInfo} */
    get focusedWindow() {
        return this._focus === null ? null : this._windows.get(this._focus) ?? null;
    }

    /** @returns {?string} */
    get focusedApp() {
        return this._focusApp;
    }

    // ---- workspaces and monitors ------------------------------------------------------------

    /** @returns {boolean} true when it changed */
    setWorkspaces({ count, active }) {
        if (count === this._workspaces.count && active === this._workspaces.active)
            return false;
        this._workspaces = Object.freeze({ count, active });
        this._emit('workspaces-changed', { count, active });
        return true;
    }

    /** @returns {{count: number, active: number}} */
    get workspaces() {
        return this._workspaces;
    }

    /**
     * @param {{x: number, y: number, width: number, height: number}[]} monitors index order
     * @param {number} primary
     * @returns {boolean} true when they changed
     */
    setMonitors(monitors, primary) {
        const next = monitors.map((m, index) => Object.freeze({
            index, x: m.x, y: m.y, width: m.width, height: m.height,
        }));
        const same = primary === this._primary && next.length === this._monitors.length &&
            next.every((m, i) => ['x', 'y', 'width', 'height'].every(k => m[k] === this._monitors[i][k]));
        if (same)
            return false;
        this._monitors = Object.freeze(next);
        this._primary = primary;
        this._emit('monitors-changed', { monitors: this._monitors, primary });
        return true;
    }

    /** @returns {{index, x, y, width, height}[]} */
    get monitors() {
        return this._monitors;
    }

    get primaryMonitor() {
        return this._primary;
    }

    /** Forget everything (tracking stopped). Emits nothing. */
    reset() {
        this._windows.clear();
        this._mru = [];
        this._focus = null;
        this._focusApp = null;
        this._workspaces = Object.freeze({ count: 1, active: 0 });
        this._monitors = Object.freeze([]);
        this._primary = 0;
    }
}
