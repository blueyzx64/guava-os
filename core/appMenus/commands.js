// SPDX-License-Identifier: GPL-3.0-or-later
// The generic app-menu commands (the 'generic' provider): what the Shell can do for any app
// or window, whatever toolkit it uses.
//
//   const commands = new GenericCommands({ events, desktop, layout });
//   commands.run('quit', target);
//   commands.stop();       // forgets the windows its Hide fallback minimized
//
// Hide, Hide Others and Show All belong to the window manager: they are asked for with the
// 'app-hide-requested' event, and the owner of hidden windows (the windows feature) answers.
// Fill, Center and Move & Resize go the same way through 'window-tile-requested' (the tiling
// engine, actions of core/tileActions.js). When nothing listens, a plain fallback runs here:
// Hide minimizes the app's windows without asking Stage Manager (the window is minimized, not
// staged), Show All restores exactly the windows that fallback minimized, and a zone puts the
// window on its part of Guava's work area (Center and Return to Previous Size need the engine).
// Move to Workspace > New Workspace appends a workspace and follows the window there.
//
// Shell API: Shell.AppSystem, Shell.App (request_quit, open_new_window, activate_window),
// Meta.Window, global.workspace_manager, Main.activateWindow.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DesktopAppInfo, isMaximized, maximizeWindow, unmaximizeWindow } from '../../lib/compat.js';
import { WindowState } from '../windowState.js';
import { isUserFacing } from '../desktopModel.js';
import { ZONES } from '../tileActions.js';

const now = () => global.get_current_time();

export class GenericCommands {
    /**
     * @param {{events, desktop, layout}} core the core services (ctx.events, ctx.desktop,
     *   ctx.layout); desktop and layout must be acquired by the caller
     */
    constructor({ events, desktop, layout }) {
        this._events = events;
        this._desktop = desktop;
        this._layout = layout;
        this._hidden = new Set(); // Meta.Window minimized by the Hide fallback
    }

    stop() {
        this._hidden.clear();
    }

    /** True for a window this object's Hide fallback minimized (and has not shown again). */
    isHidden(win) {
        return this._hidden.has(win);
    }

    /** Show one window the Hide fallback minimized (the app switcher activates a hidden app). */
    unhide(win) {
        this._hidden.delete(win);
        if (win.get_compositor_private())
            win.unminimize();
    }

    /**
     * @param {string} name a generic command name (core/appMenus/model.js)
     * @param {{appId: ?string, windowId: ?number}} target
     * @param {*} [arg] the command's target value (workspace index, window id)
     * @returns {boolean} false when the command could not run
     */
    run(name, target, arg) {
        const app = target.appId ? Shell.AppSystem.get_default().lookup_app(target.appId) : null;
        const win = target.windowId !== null && target.windowId !== undefined
            ? this._desktop.metaWindow(target.windowId) : null;
        switch (name) {
        case 'about':
            return this._about(target.appId);
        case 'quit':
            app?.request_quit();
            return !!app;
        case 'new-window':
            if (!app?.can_open_new_window())
                return false;
            app.open_new_window(-1);
            return true;
        case 'hide':
        case 'hide-others':
        case 'show-all':
            return this._hide(name, target.appId);
        case 'activate-window': {
            const w = this._desktop.metaWindow(arg);
            if (w)
                Main.activateWindow(w);
            return !!w;
        }
        case 'bring-all-to-front':
            if (!app)
                return false;
            app.activate_window(win, now());
            return true;
        }
        if (!win)
            return false;
        switch (name) {
        case 'close-window':
            win.delete(now());
            return true;
        case 'minimize':
            if (!WindowState.interceptMinimize(win))
                win.minimize();
            return true;
        case 'zoom':
            if (isMaximized(win))
                unmaximizeWindow(win);
            else
                maximizeWindow(win);
            return true;
        case 'fullscreen':
            if (win.is_fullscreen())
                win.unmake_fullscreen();
            else
                win.make_fullscreen();
            return true;
        case 'always-on-top':
            if (win.is_above())
                win.unmake_above();
            else
                win.make_above();
            return true;
        case 'sticky':
            if (win.is_on_all_workspaces())
                win.unstick();
            else
                win.stick();
            return true;
        case 'tile':
            return this._tile(win, arg);
        case 'move-to-workspace':
            return this._moveToWorkspace(win, arg);
        case 'move-to-monitor':
            if (!Number.isInteger(arg) || arg < 0 || arg >= global.display.get_n_monitors())
                return false;
            win.move_to_monitor(arg);
            return true;
        }
        return false;
    }

    _about(appId) {
        // Without app.about, the app's page in GNOME Software is the closest thing
        if (!appId || !DesktopAppInfo.new('org.gnome.Software.desktop'))
            return false;
        const id = appId.replace(/\.desktop$/, '');
        Gio.AppInfo.launch_default_for_uri_async(`appstream://${id}`, null, null, (_o, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                console.warn(`[Guava] app menus: cannot open ${id} in Software: ${e.message}`);
            }
        });
        return true;
    }

    _hide(mode, appId) {
        const event = { 'hide': 'hide', 'hide-others': 'others', 'show-all': 'all' }[mode];
        if (this._events.listenerCount('app-hide-requested') > 0) {
            this._events.emit('app-hide-requested', { appId, mode: event });
            return true;
        }
        const model = this._desktop.model;
        const active = model.workspaces.active;
        if (event === 'all') {
            for (const w of this._hidden) {
                if (w.get_compositor_private())
                    w.unminimize();
            }
            this._hidden.clear();
            return true;
        }
        for (const info of model.windows({ workspace: active, minimized: false })) {
            if (!isUserFacing(info))
                continue;
            const mine = info.appId === appId;
            if (mine !== (event === 'hide'))
                continue;
            const w = this._desktop.metaWindow(info.id);
            if (w?.can_minimize()) {
                w.minimize();
                this._hidden.add(w);
            }
        }
        return true;
    }

    // A tiling action of core/tileActions.js: the tiling engine (features/windows) when it runs,
    // else a plain placement of single-window zones on Guava's work area
    _tile(win, action) {
        if (this._events.listenerCount('window-tile-requested') > 0) {
            this._events.emit('window-tile-requested', { window: win, mode: action });
            return true;
        }
        const zone = ZONES[action];
        const area = zone ? this._layout.workArea(win.get_monitor()) : null;
        if (!area)
            return false;
        if (isMaximized(win))
            unmaximizeWindow(win);
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        const x = area.x + Math.round(zone.x * area.width);
        const y = area.y + Math.round(zone.y * area.height);
        win.move_resize_frame(true, x, y, Math.round(zone.w * area.width), Math.round(zone.h * area.height));
        return true;
    }

    // GNOME's window menu offers no workspace move for these (ui/windowMenu.js): with workspaces
    // on the primary monitor only, a window elsewhere is on every workspace
    _canMoveWorkspace(win) {
        return !win.is_always_on_all_workspaces() &&
            (!Meta.prefs_get_workspaces_only_on_primary() || win.is_on_primary_monitor());
    }

    /**
     * @param {Meta.Window} win
     * @param {number|'new'} index a workspace index, or 'new': a new workspace at the end that
     *   the user follows the window to (else the window just vanishes from view, B6)
     */
    _moveToWorkspace(win, index) {
        if (!this._canMoveWorkspace(win))
            return false;
        const wm = global.workspace_manager;
        if (index === 'new') {
            const time = now();
            // The workspace object, not its index: GNOME's dynamic workspaces drop the empty
            // one before it and Mission Control may reorder, so an index goes stale
            const ws = wm.append_new_workspace(false, time);
            if (!ws)
                return false;
            win.change_workspace(ws);
            ws.activate_with_focus(win, time);
            return true;
        }
        const ws = Number.isInteger(index) ? wm.get_workspace_by_index(index) : null;
        if (!ws)
            return false;
        win.change_workspace(ws);
        return true;
    }
}
