// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager (features.js id 'stage-manager'): the Shell adapter.
//
// The state lives in one pure state machine (model.js): which entry (an app's windows, or a
// set the user built) is on the stage, the strip order per workspace, the desktop. This file
// only turns Shell happenings into the machine's events and applies the effects it returns:
//   - the window model is core/desktop (window-added/-changed/-removed/-focused events);
//   - the strip claims its edge through core/layout ('stage-strip', reserve 'none': macOS does
//     not reserve it), on the side opposite a dock on the left or right;
//   - windows are hidden with opacity and pick (windows.js), never minimize();
//   - every move is a flight of a clone (flights.js) through core/motion, cancellable;
//   - the strip, the drop target and the flights are one container (view.js), destroyed on
//     disable, after every window got its actor back.
//
// Input: strip clicks (Shift adds to the set), entry drags onto the stage (adds), entry drags onto another entry (a set, tiled to the side chosen), stage
// window drags dropped on a strip entry (joins it; never a resize, never the tiling edge zone), the wallpaper click
// (stage-manager-wallpaper-click), Alt-click anywhere outside the windows (the dock, the app
// grid: the next window opens into the current stage), the window controls' minimize
// (WindowState.interceptMinimize), and the shortcuts (cycle sets, strip slot n, remove).
// Show Desktop calls toggleDesktop() and reads isDesktopShown.
//
// Private API: none. Main.wm (public), global.display grab-op signals, Meta.BackgroundActor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { cornerSpec } from './thumbEffect.js';
import { WindowState } from '../../core/windowState.js';
import { Keybindings } from '../../lib/keybindings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { Flights } from './flights.js';
import { isClick } from '../../lib/clickModel.js';
import { isMaximized, unmaximizeWindow } from '../../lib/compat.js';
import { METRICS, dropHint, halves, overlaps, pointRect, scaleMs, stageRect, stripSide, workspaceDirection } from './geometry.js';
import { StageMachine } from './model.js';
import { StripView } from './view.js';
import { WindowHider } from './windows.js';

export const STRIP_CLAIM = 'stage-strip';

// Keys read live; the rest need a restart (features.js restartOn)
const VIEW_KEYS = ['stage-manager-side', 'stage-manager-tilt',
    'stage-manager-autohide', 'stage-manager-show-recent', 'rounded-corners',
    'rounded-corners-radius', 'rounded-corners-which'];
const SHORTCUTS = [
    ['stage-manager-remove-shortcut', sm => sm._removeFocused()],
    ['stage-manager-next-shortcut', sm => sm._send({ type: 'cycle', dir: 1 })],
    ['stage-manager-previous-shortcut', sm => sm._send({ type: 'cycle', dir: -1 })],
    ...[1, 2, 3, 4, 5, 6].map(n => [`stage-manager-slot-${n}-shortcut`, sm => sm._send({ type: 'slot', n })]),
];
// WindowState flags of other features whose windows Stage Manager leaves alone
const SET_ASIDE = ['hidden', 'splitView'];
// While a stage window is dragged, how often the pointer is checked against the strip
const WINDOW_DRAG_SAMPLE_MS = 60;
// Mutter tiles or maximizes a dragged window within drag-threshold x 6 of a screen edge
const TILE_ZONE_FACTOR = 6;

const rectOf = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const nowMs = () => Math.round(GLib.get_monotonic_time() / 1000);

export class StageManager {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._machine = null;
        this._timers = new Map();    // model timer key -> cleanup token
        this._pending = new Set();   // window ids not mapped yet (not told to the model)
        this._geometry = new Map();  // stage Meta.Window -> cleanup tokens (position/size)
        this._focusIdle = 0;
        this._geometryIdle = 0;
        this._press = null;          // a primary press on the wallpaper
        this._drag = null;           // a stage window dragged by its titlebar
        this._overview = false;
        this._minimized = new Set(); // ids the user minimized into the strip, still there
    }

    enable() {
        const ctx = this._ctx;
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(ctx.settings);
        ks.attach(cleanup);
        this._ks = ks;
        this._desktop = ctx.desktop.acquire(cleanup);
        this._layout = ctx.layout.acquire(cleanup);
        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();

        this._machine = new StageMachine({
            allAtOnce: ks.bool('stage-manager-group-by-app'),
            newWindows: ks.string('stage-manager-new-windows'),
        });

        const corners = () => cornerSpec({
            enabled: ks.bool('rounded-corners'), radius: ks.int('rounded-corners-radius'),
            which: ks.string('rounded-corners-which'),
        });
        // Disposed in reverse: flights land, windows come back, the claim goes, the view last
        this._view = new StripView(cleanup, {
            motion: ctx.motion,
            ms: d => this._ms(d),
            gettext: _,
            corners,
            onActivate: (id, { add }) => this._send({ type: 'activate', entry: id, add }),
            onDrop: id => this._send({ type: 'activate', entry: id, add: true }),
            onGroup: (dragged, target, side) => this._send({ type: 'group', dragged, target, side }),
            onLayout: () => this._syncGeometryWatch(),
        });
        this._view.setBackground(ks.bool('stage-manager-strip-background'));
        this._side = this._wantSide();
        this._claim = this._layout.claim(cleanup, {
            id: STRIP_CLAIM, edge: this._side, size: METRICS.stripWidth, reserve: 'none',
            actor: this._view.container,
        });
        // Runs after the hider gave every actor back: what the user minimized into the strip
        // ends minimized, as it would have without Stage Manager
        cleanup.add(() => {
            for (const id of this._minimized)
                this._desktop.metaWindow(id)?.minimize();
            this._minimized.clear();
        });
        this._hider = new WindowHider(cleanup);
        this._flights = new Flights(cleanup, {
            layer: this._view.flightLayer, motion: ctx.motion, ms: d => this._ms(d), corners,
            onLanded: win => this._view.setFlying(win, false),
        });
        cleanup.add(() => this._stopGeometryWatch());

        WindowState.setStageActive(true);
        WindowState.setMinimizeInterceptor(win => this._interceptMinimize(win));
        cleanup.add(() => {
            WindowState.setMinimizeInterceptor(null);
            WindowState.setStageActive(false);
        });

        const { events } = ctx;
        events.on('window-added', ({ window }) => this._added(window), cleanup);
        events.on('window-changed', ({ window }) => this._changed(window), cleanup);
        events.on('window-removed', ({ window }) => this._removed(window), cleanup);
        events.on('window-focused', () => this._queueFocus(), cleanup);
        events.on('workspaces-changed', ({ active }) => this._workspace(active), cleanup);
        events.on('monitors-changed', ({ primary }) => {
            this._send({ type: 'monitors', primary });
            this._render();
        }, cleanup);
        events.on('work-area-changed', () => this._layoutChanged(), cleanup);
        // A new window is told to the model when it maps, not when it is created
        cleanup.connect(global.window_manager, 'map', (_wm, actor) => this._mapped(actor.meta_window));
        cleanup.connect(Main.overview, 'showing', () => this._setOverview(true));
        cleanup.connect(Main.overview, 'hidden', () => this._setOverview(false));
        cleanup.connect(global.stage, 'captured-event', (_s, event) => this._capturedEvent(event));
        cleanup.connect(global.display, 'grab-op-begin', (_d, win, op) => this._dragBegin(win, op));
        cleanup.connect(global.display, 'grab-op-end', (_d, win) => this._dragEnd(win));
        WindowState.watch(cleanup, (win, flag) => {
            const info = win && SET_ASIDE.includes(flag) ? this._desktop.model.window(win.get_stable_sequence()) : null;
            if (info)
                this._changed(info);
        });
        // Genie / Scale minimize aims at the strip (minimize-effect, while both run)
        const provide = () => ctx.features?.instance?.('minimize-effect')?.setTargetProvider?.(cleanup,
            win => this._minimizeTarget(win));
        provide();
        events.on('feature-changed', ({ id, active }) => {
            if (id === 'minimize-effect' && active)
                provide();
        }, cleanup);

        ks.watch(VIEW_KEYS, () => this._layoutChanged());
        ks.watch(['stage-manager-strip-background'], () => this._view.setBackground(ks.bool('stage-manager-strip-background')));
        ks.watch(['stage-manager-new-windows'], () => this._send({
            type: 'config',
            newWindows: ks.string('stage-manager-new-windows'),
        }));
        for (const [key, fn] of SHORTCUTS)
            Keybindings.add(cleanup, key, ctx.settings, () => fn(this));

        this._init();
    }

    disable() {
        // Everything is in the cleanup registry
    }

    // ---- public API (Show Desktop, Control Center, the dock) ----------------------------

    /** True while the desktop of the active workspace is shown. */
    get isDesktopShown() {
        return this._machine?.desktopShown() ?? false;
    }

    /** Show the desktop (the stage goes to the strip), or bring the stage back. */
    toggleDesktop() {
        if (this._machine && !this._overview)
            this._send({ type: 'toggle-desktop' });
        return this.isDesktopShown;
    }

    /**
     * Open an app into the current stage: a running app's window joins the set, else the
     * app's next window does.
     * @param {string} appId
     */
    openIntoStage(appId) {
        const app = this._appSystem.lookup_app(appId);
        if (!this._machine || !app)
            return;
        this._send({ type: 'join-next', appId });
        if (app.get_n_windows() > 0)
            app.activate();
        else
            app.open_new_window(-1);
    }

    // ---- events in --------------------------------------------------------------------------

    _send(event) {
        if (!this._machine)
            return;
        const fx = this._machine.dispatch({ now: nowMs(), ...event });
        this._apply(fx);
    }

    // The model's view of a window. The transient parent is read live (a portal dialog gets
    // it after it is created), and so are the flags of features that set windows aside.
    _info(window) {
        const { id, appId, type, workspace, monitor, fullscreen, maximized, above, skipTaskbar, title, minimized } = window;
        const win = this._desktop.metaWindow(id);
        const parent = win?.get_transient_for()?.get_stable_sequence() ?? window.parent ?? null;
        const flagged = !!win && SET_ASIDE.some(f => WindowState.has(win, f));
        return { id, appId, type, parent, workspace, monitor, fullscreen, maximized, above, skipTaskbar, title, minimized, flagged };
    }

    _init() {
        const model = this._desktop.model;
        const windows = [];
        for (const w of model.windows({ userFacing: false })) {
            if (w.type !== 'normal' && w.type !== 'dialog')
                continue;
            windows.push(this._info(w));
        }
        this._send({
            type: 'init', windows, focus: model.focusedWindow?.id ?? null,
            active: model.workspaces.active, primary: model.primaryMonitor,
        });
        this._render();
    }

    _added(window) {
        const win = this._desktop.metaWindow(window.id);
        const actor = win?.get_compositor_private();
        if (!actor || !actor.mapped) {
            this._pending.add(window.id);
            return;
        }
        this._send({ type: 'add', window: this._info(window) });
    }

    _mapped(win) {
        const id = win?.get_stable_sequence?.();
        if (id === undefined || !this._pending.delete(id))
            return;
        const info = this._desktop.model.window(id);
        if (info)
            this._send({ type: 'add', window: this._info(info) });
    }

    _changed(window) {
        if (this._pending.has(window.id))
            return;
        this._send({ type: 'change', window: this._info(window) });
    }

    _removed(window) {
        this._minimized.delete(window.id);
        if (this._pending.delete(window.id))
            return;
        const win = this._desktop.metaWindow(window.id);
        if (win) {
            this._flights.land(win);
            this._hider.forget(win);
            this._unwatchGeometry(win);
        }
        this._send({ type: 'remove', id: window.id });
    }

    // After the current dispatch: a close or minimize that moved Mutter's focus comes first
    _queueFocus() {
        if (this._focusIdle)
            return;
        this._focusIdle = this._cleanup.idle(() => {
            this._focusIdle = 0;
            const id = this._desktop.model.focusedWindow?.id ?? null;
            if (id !== null && !this._pending.has(id))
                this._send({ type: 'focus', id });
            return GLib.SOURCE_REMOVE;
        }, { name: 'stage-manager-focus' });
    }

    _workspace(active) {
        const from = this._machine.activeWorkspace;
        // A window first shown on this workspace has mapped now
        for (const id of [...this._pending]) {
            const actor = this._desktop.metaWindow(id)?.get_compositor_private();
            if (actor?.mapped)
                this._mapped(actor.meta_window);
        }
        this._send({ type: 'workspace', active });
        this._render(workspaceDirection(from, active));
    }

    // Where a window minimizes to: its strip slot, else the strip's edge
    _minimizeTarget(win) {
        const id = win?.get_stable_sequence?.();
        if (!this._machine || id === undefined || this._machine.kindOf(id) !== 'managed')
            return null;
        const rect = this._view.thumbRect(win) ?? this._edgePoint(win);
        return rect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, edge: this._side } : null;
    }

    _interceptMinimize(win) {
        const id = win?.get_stable_sequence?.();
        if (id === undefined || this._machine.kindOf(id) !== 'managed')
            return false;
        this._minimized.add(id);
        this._send({ type: 'minimize', id });
        return true;
    }

    _removeFocused() {
        const id = this._desktop.model.focusedWindow?.id;
        if (id !== undefined)
            this._send({ type: 'remove-from-set', id });
    }

    // ---- effects out ------------------------------------------------------------------------

    _apply(fx) {
        const motion = this._ctx.motion.env.animations;
        const hide = fx.find(f => f.type === 'hide');
        const show = fx.find(f => f.type === 'show');
        const tile = fx.find(f => f.type === 'tile');
        // Where a new set's windows land: placed now (they are hidden), so the flights end there
        const placed = tile ? this._tile(tile) : new Map();
        // Where the windows coming back are now (their clones), before the strip is redrawn
        const froms = new Map();
        for (const id of show?.ids ?? []) {
            const win = this._desktop.metaWindow(id);
            if (win)
                froms.set(win, this._flights.land(win) ?? this._view.thumbRect(win) ?? this._edgePoint(win));
        }
        const leaving = new Map();
        for (const id of hide?.ids ?? []) {
            const win = this._desktop.metaWindow(id);
            if (win)
                leaving.set(win, this._flights.land(win) ?? rectOf(win.get_frame_rect()));
        }
        if (fx.some(f => f.type === 'strip' && f.ws === this._machine.activeWorkspace))
            this._render();

        for (const [win, from] of leaving) {
            const animate = hide.animate && motion && this._onScreen(win);
            this._hider.hide(win);
            if (!animate)
                continue;
            const to = this._view.thumbRect(win) ?? this._edgePoint(win);
            this._view.setFlying(win, true);
            if (!this._flights.fly(win, { from, to, toStage: false }))
                this._view.setFlying(win, false);
        }
        for (const win of froms.keys())
            this._minimized.delete(win.get_stable_sequence());
        for (const [win, from] of froms) {
            const animate = show.animate && motion && this._onScreen(win);
            const opacity = this._hider.show(win, { keepTransparent: animate });
            if (!this._isAttached(win))
                win.raise();
            if (animate)
                this._flights.fly(win, { from, to: placed.get(win) ?? rectOf(win.get_frame_rect()), toStage: true, opacity: opacity ?? 255 });
        }
        for (const f of fx) {
            switch (f.type) {
            case 'unminimize':
                this._minimized.add(f.id);
                this._desktop.metaWindow(f.id)?.unminimize();
                break;
            case 'focus':
                this._focus(f.id);
                break;
            case 'timer':
                this._timer(f.key, f.ms);
                break;
            case 'cancel':
                this._cleanup.release(this._timers.get(f.key) ?? 0);
                this._timers.delete(f.key);
                break;
            }
        }
        this._reconcile();
        this._syncGeometryWatch();
    }

    // The windows of a new set take the two halves of the stage; one that is maximized is
    // restored first. Returns the rect each was given.
    _tile({ left, right }) {
        const area = this._view.stageArea();
        const placed = new Map();
        if (!area)
            return placed;
        const rects = halves(area);
        for (const [ids, rect] of [[left, rects.left], [right, rects.right]]) {
            for (const id of ids) {
                const win = this._desktop.metaWindow(id);
                if (!win)
                    continue;
                if (isMaximized(win))
                    unmaximizeWindow(win);
                win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
                placed.set(win, rect);
            }
        }
        return placed;
    }

    _timer(key, ms) {
        this._cleanup.release(this._timers.get(key) ?? 0);
        this._timers.set(key, this._cleanup.timeout(ms, () => {
            this._timers.delete(key);
            this._send({ type: 'timer', key });
            return GLib.SOURCE_REMOVE;
        }, { name: 'stage-manager-timer' }));
    }

    _focus(id) {
        if (id === null) {
            global.display.unset_input_focus(global.get_current_time());
            return;
        }
        const win = this._desktop.metaWindow(id);
        if (win && global.display.focus_window !== win)
            Main.activateWindow(win);
    }

    // The model is the truth: any window whose actor disagrees is set right, without motion
    _reconcile() {
        for (const id of this._machine.hidden()) {
            const win = this._desktop.metaWindow(id);
            if (win && !this._hider.isHidden(win))
                this._hider.hide(win);
        }
        for (const win of this._hider.hiddenWindows()) {
            if (!this._machine.isHidden(win.get_stable_sequence()) && !this._flights.isFlying(win))
                this._hider.show(win);
        }
    }

    _isAttached(win) {
        return this._machine.kindOf(win.get_stable_sequence()) === 'attached';
    }

    _onScreen(win) {
        const actor = win.get_compositor_private();
        return !!actor && !this._overview && win.get_workspace()?.index() === this._machine.activeWorkspace &&
            win.get_monitor() === this._layout.primaryIndex;
    }

    // A window with no strip slot flies to the strip's edge
    _edgePoint(win) {
        const wa = this._layout.workArea(this._layout.primaryIndex);
        if (!wa)
            return null;
        const x = this._side === 'right' ? wa.x + wa.width - 12 : wa.x + 12;
        return { ...pointRect({ x, y: wa.y + wa.height / 2 }, rectOf(win.get_frame_rect()), 24), angle: 0 };
    }

    _ms(d) {
        return scaleMs(d, this._ks.double('stage-manager-animation-speed'));
    }

    // ---- the strip ----------------------------------------------------------------------------

    _wantSide() {
        return stripSide(this._ks.string('stage-manager-side'), this._layout.model.get('dock')?.edge ?? null);
    }

    _layoutChanged() {
        const side = this._wantSide();
        if (side !== this._side) {
            this._side = side;
            this._claim.update({ edge: side });
        }
        this._render();
    }

    _render(slide = 0) {
        if (!this._machine)
            return;
        const entries = [];
        for (const e of this._machine.shownStrip()) {
            const windows = e.windows.map(id => this._desktop.metaWindow(id)).filter(Boolean);
            if (windows.length === 0)
                continue;
            const apps = [...new Set(windows.map(w => this._tracker.get_window_app(w)).filter(Boolean))];
            entries.push({ id: e.id, windows, set: e.set, app: apps[0] ?? null, names: apps.map(a => a.get_name()) });
        }
        const tilt = this._ks.int('stage-manager-tilt');
        this._view.update({
            side: this._side, entries, tilt, slide,
            workArea: this._layout.workArea(this._layout.primaryIndex),
        });
        this._syncConditions();
    }

    _setOverview(on) {
        this._overview = on;
        this._syncConditions();
    }

    _syncConditions() {
        const floor = this._view.floorRect();
        const workArea = this._layout.workArea(this._layout.primaryIndex);
        let overlapped = false;
        for (const win of this._stageWindows()) {
            if (overlaps(stageRect(rectOf(win.get_frame_rect()), isMaximized(win), workArea), floor)) {
                overlapped = true;
                break;
            }
        }
        this._view.setConditions({
            showRecent: this._ks.bool('stage-manager-show-recent'),
            autohide: this._ks.bool('stage-manager-autohide'),
            overlapped, suppressed: this._overview,
        });
    }

    // Visible windows on the stage of the active workspace (the managed ones and their dialogs)
    _stageWindows() {
        const out = [];
        for (const id of this._machine.stageWindows()) {
            const win = this._desktop.metaWindow(id);
            if (win && !win.minimized)
                out.push(win);
        }
        return out;
    }

    // Stage windows moving over the strip hide it: watch their frames (only theirs)
    _syncGeometryWatch() {
        const want = new Set(this._stageWindows());
        for (const win of [...this._geometry.keys()]) {
            if (!want.has(win))
                this._unwatchGeometry(win);
        }
        for (const win of want) {
            if (this._geometry.has(win))
                continue;
            const queue = () => this._queueGeometry();
            this._geometry.set(win, [
                this._cleanup.connect(win, 'position-changed', queue),
                this._cleanup.connect(win, 'size-changed', queue),
            ]);
        }
        this._syncConditions();
    }

    _unwatchGeometry(win) {
        for (const token of this._geometry.get(win) ?? [])
            this._cleanup.release(token);
        this._geometry.delete(win);
    }

    _stopGeometryWatch() {
        for (const win of [...this._geometry.keys()])
            this._unwatchGeometry(win);
    }

    _queueGeometry() {
        if (this._geometryIdle)
            return;
        this._geometryIdle = this._cleanup.idle(() => {
            this._geometryIdle = 0;
            this._syncConditions();
            return GLib.SOURCE_REMOVE;
        }, { name: 'stage-manager-geometry' });
    }

    // ---- pointer input ------------------------------------------------------------------------

    _capturedEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
            this._press = null;
            return Clutter.EVENT_PROPAGATE;
        }
        const target = global.stage.get_event_actor(event);
        const onWallpaper = target instanceof Meta.BackgroundActor;
        if (type === Clutter.EventType.BUTTON_PRESS) {
            // Alt-click outside the windows (the dock, the app grid): open into the current stage
            if ((event.get_state() & Clutter.ModifierType.MOD1_MASK) && !(target instanceof Meta.WindowActor) && !onWallpaper)
                this._send({ type: 'join-next', appId: null });
            const [x, y] = event.get_coords();
            this._press = onWallpaper && !Main.overview.visible && Main.modalCount === 0
                ? { x, y, time: event.get_time() } : null;
            return Clutter.EVENT_PROPAGATE;
        }
        const press = this._press;
        this._press = null;
        const [x, y] = event.get_coords();
        if (press && onWallpaper && isClick(press, { x, y, time: event.get_time() }) &&
            this._ks.bool('stage-manager-wallpaper-click') &&
            this._ks.string('click-wallpaper-reveals-desktop') !== 'never') {
            // After the click is delivered (the background menu may want it)
            this._cleanup.idle(() => {
                this.toggleDesktop();
                return GLib.SOURCE_REMOVE;
            }, { name: 'stage-manager-wallpaper' });
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // What the pointer of a dragged stage window is over: an entry, the strip, or neither
    _dragProbe() {
        const [x, y] = global.get_pointer();
        // A press on the titlebar (a double-click to maximize) is no drag yet: the strip stays put
        const { start } = this._drag;
        if (Math.hypot(x - start.x, y - start.y) <= St.Settings.get().drag_threshold)
            return { hint: null, entry: null };
        const hint = dropHint({ x, y }, {
            floor: this._view.floorRect(),
            onEntry: this._view.entryAt(x, y) !== null,
            workArea: this._layout.workArea(this._layout.primaryIndex),
            zone: St.Settings.get().drag_threshold * TILE_ZONE_FACTOR,
        });
        return { hint, entry: hint === 'over' ? this._view.entryAt(x, y) : null };
    }

    // A stage window dragged by its titlebar and dropped on an entry of the strip joins it.
    // Resizes (RESIZING_*) never get here, and the screen-edge zone is left to tiling.
    _dragBegin(win, op) {
        const moving = op === Meta.GrabOp.MOVING || op === Meta.GrabOp.MOVING_UNCONSTRAINED ||
            op === Meta.GrabOp.KEYBOARD_MOVING;
        const id = win?.get_stable_sequence?.();
        if (!moving || id === undefined || !this._machine.stageWindows().includes(id))
            return;
        this._endDrag();
        const [x, y] = global.get_pointer();
        const drag = { win, frame: rectOf(win.get_frame_rect()), start: { x, y }, token: 0 };
        this._drag = drag;
        drag.token = this._cleanup.timeout(WINDOW_DRAG_SAMPLE_MS, () => {
            this._view.setDropHint(this._dragProbe().hint);
            return GLib.SOURCE_CONTINUE;
        }, { name: 'stage-manager-window-drag' });
    }

    _dragEnd(win) {
        const drag = this._drag;
        if (!drag || drag.win !== win)
            return;
        const { entry } = this._dragProbe();
        this._endDrag();
        if (entry === null)
            return;
        // Once Mutter has ended the grab (focus changes are refused during it)
        this._cleanup.idle(() => {
            const id = win.get_stable_sequence();
            if (!this._machine.stageWindows().includes(id))
                return GLib.SOURCE_REMOVE;
            // It comes back where it was picked up
            win.move_frame(true, drag.frame.x, drag.frame.y);
            this._send({ type: 'move-to-entry', id, entry });
            return GLib.SOURCE_REMOVE;
        }, { name: 'stage-manager-window-drop' });
    }

    _endDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        this._cleanup.release(drag.token);
        this._view.setDropHint(null);
    }
}
