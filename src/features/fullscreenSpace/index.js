// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// Full screen as its own Space (the macOS default). A window that goes full screen moves to a
// workspace of its own at the right, the user is carried there, and when the window leaves full
// screen (or closes) both go back. Empty helper workspaces are removed again; one empty
// workspace always stays after the last occupied one.
//
// The decisions (who moves, where, what may be removed) are in ./model.js. This file is the
// Shell side: it tracks windows, moves them and the user between workspaces, and keeps the
// timers. Workspaces are held as Meta.Workspace objects, never as bare indices, so a removal
// or a reorder cannot make a timer hit the wrong one. Everything it creates goes in `cleanup`.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { skipsTaskbar, WindowState } from '../../core/windowState.js';
import {
    ISOLATE_DELAY_MS, RESTORE_DELAY_MS, CLEANUP_GRACE_MS, MAX_WORKSPACES, SLOW_DOWN_FACTOR,
    SLOW_DOWN_MS, PIN_MAX_MS, isolateDecision, planTarget, trailingToAppend, canRemove, sweepList,
    restoreIndex, shouldRedirectNewWindow, reviveSnapshot,
} from './model.js';

const LOG = '[Guava]';

// Isolation state survives a disable()/enable() pair (Guava is disabled on every screen lock),
// keyed by Meta.Window.get_stable_sequence().
let savedState = [];

export class FullscreenSpace {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._reset();
    }

    _reset() {
        this._wins = new Map();         // Meta.Window -> per-window state, see _attach
        this._cleanups = new Map();     // Meta.Workspace -> timer token of its pending removal
        this._sweepToken = 0;
        this._ensuring = false;
        this._ensureToken = 0;
        this._slow = null;              // { original, token }: our slow-down factor
        this._pin = null;               // { win, token }: the moving window we set
        this._on = false;
    }

    // ---- life cycle ----------------------------------------------------------------------

    enable() {
        if (this._on)
            return;
        this._on = true;
        const c = this._cleanup;
        const display = global.display;
        const manager = global.workspace_manager;
        c.add(() => {
            this._restoreSlowDown();
            this._clearPin();
        });
        c.connect(display, 'window-created', (_d, win) => this._onWindowCreated(win));
        c.connect(manager, 'notify::n-workspaces', () => this._scheduleEnsure());
        c.connect(manager, 'workspace-switched', (_m, from, to) => this._onSwitched(from, to));

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win)
                this._attach(win);
        }
        this._reviveSaved();
        for (const [win, info] of this._wins) {
            if (win.is_fullscreen() && !info.isolated)
                this._scheduleIsolate(win, info);
        }
        this._scheduleEnsure();
    }

    /**
     * API: the user's own St slow-down factor while this feature borrows it for a slide, else
     * null. The minimize effect uses it to keep its speed (ctx.features.instance(...)).
     * @returns {number|null}
     */
    baseSlowDown() {
        return this._slow?.original ?? null;
    }

    disable() {
        if (!this._on)
            return;
        this._snapshot();
        this._on = false;
        // The cleanup registry disconnects and cancels everything; drop our own references.
        this._restoreSlowDown();
        this._clearPin();
        this._reset();
    }

    // ---- reading the desktop -------------------------------------------------------------

    get _manager() {
        return global.workspace_manager;
    }

    get _dynamic() {
        return Meta.prefs_get_dynamic_workspaces();
    }

    _workspaces() {
        const m = this._manager;
        const out = [];
        for (let i = 0; i < m.n_workspaces; i++)
            out.push(m.get_workspace_by_index(i));
        return out;
    }

    // A window that counts towards a workspace being occupied. Windows on every workspace never
    // do (they would make all of them occupied); skip-taskbar windows are hidden from this logic.
    _counts(win, ws) {
        if (skipsTaskbar(win) || win.is_on_all_workspaces() || win.get_workspace() !== ws)
            return false;
        if (Meta.prefs_get_workspaces_only_on_primary() && win.get_monitor() !== global.display.get_primary_monitor())
            return false;
        return true;
    }

    _windowsOf(ws) {
        return ws.list_windows().filter(w => this._counts(w, ws));
    }

    _occupied() {
        return this._workspaces().map(ws => this._windowsOf(ws).length > 0);
    }

    _activeIndex() {
        return this._manager.get_active_workspace_index();
    }

    // ---- tracking windows ----------------------------------------------------------------

    _onWindowCreated(win) {
        this._attach(win);
        this._cleanup.idle(() => {
            this._redirectNewWindow(win);
            this._ensureTrailing();
        }, { name: 'fullscreen-space new window' });
        const info = this._wins.get(win);
        if (info && win.is_fullscreen())
            this._scheduleIsolate(win, info);
    }

    _attach(win) {
        if (this._wins.has(win) || skipsTaskbar(win))
            return;
        const ws = win.get_workspace();
        const info = {
            home: ws,
            homeIdx: ws ? ws.index() : 0,
            isolated: false,
            space: null,            // the Space it was isolated to
            isoTimer: 0,
            restoreTimer: 0,
            pendingSpace: null,     // the Space it leaves while a restore is pending
            tokens: [],
        };
        this._wins.set(win, info);
        info.tokens.push(
            this._cleanup.connect(win, 'notify::fullscreen', () => this._onFullscreenChanged(win)),
            this._cleanup.connect(win, 'notify::minimized', () => this._onMinimizedChanged(win)),
            this._cleanup.connect(win, 'unmanaged', () => this._onUnmanaged(win)));
    }

    _detach(win) {
        const info = this._wins.get(win);
        if (!info)
            return null;
        this._cancelTimer(info, 'isoTimer');
        this._cancelTimer(info, 'restoreTimer');
        for (const t of info.tokens)
            this._cleanup.release(t);
        info.tokens = [];
        this._wins.delete(win);
        return info;
    }

    _cancelTimer(info, field) {
        if (!info[field])
            return;
        this._cleanup.release(info[field]);
        info[field] = 0;
    }

    _setHome(info, ws) {
        info.home = ws;
        info.homeIdx = ws ? ws.index() : info.homeIdx;
    }

    // ---- entering and leaving full screen ------------------------------------------------

    _onFullscreenChanged(win) {
        const info = this._wins.get(win);
        if (!info)
            return;
        if (win.is_fullscreen()) {
            if (info.restoreTimer) {
                // Back in full screen before the restore ran: it never left its Space
                this._cancelTimer(info, 'restoreTimer');
                info.isolated = true;
                info.space = info.pendingSpace ?? win.get_workspace();
                info.pendingSpace = null;
                return;
            }
            if (info.isolated || info.isoTimer)
                return;
            this._setHome(info, win.get_workspace());
            this._scheduleIsolate(win, info);
            return;
        }

        this._cancelTimer(info, 'isoTimer');
        if (WindowState.has(win, 'splitView')) {
            // Split View took it out of full screen on purpose: it stays in its Space
            this._cancelTimer(info, 'restoreTimer');
            info.isolated = false;
            info.space = info.pendingSpace = null;
            return;
        }
        if (!info.isolated)
            return;
        info.isolated = false;
        info.pendingSpace = info.space;
        info.space = null;
        // Let the resize finish before the window moves
        info.restoreTimer = this._cleanup.timeout(RESTORE_DELAY_MS, () => {
            info.restoreTimer = 0;
            this._restore(win, info);
        }, { name: 'fullscreen-space restore' });
    }

    // Mutter plays no minimize effect while a workspace switch runs, so a window the user
    // minimizes before its isolation ran is never switched away; it isolates once restored.
    _onMinimizedChanged(win) {
        const info = this._wins.get(win);
        if (!info)
            return;
        if (win.minimized)
            this._cancelTimer(info, 'isoTimer');
        else if (win.is_fullscreen() && !info.isolated && !info.restoreTimer)
            this._scheduleIsolate(win, info);
    }

    _scheduleIsolate(win, info) {
        if (info.isoTimer || info.isolated || win.minimized)
            return;
        info.isoTimer = this._cleanup.timeout(ISOLATE_DELAY_MS, () => {
            info.isoTimer = 0;
            if (this._wins.get(win) === info && win.is_fullscreen())
                this._isolate(win, info);
        }, { name: 'fullscreen-space isolate' });
    }

    // ---- isolating ----------------------------------------------------------------------

    _isolate(win, info) {
        if (info.isolated || win.minimized || win.is_on_all_workspaces())
            return;
        const ws = win.get_workspace();
        if (!ws)
            return;
        const index = ws.index();
        const active = this._manager.get_active_workspace();
        const follow = win.has_focus() || ws === active;
        const others = this._windowsOf(ws).filter(w => w !== win).length;
        const decision = isolateDecision({ index, others, sticky: false });

        if (decision === 'alone') {
            info.isolated = true;
            info.space = ws;
            this._ensureTrailing();
            return;
        }

        const target = this._makeRoomRight(ws);
        if (!target) {
            console.warn(`${LOG} full screen Space: workspace limit (${MAX_WORKSPACES}) reached, window stays`);
            return;
        }
        const index0 = ws.index();
        info.isolated = true;
        info.space = target;
        win.change_workspace(target);
        if (follow)
            this._activate(target, win);
        this._cancelCleanup(target);
        if (index0 > 0)
            this._scheduleCleanup(ws);
        this._ensureTrailing();
    }

    /**
     * The empty workspace right of `ws`: the existing one, or a new one, shifting the windows of
     * later workspaces right when it is occupied.
     * @returns {Meta.Workspace|null} null at the workspace limit
     */
    _makeRoomRight(ws) {
        const manager = this._manager;
        const plan = planTarget({ index: ws.index(), occupied: this._occupied() });
        const time = global.get_current_time();
        switch (plan.kind) {
        case 'use':
            return manager.get_workspace_by_index(plan.target);
        case 'append':
            return manager.append_new_workspace(false, time);
        case 'shift': {
            if (plan.append)
                manager.append_new_workspace(false, time);
            for (const from of plan.moves)
                this._shiftWorkspace(from);
            return manager.get_workspace_by_index(plan.target);
        }
        default:
            return null;
        }
    }

    // Move every window of workspace `from` one place right, and what refers to it with them
    _shiftWorkspace(from) {
        const manager = this._manager;
        const source = manager.get_workspace_by_index(from);
        const dest = manager.get_workspace_by_index(from + 1);
        if (!source || !dest)
            return;
        for (const w of source.list_windows()) {
            if (!w.is_on_all_workspaces() && w.get_workspace() === source)
                w.change_workspace(dest);
        }
        for (const info of this._wins.values()) {
            if (info.home === source)
                this._setHome(info, dest);
            if (info.space === source)
                info.space = dest;
            if (info.pendingSpace === source)
                info.pendingSpace = dest;
        }
    }

    // ---- going back ---------------------------------------------------------------------

    _restore(win, info) {
        info.pendingSpace = null;
        if (this._wins.get(win) !== info || win.is_on_all_workspaces())
            return;
        const current = win.get_workspace();
        if (!current)
            return;
        const manager = this._manager;
        const idx = info.home ? info.home.index() : -1;
        const home = manager.get_workspace_by_index(idx >= 0 ? idx : restoreIndex(info.homeIdx, manager.n_workspaces));
        if (!home || home === current)
            return;
        const follow = win.has_focus() || current === manager.get_active_workspace();
        win.change_workspace(home);
        this._setHome(info, home);
        if (follow)
            this._activate(home, win);
        if (current.index() > 0)
            this._scheduleCleanup(current);
        this._ensureTrailing();
    }

    _onUnmanaged(win) {
        const info = this._wins.get(win);
        if (!info)
            return;
        const space = info.space ?? info.pendingSpace;
        const ws = win.get_workspace() ?? space;
        const wasIsolated = info.isolated || !!info.restoreTimer;
        const home = info.home;
        if (this._pin?.win === win)
            this._clearPin();
        this._detach(win);
        this._cleanup.idle(() => {
            // Closing the window of a Space leaves it for home; closing any other never switches
            if (wasIsolated && ws && ws.index() >= 0 && home && home.index() >= 0) {
                const active = this._manager.get_active_workspace();
                if (active === ws && home !== active && this._windowsOf(ws).length === 0)
                    this._activate(home, null);
            }
            if (ws)
                this._scheduleCleanup(ws);
            this._ensureTrailing();
        }, { name: 'fullscreen-space closed' });
    }

    // ---- redirecting new windows ---------------------------------------------------------

    _redirectNewWindow(win) {
        const info = this._wins.get(win);
        if (!info || win.get_workspace() === null)
            return;
        const ws = win.get_workspace();
        const fsWin = ws.list_windows().find(w => w !== win && !w.is_on_all_workspaces() && w.is_fullscreen());
        if (!shouldRedirectNewWindow({
            fullscreen: win.is_fullscreen(),
            skips: skipsTaskbar(win),
            sharesSpaceWithFullscreen: !!fsWin,
            belongsToApp: !!fsWin && this._sameApp(win, fsWin),
        }))
            return;
        const first = this._manager.get_workspace_by_index(0);
        const watching = this._manager.get_active_workspace() === ws;
        win.change_workspace(first);
        this._setHome(info, first);
        // The user is looking at the full-screen Space and asked for this window (Spotlight, the
        // dock, a shortcut): follow it, as macOS switches to the app's Space
        if (watching && first !== ws && !win.minimized)
            this._activate(first, win);
    }

    // Moving a dialog would drag its parent along, so these stay where they are
    _sameApp(win, other) {
        if (win.get_transient_for() || other.get_transient_for() === win)
            return true;
        if (win.get_pid() > 0 && win.get_pid() === other.get_pid())
            return true;
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        return !!app && app === tracker.get_window_app(other);
    }

    // ---- activating a workspace ----------------------------------------------------------

    /**
     * Switch to `ws`. With a window, it stays still while the background slides (the Shell's
     * "moving window" of a window sent to another workspace) and the slide is slowed a little.
     */
    _activate(ws, win) {
        const time = global.get_current_time();
        const animation = Main.wm._workspaceAnimation;
        if (!animation || !('movingWindow' in animation)) {
            if (win)
                ws.activate_with_focus(win, time);
            else
                ws.activate(time);
            return;
        }
        const switching = this._manager.get_active_workspace() !== ws;
        // Slowing the Shell's animations only makes sense for a slide that will happen
        if (switching)
            this._slowDown();
        if (win)
            animation.movingWindow = win;
        this._pin = win ? { win, token: 0 } : null;
        if (win)
            ws.activate_with_focus(win, time);
        else
            ws.activate(time);
        if (!win)
            return;
        if (!switching || Main.overview.visible) {
            this._clearPin();
            return;
        }
        const pin = this._pin;
        pin.token = this._cleanup.timeout(PIN_MAX_MS, () => {
            pin.token = 0;
            if (this._pin === pin)
                this._clearPin();
        }, { name: 'fullscreen-space pin' });
    }

    // Only clear what is still ours: the Shell resets it itself when the slide ends
    _clearPin() {
        const pin = this._pin;
        if (!pin)
            return;
        this._pin = null;
        if (pin.token)
            this._cleanup.release(pin.token);
        const animation = Main.wm._workspaceAnimation;
        if (animation && animation.movingWindow === pin.win)
            animation.movingWindow = null;
    }

    _slowDown() {
        const settings = St.Settings.get();
        if (!this._slow) {
            this._slow = { original: settings.slow_down_factor, token: 0 };
            settings.slow_down_factor = SLOW_DOWN_FACTOR;
        } else if (this._slow.token) {
            this._cleanup.release(this._slow.token);
        }
        const slow = this._slow;
        slow.token = this._cleanup.timeout(SLOW_DOWN_MS, () => {
            slow.token = 0;
            this._restoreSlowDown();
        }, { name: 'fullscreen-space slow-down' });
    }

    _restoreSlowDown() {
        const slow = this._slow;
        if (!slow)
            return;
        this._slow = null;
        if (slow.token)
            this._cleanup.release(slow.token);
        const settings = St.Settings.get();
        // Someone else changed it meanwhile: leave their value
        if (settings.slow_down_factor === SLOW_DOWN_FACTOR)
            settings.slow_down_factor = slow.original;
    }

    // ---- keeping the workspaces tidy -----------------------------------------------------

    _scheduleEnsure() {
        if (this._ensureToken || !this._on)
            return;
        this._ensureToken = this._cleanup.idle(() => {
            this._ensureToken = 0;
            this._ensureTrailing();
        }, { name: 'fullscreen-space ensure' });
    }

    // At least two workspaces, and one empty one after the last occupied
    _ensureTrailing() {
        if (this._ensuring || !this._on)
            return;
        this._ensuring = true;
        try {
            const n = trailingToAppend({ occupied: this._occupied() });
            for (let i = 0; i < n; i++)
                this._manager.append_new_workspace(false, global.get_current_time());
        } finally {
            this._ensuring = false;
        }
    }

    _cancelCleanup(ws) {
        const token = this._cleanups.get(ws);
        if (!token)
            return;
        this._cleanups.delete(ws);
        this._cleanup.release(token);
    }

    _scheduleCleanup(ws) {
        if (!ws || ws.index() <= 0 || !this._on)
            return;
        this._cancelCleanup(ws);
        this._cleanups.set(ws, this._cleanup.timeout(CLEANUP_GRACE_MS, () => {
            this._cleanups.delete(ws);
            this._removeIfEmpty(ws);
        }, { name: 'fullscreen-space cleanup' }));
    }

    _removeIfEmpty(ws) {
        const index = ws.index();
        if (!canRemove({ index, occupied: this._occupied(), active: this._activeIndex() }))
            return;
        this._manager.remove_workspace(ws, global.get_current_time());
        this._scheduleEnsure();
    }

    _scheduleSweep() {
        if (this._sweepToken || !this._on)
            return;
        this._sweepToken = this._cleanup.timeout(CLEANUP_GRACE_MS, () => {
            this._sweepToken = 0;
            // Highest first, each checked again against the state the last removal left
            const occupied = this._occupied();
            for (const index of sweepList({ occupied, active: this._activeIndex() })) {
                const ws = this._manager.get_workspace_by_index(index);
                if (ws)
                    this._removeIfEmpty(ws);
            }
        }, { name: 'fullscreen-space sweep' });
    }

    _onSwitched(from, to) {
        const dest = this._manager.get_workspace_by_index(to);
        if (dest)
            this._cancelCleanup(dest);
        if (from <= 0)
            return;
        if (this._dynamic) {
            const left = this._manager.get_workspace_by_index(from);
            if (left)
                this._scheduleCleanup(left);
        } else {
            this._scheduleSweep();
        }
    }

    // ---- surviving a disable ---------------------------------------------------------------

    _snapshot() {
        const out = [];
        for (const [win, info] of this._wins) {
            if (!info.isolated && !info.restoreTimer)
                continue;
            const space = info.space ?? info.pendingSpace ?? win.get_workspace();
            const spaceIndex = space ? space.index() : -1;
            if (spaceIndex < 0)
                continue;
            const homeIndex = info.home && info.home.index() >= 0 ? info.home.index() : info.homeIdx;
            out.push({ id: win.get_stable_sequence(), home: homeIndex, space: spaceIndex });
        }
        savedState = out;
    }

    _reviveSaved() {
        const saved = savedState;
        savedState = [];
        if (saved.length === 0)
            return;
        const live = new Map();
        const byId = new Map();
        for (const [win] of this._wins) {
            const ws = win.get_workspace();
            const id = win.get_stable_sequence();
            byId.set(id, win);
            live.set(id, { index: ws ? ws.index() : -1, fullscreen: win.is_fullscreen() });
        }
        const manager = this._manager;
        const { isolated, restore } = reviveSnapshot(saved, live, manager.n_workspaces);
        for (const entry of isolated) {
            const win = byId.get(entry.id);
            const info = this._wins.get(win);
            info.isolated = true;
            info.space = manager.get_workspace_by_index(entry.space);
            this._setHome(info, manager.get_workspace_by_index(restoreIndex(entry.home, manager.n_workspaces)));
        }
        for (const entry of restore) {
            const win = byId.get(entry.id);
            const info = this._wins.get(win);
            this._setHome(info, manager.get_workspace_by_index(restoreIndex(entry.home, manager.n_workspaces)));
            info.pendingSpace = manager.get_workspace_by_index(entry.space);
            info.restoreTimer = this._cleanup.timeout(RESTORE_DELAY_MS, () => {
                info.restoreTimer = 0;
                this._restore(win, info);
            }, { name: 'fullscreen-space restore' });
        }
    }
}
