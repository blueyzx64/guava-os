// SPDX-License-Identifier: GPL-3.0-or-later
// DesktopService: the Shell adapter that keeps core/desktopModel.js in step with Mutter.
// One tracker for the whole extension; features read the model and listen on ctx.events.
//
//   const desktop = ctx.desktop.acquire(cleanup);   // tracking starts with the first user
//   desktop.model.focusedApp;                       // pure model, see desktopModel.js
//   desktop.metaWindow(info.id);                    // the Meta.Window behind a WindowInfo
//
// Tracking stops (every signal disconnected, the model emptied) when the last user's cleanup
// is disposed, and stop() ends it for good on extension disable. No per-frame signals are
// used: position-changed and size-changed are left alone; monitors come from the display's
// window-entered-monitor.
//
// Shell API: global.display (window-created, notify::focus-window, window-entered-monitor),
// global.workspace_manager, Shell.WindowTracker, Shell.AppSystem (web-app ids),
// Main.layoutManager monitors-changed.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from '../lib/disposables.js';
import { isMaximized } from '../lib/compat.js';
import { DesktopModel, appIdCandidates } from './desktopModel.js';
import { WindowState, skipsTaskbar } from './windowState.js';

const WINDOW_TYPES = new Map([
    [Meta.WindowType.NORMAL, 'normal'],
    [Meta.WindowType.DIALOG, 'dialog'],
    [Meta.WindowType.MODAL_DIALOG, 'dialog'],
]);

// Per-window property -> the fields it changes
const WINDOW_SIGNALS = [
    ['notify::minimized', ['minimized']],
    ['notify::fullscreen', ['fullscreen']],
    ['notify::maximized-horizontally', ['maximized']],
    ['notify::maximized-vertically', ['maximized']],
    ['workspace-changed', ['workspace']],
    ['notify::on-all-workspaces', ['workspace']],
    ['notify::title', ['title']],
    ['notify::wm-class', ['appId']],
    ['notify::skip-taskbar', ['skipTaskbar']],
    ['notify::above', ['above']],
    ['notify::transient-for', ['parent']],
];

export class DesktopService {
    /** @param {import('./events.js').EventHub} events */
    constructor(events) {
        this._events = events;
        this._model = new DesktopModel(events);
        this._refs = 0;
        this._cleanup = null;
        this._windows = new Map(); // id -> {win, cleanup}
        this._tracker = null;
    }

    /** @returns {DesktopModel} */
    get model() {
        return this._model;
    }

    get tracking() {
        return this._cleanup !== null;
    }

    /**
     * Use the service; tracking starts with the first user.
     *
     * @param {{add: Function}} owner a CleanupRegistry; the use ends when it is disposed
     * @returns {DesktopService}
     */
    acquire(owner) {
        this._refs++;
        if (this._refs === 1)
            this._start();
        let released = false;
        owner.add(() => {
            if (released)
                return;
            released = true;
            this._refs--;
            if (this._refs === 0)
                this._stopTracking();
        });
        return this;
    }

    /** @returns {?Meta.Window} the live window behind a WindowInfo id */
    metaWindow(id) {
        return this._windows.get(id)?.win ?? null;
    }

    /** End tracking for good (extension disable), whatever the use count. */
    stop() {
        this._refs = 0;
        this._stopTracking();
    }

    // ---- tracking -----------------------------------------------------------------------------

    _start() {
        const cleanup = new CleanupRegistry();
        this._cleanup = cleanup;
        this._tracker = Shell.WindowTracker.get_default();

        cleanup.connect(global.display, 'window-created', (_d, win) => this._track(win));
        cleanup.connect(global.display, 'notify::focus-window', () => this._syncFocus());
        cleanup.connect(global.display, 'window-entered-monitor', (_d, _index, win) =>
            this._sync(win, ['monitor']));
        // The tracker can change its mind about a window's app (a late WM_CLASS or startup id)
        cleanup.connect(this._tracker, 'tracked-windows-changed', () => {
            for (const { win } of this._windows.values())
                this._sync(win, ['appId']);
        });
        // A helper's window is flagged after it was created
        WindowState.watch(cleanup, (win, flag) => {
            if (flag === 'guavaHelper')
                this._sync(win, ['skipTaskbar']);
        });
        const wm = global.workspace_manager;
        cleanup.connect(wm, 'notify::n-workspaces', () => this._syncWorkspaces());
        cleanup.connect(wm, 'active-workspace-changed', () => this._syncWorkspaces());
        cleanup.connect(Main.layoutManager, 'monitors-changed', () => this._syncMonitors());

        this._syncMonitors();
        this._syncWorkspaces();
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        this._syncFocus();
    }

    _stopTracking() {
        if (!this._cleanup)
            return;
        for (const { cleanup } of this._windows.values())
            cleanup.dispose();
        this._windows.clear();
        this._cleanup.dispose();
        this._cleanup = null;
        this._tracker = null;
        this._model.reset();
    }

    _track(win) {
        if (!win || !WINDOW_TYPES.has(win.get_window_type()))
            return;
        const id = win.get_stable_sequence();
        if (this._windows.has(id))
            return;
        const cleanup = new CleanupRegistry();
        this._windows.set(id, { win, cleanup });
        for (const [signal, fields] of WINDOW_SIGNALS)
            cleanup.connect(win, signal, () => this._sync(win, fields));
        cleanup.connect(win, 'unmanaged', () => this._untrack(id));
        this._model.upsertWindow(id, this._read(win, null));
    }

    _untrack(id) {
        const entry = this._windows.get(id);
        if (!entry)
            return;
        this._windows.delete(id);
        entry.cleanup.dispose();
        this._model.removeWindow(id);
    }

    // Read the fields of one window (all of them when `fields` is null).
    _read(win, fields) {
        const out = {};
        const want = f => !fields || fields.includes(f);
        if (want('appId'))
            out.appId = this._appIdOf(win);
        if (want('title'))
            out.title = win.get_title() ?? '';
        if (want('type'))
            out.type = WINDOW_TYPES.get(win.get_window_type()) ?? 'other';
        if (want('workspace'))
            out.workspace = win.is_on_all_workspaces() ? -1 : win.get_workspace()?.index() ?? 0;
        if (want('monitor'))
            out.monitor = win.get_monitor();
        if (want('minimized'))
            out.minimized = !!win.minimized;
        if (want('fullscreen'))
            out.fullscreen = !!win.is_fullscreen();
        if (want('maximized'))
            out.maximized = isMaximized(win);
        if (want('skipTaskbar'))
            out.skipTaskbar = skipsTaskbar(win);
        if (want('above'))
            out.above = !!win.is_above();
        if (want('parent'))
            out.parent = win.get_transient_for()?.get_stable_sequence() ?? null;
        return out;
    }

    // The tracker's app, or for a window it could only give a window-backed app (web apps
    // whose WM_CLASS / app id differs from their .desktop id), the installed app the
    // candidates name. Shell.AppSystem lookups are in-memory.
    _appIdOf(win) {
        const app = this._tracker?.get_window_app(win) ?? null;
        if (!app || !app.is_window_backed())
            return app?.get_id() ?? null;
        const appSystem = Shell.AppSystem.get_default();
        for (const cls of [win.get_sandboxed_app_id?.(), win.get_gtk_application_id?.(), win.get_wm_class()]) {
            const { ids, prefix } = appIdCandidates(cls);
            for (const id of ids) {
                if (appSystem.lookup_app(id))
                    return id;
            }
            const byClass = cls ? appSystem.lookup_startup_wmclass(cls) ?? appSystem.lookup_desktop_wmclass(cls) : null;
            if (byClass)
                return byClass.get_id();
            const byPrefix = prefix && appSystem.get_installed().find(info => info.get_id()?.startsWith(prefix));
            if (byPrefix)
                return byPrefix.get_id();
        }
        return app.get_id();
    }

    _sync(win, fields) {
        const id = win?.get_stable_sequence?.();
        if (id === undefined || !this._windows.has(id))
            return;
        this._model.upsertWindow(id, this._read(win, fields));
    }

    _syncFocus() {
        const win = global.display.focus_window;
        const id = win ? win.get_stable_sequence() : null;
        this._model.setFocus(id !== null && this._windows.has(id) ? id : null);
    }

    _syncWorkspaces() {
        const wm = global.workspace_manager;
        this._model.setWorkspaces({ count: wm.get_n_workspaces(), active: wm.get_active_workspace_index() });
    }

    _syncMonitors() {
        const lm = Main.layoutManager;
        this._model.setMonitors(lm.monitors ?? [], lm.primaryIndex ?? 0);
    }
}
