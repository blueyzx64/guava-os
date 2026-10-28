// SPDX-License-Identifier: GPL-3.0-or-later
// The macOS app switcher (features.js id 'app-switcher').
//
//   Super+Tab (Cmd-Tab)   a glass panel of big app icons, most recently used first. Tab,
//                         Shift+Tab, ` and the arrows move; Q quits and H hides the selected
//                         app; Down, Up or 1 shows its windows (App Exposé); Esc cancels;
//                         releasing Super activates (popup.js, model.js).
//   Super+` (Cmd-`)       the next window of the front app, no panel.
//
// Taking over the keys: GNOME binds Super+Tab to 'switch-applications' and Super+` to
// 'switch-group' (org.gnome.desktop.wm.keybindings). The Shell runs them through custom
// handlers it sets in WindowManager (js/ui/windowManager.js, GNOME 50: all point to
// WindowManager._startSwitcher). Guava sets its own handlers for those four actions while it
// runs and puts _startSwitcher back on disable. The user's accelerators are never written,
// so a changed shortcut keeps working and nothing needs a crash restore.
//
// Activating an app follows Mission Control's "When switching to an application, switch to a
// Space with open windows for the application" (switcher-switch-to-space, on by default as on
// macOS). Off: the app opens a new window on this Space when it can. Minimized windows stay
// minimized unless Alt is held at release (macOS ⌥) or switcher-restore-minimized is on;
// hidden apps (H, or Hide in the app menu) come back.
//
// Hide goes through 'app-hide-requested' (the windows feature), with core/appMenus' plain
// fallback when nothing listens; App Exposé through core/desktopActions.js.

import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GenericCommands } from '../../core/appMenus/commands.js';
import { DesktopActions } from '../../core/desktopActions.js';
import { WindowState } from '../../core/windowState.js';
import { GuavaSettings } from '../../lib/settings.js';
import { iconSizeFor, planActivation, switcherApps } from './model.js';
import { AppSwitcherPopup, WindowCyclerPopup } from './popup.js';

const LOG = '[Guava] app switcher:';
const APP_ACTIONS = ['switch-applications', 'switch-applications-backward'];
const WINDOW_ACTIONS = ['switch-group', 'switch-group-backward'];
// Room the panel keeps at the screen sides, and what each item adds around its icon
// (padding and spacing of .guava-switcher in style.css)
const SIDE_MARGIN = 64;
const ITEM_EXTRA = 32;

export class AppSwitcher {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ks = null;
        this._desktop = null;
        this._commands = null;
        this._actions = null;
        this._popup = null;
    }

    enable() {
        const { settings, events } = this._ctx;
        const cleanup = this._cleanup;
        const stock = Main.wm?._startSwitcher;
        if (typeof stock !== 'function') {
            console.warn(`${LOG} WindowManager._startSwitcher not found; GNOME's switcher stays`);
            return;
        }
        this._ks = new GuavaSettings(settings);
        this._ks.attach(cleanup);
        this._desktop = this._ctx.desktop.acquire(cleanup);
        this._commands = new GenericCommands({ events, desktop: this._desktop, layout: this._ctx.layout });
        cleanup.add(() => this._commands.stop());
        this._actions = new DesktopActions(this._ctx);

        const take = (names, handler) => {
            for (const name of names) {
                Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL,
                    (_display, _window, _event, binding) => handler(binding));
                cleanup.add(() => Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL,
                    stock.bind(Main.wm)));
            }
        };
        take(APP_ACTIONS, binding => this._showApps(binding));
        if (this._ks.bool('switcher-cycle-windows'))
            take(WINDOW_ACTIONS, binding => this._cycleWindows(binding));
        // Newest first on dispose: an open panel goes before the handlers are given back
        cleanup.add(() => this._popup?.destroy());
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** The open panel or window cycler, or null (tests and the harness). */
    get popup() {
        return this._popup;
    }

    // ---- Super+Tab ------------------------------------------------------------------------

    /** Running apps, most recent first, as Shell.App (window-backed apps included). */
    _apps() {
        const model = this._desktop.model;
        const tracker = Shell.WindowTracker.get_default();
        const byId = new Map();
        for (const id of model.apps()) {
            const info = model.windows({ appId: id })[0];
            const win = info ? this._desktop.metaWindow(info.id) : null;
            const app = win ? tracker.get_window_app(win) : null;
            if (app)
                byId.set(id, app);
        }
        return {
            ids: switcherApps([...byId.keys()], id => byId.has(id)),
            byId,
        };
    }

    _showApps(binding) {
        this._popup?.destroy();
        const { ids, byId } = this._apps();
        if (!ids.length)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const iconSize = iconSizeFor(ids.length, monitor.width - 2 * SIDE_MARGIN, ITEM_EXTRA);
        const popup = new AppSwitcherPopup(ids.map(id => byId.get(id)), {
            iconSize,
            label: this._ctx.gettext('Application Switcher'),
            frontIsFirst: this._desktop.model.focusedApp === ids[0],
            callbacks: {
                activate: (app, ts, alt) => this._activate(app, ts, alt),
                quit: app => app.request_quit(),
                hide: app => this._hide(app),
                expose: app => this._actions.run('app-expose', {
                    source: 'switcher', appId: this._appIdOf(app),
                }),
            },
        });
        this._open(popup, binding);
    }

    _open(popup, binding) {
        this._popup = popup;
        popup.connect('destroy', () => {
            if (this._popup === popup)
                this._popup = null;
        });
        if (!popup.show(binding.is_reversed(), binding.get_name(), binding.get_mask()))
            popup.destroy();
    }

    /** core/desktop's id of a Shell.App (the desktop id, or the web-app id it resolved). */
    _appIdOf(app) {
        for (const win of app.get_windows()) {
            const info = this._desktop.model.window(win.get_stable_sequence());
            if (info?.appId)
                return info.appId;
        }
        return null;
    }

    _hide(app) {
        const appId = this._appIdOf(app);
        if (appId)
            this._commands.run('hide', { appId, windowId: null });
    }

    _activate(app, timestamp, altHeld) {
        const appId = this._appIdOf(app);
        // The app's user-facing windows, most recently used first
        const windows = (appId ? this._desktop.model.windows({ appId }) : [])
            .map(info => ({ info, win: this._desktop.metaWindow(info.id) }))
            .filter(({ win }) => win);
        const byId = new Map(windows.map(({ win, info }) => [info.id, win]));
        const plan = planActivation(windows.map(({ win, info }) => ({
            id: info.id,
            workspace: info.workspace,
            minimized: info.minimized,
            hidden: WindowState.has(win, 'hidden') || this._commands.isHidden(win),
        })), {
            active: this._desktop.model.workspaces.active,
            switchToSpace: this._ks.bool('switcher-switch-to-space'),
            restoreMinimized: altHeld || this._ks.bool('switcher-restore-minimized'),
        });
        for (const id of plan.unhide) {
            const win = byId.get(id);
            if (this._commands.isHidden(win))
                this._commands.unhide(win);
            else
                win.unminimize();
        }
        if (plan.kind === 'focus') {
            Main.activateWindow(byId.get(plan.windowId), timestamp);
        } else if (plan.kind === 'new-window') {
            if (app.can_open_new_window())
                app.open_new_window(-1);
            else
                app.activate_full(-1, timestamp);
        }
    }

    // ---- Super+` --------------------------------------------------------------------------

    _cycleWindows(binding) {
        this._popup?.destroy();
        const model = this._desktop.model;
        const appId = model.focusedApp;
        if (!appId)
            return;
        const windows = model.windows({ appId, workspace: model.workspaces.active, minimized: false })
            .map(info => this._desktop.metaWindow(info.id))
            .filter(Boolean);
        if (windows.length < 2)
            return;
        this._open(new WindowCyclerPopup(windows, {
            activate: (win, ts) => Main.activateWindow(win, ts),
        }), binding);
    }
}
