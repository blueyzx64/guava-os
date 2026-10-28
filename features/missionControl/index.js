// SPDX-License-Identifier: GPL-3.0-or-later
// Mission Control (features.js id 'mission-control'): GNOME's overview restyled as macOS
// Mission Control, App Exposé, and the start on the desktop at login.
//
//   - Mission Control: the Spaces bar on top (spaces.js), the current Space's windows spread
//     out (the stock window picker; titles on hover are the stock ones), no search entry, no
//     dash and no find-as-you-type. The app grid is not part of it: Launchpad and Super+A.
//   - App Exposé: only one app's windows, spread, with its minimized windows in a strip at
//     the bottom (expose.js). Ctrl+Down, the dock's "Show All Windows", and the event
//     'app-expose-requested' (Super+` down, four-finger swipe down, hot corners).
//   - Entry points: F3 and Ctrl+Up (mission-control-shortcut), GNOME's three/four-finger swipe
//     up (shell-behaviour stops it at the window picker), the optional dock item. The Super
//     tap stays with Spotlight.
//   - Settings (macOS defaults): rearrange Spaces by most recent use (off), group windows by
//     application (off), switch to a Space with the app's windows (on), start on the desktop
//     (on), static Spaces with + and × (on: GNOME's dynamic workspaces are off meanwhile).
// The dock and the Stage Manager strip already hide while the overview shows, so they hide
// in Mission Control and App Exposé with no extra hook.
//
// Shell API (GNOME 50; checked against js/ui/overview.js, overviewControls.js, workspace.js,
// searchController.js, layout.js): Main.overview._overview.controls (_searchEntryBin, dash,
// _thumbnailsBox), Workspace.prototype._isOverviewWindow, WorkspaceLayout.prototype.
// _createBestLayout and its _sortedWindows (WindowPreview.windowCenter),
// SearchController.prototype._shouldTriggerSearch, Overview.runStartupAnimation,
// LayoutManager._startingUp.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ControlsState } from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import { SearchController } from 'resource:///org/gnome/shell/ui/searchController.js';

import { WindowState, skipsTaskbar } from '../../core/windowState.js';
import { GuavaSettings } from '../../lib/settings.js';
import { Keybindings, MODAL_MODES } from '../../lib/keybindings.js';
import { ModalSurface } from '../../lib/modalSurface.js';
import { SettingOwner } from '../../core/originals.js';
import { SpacesBar } from './spaces.js';
import { ExposeStrip, STRIP_HEIGHT } from './expose.js';
import {
    MODE, exposeView, fullscreenAppOf, groupedOrder, mruOrder, skipStartupOverview, touchRecent,
    windowPlace,
} from './model.js';

const LOG = '[Guava] mission-control:';
const ALL = Object.freeze({ mode: MODE.ALL, appId: null });

export const KEYS = Object.freeze({
    shortcut: 'mission-control-shortcut',
    expose: 'app-expose-shortcut',
    staticSpaces: 'mc-static-spaces',
    rearrange: 'mc-rearrange-spaces',
    group: 'mc-group-by-app',
    switchToSpace: 'mc-switch-to-app-space',
    startOnDesktop: 'mc-start-on-desktop',
});

// Module state lives as long as the Shell process (an extension's modules load once), so this
// tells the first start after login from a later disable/enable (lock, prefs)
let firstStart = true;

const appOf = win => Shell.WindowTracker.get_default().get_window_app(win);

export class MissionControl {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ = ctx.gettext ?? (s => s);
        this._view = ALL;
        this._pending = null;
        this._static = null;         // SettingOwners of the static-Spaces keys, once taken
        this._recent = [];
        this.startupSkipped = false;
        this.startupState = null;
    }

    enable() {
        const c = this._cleanup;
        const controls = Main.overview._overview?.controls;
        if (!controls?._thumbnailsBox || !controls.dash || !controls._searchEntryBin) {
            console.warn(`${LOG} the overview controls were not found; Mission Control is off`);
            return;
        }
        this._controls = controls;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(c);

        this._skipStartup();
        this._restyle(controls);
        this._filterWindows();
        this._groupByApp();
        this._ownSettings();

        this._strip = new ExposeStrip(this._ctx.motion, this._);
        c.add(() => this._strip.hide());
        this._spaces = new SpacesBar(this, controls._thumbnailsBox, c);
        this._spaces.enable();

        c.connect(Main.overview, 'showing', () => this._onShowing());
        c.connect(Main.overview, 'hidden', () => this._onHidden());
        c.connect(global.workspace_manager, 'active-workspace-changed', () => this._touchActive());
        this._touchActive();
        c.add(() => {
            this._view = ALL;
            this._pending = null;
        });

        // Super+` down, the four-finger swipe down and hot corners (core/desktopActions.js)
        this._ctx.events.on('app-expose-requested', ({ appId }) => this.toggleAppExpose(appId), c);

        // Also while a Guava modal (Launchpad) is open: opening closes it, as on macOS
        Keybindings.add(c, KEYS.shortcut, this._ctx.settings, () => this.toggle(), { modes: MODAL_MODES });
        Keybindings.add(c, KEYS.expose, this._ctx.settings, () => this.toggleAppExpose(), { modes: MODAL_MODES });
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // ---- public API (dock, gestures, hot corners through ctx.features) -------------------

    /** 'all' (Mission Control), 'app' (App Exposé) or null when closed. */
    get mode() {
        return Main.overview.visible ? this._view.mode : null;
    }

    /** Mission Control: open it, or close it when it is open. */
    toggle() {
        if (Main.overview.visible && this._view.mode === MODE.ALL)
            Main.overview.hide();
        else
            this._open(ALL);
    }

    showMissionControl() {
        this._open(ALL);
    }

    /**
     * App Exposé for an app (default: the focused one); closes it when it is open.
     *
     * @param {?string} appId
     */
    toggleAppExpose(appId = null) {
        if (Main.overview.visible && this._view.mode === MODE.APP && (!appId || appId === this._view.appId))
            Main.overview.hide();
        else
            this.showAppExpose(appId);
    }

    /** @param {?string} appId default: the focused app */
    showAppExpose(appId = null) {
        const focused = Shell.WindowTracker.get_default().focus_app?.get_id() ?? null;
        this._open(exposeView(appId, focused));
    }

    // ---- read by spaces.js ---------------------------------------------------------------

    spacesBarWanted() {
        return this._view.mode === MODE.ALL;
    }

    staticSpaces() {
        return !Meta.prefs_get_dynamic_workspaces();
    }

    /** @param {Meta.Workspace[]} workspaces */
    spaces(workspaces) {
        return workspaces.map(ws => ({
            fullscreenApp: fullscreenAppOf(ws.list_windows().map(w => ({
                appName: appOf(w)?.get_name() ?? null,
                fullscreen: w.is_fullscreen(),
                normal: w.get_window_type() === Meta.WindowType.NORMAL && !skipsTaskbar(w),
            }))),
        }));
    }

    // ---- opening and closing -------------------------------------------------------------

    _open(view) {
        if (Main.overview.visible) {
            if (view.mode === this._view.mode && view.appId === this._view.appId)
                return;
            // A different view: the window picker is rebuilt on the next show
            this._pending = view;
            Main.overview.hide();
            return;
        }
        ModalSurface.closeAll();
        this._setView(view);
        Main.overview.show(ControlsState.WINDOW_PICKER);
    }

    _setView(view) {
        this._view = view;
        this._controls._thumbnailsBox._updateShouldShow();
        this._controls.queue_relayout();
    }

    _onShowing() {
        this._rearrange();
        if (this._view.mode === MODE.APP)
            this._strip.show(this._minimizedOf(this._view.appId));
        else
            this._strip.hide();
        this._controls.queue_relayout();
    }

    _onHidden() {
        this._strip.hide();
        const next = this._pending;
        this._pending = null;
        this._setView(ALL);
        if (next) {
            this._cleanup.idle(() => {
                if (!Main.overview.visible)
                    this._open(next);
            }, { name: 'guava mission control reopen' });
        }
    }

    _minimizedOf(appId) {
        const app = appId ? Shell.AppSystem.get_default().lookup_app(appId) : null;
        const windows = app?.get_windows() ?? global.display.list_all_windows()
            .filter(w => appOf(w)?.get_id() === appId);
        return windows.filter(w => w.minimized && !skipsTaskbar(w) &&
            windowPlace({ appId, minimized: true }, this._view) === 'strip');
    }

    // ---- the restyle ---------------------------------------------------------------------

    _restyle(controls) {
        const c = this._cleanup;
        const overview = Main.overview._overview;
        overview.add_style_class_name('guava-mission-control');
        c.add(() => overview.remove_style_class_name('guava-mission-control'));

        // The search entry and the dash leave the layout: hidden, with no height. The dash's
        // height becomes the room App Exposé's minimized strip needs at the bottom.
        const out = (actor, height) => {
            c.add(() => {
                actor.show();
                actor.queue_relayout();
            });
            c.inject(actor, 'get_preferred_height', () => {
                const h = height();
                return [h, h];
            });
            // The Shell's startup animation reads the search entry's transformed position: a
            // hidden actor has none (NaN, a CRITICAL). Zero height until then, hidden after.
            const lm = Main.layoutManager;
            if (!lm._startingUp) {
                actor.hide();
                return;
            }
            const done = c.connect(lm, 'startup-complete', () => {
                c.release(done);
                actor.hide();
            });
        };
        out(controls._searchEntryBin, () => 0);
        out(controls.dash, () => (this._strip?.shown ? STRIP_HEIGHT : 0));
        controls.queue_relayout();

        // No find-as-you-type: typing in Mission Control does not open a search
        if (typeof SearchController?.prototype?._shouldTriggerSearch === 'function')
            c.inject(SearchController.prototype, '_shouldTriggerSearch', () => false);
        else
            console.warn(`${LOG} SearchController._shouldTriggerSearch not found; typing still searches`);
    }

    /**
     * Windows in Stage Manager's strip (WindowState 'staged') are in no overview. App Exposé
     * shows the chosen app's windows only (minimized ones go to the strip).
     */
    _filterWindows() {
        const self = this;
        const proto = Workspace.Workspace?.prototype;
        if (typeof proto?._isOverviewWindow !== 'function') {
            console.warn(`${LOG} Workspace._isOverviewWindow not found; App Exposé shows every window`);
            return;
        }
        this._cleanup.inject(proto, '_isOverviewWindow', function (orig, win) {
            const ok = orig.call(this, win);
            if (!ok)
                return ok;
            const staged = WindowState.has(win, 'staged');
            if (!staged && self._view.mode === MODE.ALL)
                return ok;
            return windowPlace({ appId: appOf(win)?.get_id() ?? null, minimized: win.minimized, staged }, self._view) === 'spread';
        });
    }

    /**
     * "Group windows by application": the stock layout places windows by where they are on
     * screen (WindowPreview.windowCenter). While it computes, each preview gets a centre from
     * its rank in the grouped order, so the rows fill app by app.
     */
    _groupByApp() {
        const self = this;
        const proto = Workspace.WorkspaceLayout?.prototype;
        if (typeof proto?._createBestLayout !== 'function') {
            console.warn(`${LOG} WorkspaceLayout._createBestLayout not found; windows are not grouped`);
            return;
        }
        this._cleanup.inject(proto, '_createBestLayout', function (orig, ...args) {
            const previews = this._sortedWindows;
            if (!self._ks.bool(KEYS.group) || !Array.isArray(previews) || previews.length < 2)
                return orig.apply(this, args);
            const order = groupedOrder(previews.map(p => ({ appId: p.metaWindow ? appOf(p.metaWindow)?.get_id() ?? null : null })));
            order.forEach((index, rank) => Object.defineProperty(previews[index], 'windowCenter', {
                value: { x: rank, y: rank }, configurable: true,
            }));
            try {
                return orig.apply(this, args);
            } finally {
                for (const p of previews)
                    delete p.windowCenter;
            }
        });
        this._ks.watch([KEYS.group], () => this._controls.queue_relayout());
    }

    // ---- Spaces policies -----------------------------------------------------------------

    _touchActive() {
        const ws = global.workspace_manager.get_active_workspace();
        if (ws)
            this._recent = touchRecent(this._recent, ws);
    }

    /** "Automatically rearrange Spaces based on most recent use", applied as it opens. */
    _rearrange() {
        if (!this._ks.bool(KEYS.rearrange))
            return;
        const wm = global.workspace_manager;
        const order = [];
        for (let i = 0; i < wm.n_workspaces; i++)
            order.push(wm.get_workspace_by_index(i));
        mruOrder(order, this._recent).forEach((ws, i) => {
            if (ws.index() !== i)
                wm.reorder_workspace(ws, i);
        });
    }

    /**
     * Static Spaces on (idempotent; given back on disable). The Spaces bar's + calls it too, so
     * the new Space stays even where GNOME's dynamic workspaces were left on.
     */
    holdStaticSpaces() {
        if (!Meta.prefs_get_dynamic_workspaces())
            return;
        if (!this._static) {
            const c = this._cleanup;
            const { originals } = this._ctx;
            const mutter = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
            const wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' });
            const count = new SettingOwner(originals, wm, 'num-workspaces', {
                type: 'i', transform: () => global.workspace_manager.n_workspaces, yieldToUser: true,
            });
            const dynamic = new SettingOwner(originals, mutter, 'dynamic-workspaces', {
                type: 'b', value: false, yieldToUser: true,
            });
            this._static = { count, dynamic };
            c.add(() => {
                count.release();
                dynamic.release();
                this._static = null;
            });
        }
        // Again after the user turned dynamic workspaces back on (the owners let go then)
        this._static.count.sync(true);
        this._static.dynamic.sync(true);
    }

    /**
     * GNOME settings Mission Control changes, each through core/originals (given back on
     * disable and after a crash):
     *   - static Spaces: org.gnome.mutter dynamic-workspaces off, after num-workspaces is set to
     *     the current count so no Space comes or goes. Mutter then keeps num-workspaces equal to
     *     the count as Spaces are added or removed; Guava stops owning it at that point.
     *   - "switch to a Space with open windows" off: org.gnome.shell.app-switcher
     *     current-workspace-only on, so the app switcher stays on the current Space.
     */
    _ownSettings() {
        const c = this._cleanup;
        const { originals } = this._ctx;
        if (this._ks.bool(KEYS.staticSpaces))
            this.holdStaticSpaces();
        const switcher = new Gio.Settings({ schema_id: 'org.gnome.shell.app-switcher' });
        const currentOnly = new SettingOwner(originals, switcher, 'current-workspace-only', {
            type: 'b', value: true,
        });
        const sync = () => currentOnly.sync(!this._ks.bool(KEYS.switchToSpace));
        sync();
        this._ks.watch([KEYS.switchToSpace], sync);
        c.add(() => currentOnly.release());
    }

    // ---- start on the desktop ------------------------------------------------------------

    /**
     * The Shell shows the overview at login (LayoutManager._startupAnimationSession calls
     * Main.overview.runStartupAnimation when the session has an overview). While the Shell is
     * still starting, that call fades the desktop in instead; when Guava starts while that
     * animation already runs, the overview is hidden at once. Once startup is over the
     * injection is dropped, so a later disable/enable (unlock) never touches it.
     */
    _skipStartup() {
        const c = this._cleanup;
        const lm = Main.layoutManager;
        const first = firstStart;
        firstStart = false;
        this.startupState = { startingUp: !!lm._startingUp, first, overview: Main.overview.visible };
        if (!skipStartupOverview({ wanted: this._ks.bool(KEYS.startOnDesktop), startingUp: !!lm._startingUp, firstStart: first }))
            return;
        // Guava came up after the startup animation with the login overview still open: hide
        // it now. While the animation still runs it must finish first: hiding the overview
        // mid-animation unmaps the controls, their ensureAllocation() never resolves, and the
        // Shell's startup (cover pane, startup-complete) never completes
        if (Main.overview.visible) {
            this.startupSkipped = true;
            if (!lm._startingUp) {
                Main.overview.hide();
                return;
            }
            const after = c.connect(lm, 'startup-complete', () => {
                c.release(after);
                Main.overview.hide();
            });
            return;
        }
        if (!lm._startingUp || typeof Main.overview.runStartupAnimation !== 'function')
            return;
        const ui = lm.uiGroup;
        c.add(() => {
            ui.opacity = 255;
        });
        const token = c.inject(Main.overview, 'runStartupAnimation', () => {
            this.startupSkipped = true;
            ui.opacity = 0;
            return new Promise(resolve => this._ctx.motion.ease(ui, { opacity: 255 },
                { duration: 'long', curve: 'enter', onDone: () => resolve() }, c));
        });
        const done = c.connect(lm, 'startup-complete', () => {
            c.release(done);
            c.release(token);
        });
    }
}
