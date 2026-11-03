// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager (features.js id 'stage-manager'): the Shell adapter. Spec: docs/features/stage-manager.md.
//
// The state lives in one pure state machine (model.js): the sets, the stage and strip of each
// workspace, whether the strip is slid in. This file turns Shell happenings into the machine's
// events and applies what it answers:
//   - the window model is core/desktop (window-added/-changed/-removed/-focused events);
//   - windows off the stage are hidden with opacity and pick (windows.js), never minimized or
//     unmapped, so turning Stage Manager off is one synchronous restore (SM-32);
//   - after every event reconcile() compares the windows to the model's hiddenIds() and fixes
//     any difference: a missed or reordered signal heals on the next event (SM-33);
//   - minimize is Mutter's own (SM-8): a minimized window leaves its set, Stage Manager never
//     calls minimize() or unminimize();
//   - the strip claims its edge through core/layout ('stage-strip', reserve 'none': macOS does
//     not reserve it), on the side opposite a side dock;
//   - every move is a flight of a clone (flights.js) through core/motion, cancellable (SM-21, 22).
//
// Input: strip clicks (Shift adds to the stage), the pointer on the edge or the strip, the edge
// pressure barrier, a stage window dragged and dropped on the strip (stash), the wallpaper click
// (Show Desktop), and the shortcuts (next / previous set, slot n, remove from set).
// Public API: toggleDesktop(), isDesktopShown, openIntoStage(appId); WindowState flag 'staged'.
//
// Private API: none. Main.wm (public), global.display grab-op signals, Meta.BackgroundActor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WindowState } from '../../core/windowState.js';
import { Keybindings } from '../../lib/keybindings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { isClick } from '../../lib/clickModel.js';
import { isMaximized } from '../../lib/compat.js';
import { Flights } from './flights.js';
import { METRICS, overlaps, scaleMs, stageRect, stripSide } from './geometry.js';
import { StageModel } from './model.js';
import { cornerSpec } from './thumbEffect.js';
import { StripView } from './view.js';
import { WindowHider } from './windows.js';

export const STRIP_CLAIM = 'stage-strip';

// Keys read live; the rest need a restart (features.js restartOn)
const VIEW_KEYS = ['stage-manager-side', 'stage-manager-tilt', 'rounded-corners',
    'rounded-corners-radius', 'rounded-corners-which'];
const CONFIG_KEYS = ['stage-manager-new-windows', 'stage-manager-autohide', 'stage-manager-show-recent'];
const SHORTCUTS = [
    ['stage-manager-remove-shortcut', sm => sm._removeFocused()],
    ['stage-manager-next-shortcut', sm => sm._send({ type: 'cycle', dir: 1 })],
    ['stage-manager-previous-shortcut', sm => sm._send({ type: 'cycle', dir: -1 })],
    ...[1, 2, 3, 4, 5, 6].map(n => [`stage-manager-slot-${n}-shortcut`, sm => sm._send({ type: 'slot', n })]),
];
// WindowState flags of other features whose windows Stage Manager leaves alone
const SET_ASIDE = ['hidden', 'splitView'];

const rectOf = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const nowMs = () => Math.round(GLib.get_monotonic_time() / 1000);

export class StageManager {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._model = null;
        this._timers = new Map();    // model timer key -> cleanup token
        this._pending = new Set();   // window ids not mapped yet (not told to the model)
        this._geometry = new Map();  // stage Meta.Window -> cleanup tokens (position/size)
        this._geometryIdle = 0;
        this._focusIdle = 0;
        this._overlapped = false;
        this._press = null;          // a primary press on the wallpaper
        this._drag = null;           // a stage window being moved: {win, frame}
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

        this._model = new StageModel(this._config());
        cleanup.add(() => {
            this._model = null;
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
            onActivate: (set, { add }) => this._send({ type: 'activate', set, add }),
            onEdge: on => this._send({ type: 'edge', on }),
            onHover: on => this._send({ type: 'strip-hover', on }),
            onPush: () => this._send({ type: 'push' }),
            onReveal: () => this._send({ type: 'push' }),
        });
        this._view.setBackground(ks.bool('stage-manager-strip-background'));
        this._side = this._wantSide();
        this._claim = this._layout.claim(cleanup, {
            id: STRIP_CLAIM, edge: this._side, size: METRICS.stripWidth, reserve: 'none',
            actor: this._view.container,
        });
        this._hider = new WindowHider(cleanup);
        this._flights = new Flights(cleanup, {
            layer: this._view.flightLayer, motion: ctx.motion, ms: d => this._ms(d), corners,
            onLanded: win => this._view.setFlying(win, false),
        });
        cleanup.add(() => this._stopGeometryWatch());

        WindowState.setStageActive(true);
        cleanup.add(() => WindowState.setStageActive(false));

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
        cleanup.connect(Main.overview, 'showing', () => this._send({ type: 'overview', on: true }));
        cleanup.connect(Main.overview, 'hidden', () => this._send({ type: 'overview', on: false }));
        cleanup.connect(global.stage, 'captured-event', (_s, event) => this._capturedEvent(event));
        cleanup.connect(global.display, 'grab-op-begin', (_d, win, op) => this._dragBegin(win, op));
        cleanup.connect(global.display, 'grab-op-end', (_d, win) => this._dragEnd(win));
        WindowState.watch(cleanup, (win, flag) => {
            const info = win && SET_ASIDE.includes(flag) ? this._desktop.model.window(win.get_stable_sequence()) : null;
            if (info)
                this._changed(info);
        });

        ks.watch(VIEW_KEYS, () => this._layoutChanged());
        ks.watch(CONFIG_KEYS, () => this._send({ type: 'config', config: this._config() }));
        ks.watch(['stage-manager-strip-background'], () => this._view.setBackground(ks.bool('stage-manager-strip-background')));
        for (const [key, fn] of SHORTCUTS)
            Keybindings.add(cleanup, key, ctx.settings, () => fn(this));

        this._init();
    }

    disable() {
        // Everything is in the cleanup registry
    }

    // ---- public API (Show Desktop, Control Center, the dock) ----------------------------------

    /** True while the desktop of the active workspace is shown. */
    get isDesktopShown() {
        return this._model?.desktopShown() ?? false;
    }

    /** Show the desktop (the stage goes to the strip), or bring the stage back. */
    toggleDesktop() {
        if (this._model && !Main.overview.visible)
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
        if (!this._model || !app)
            return;
        this._send({ type: 'join-next', appId });
        if (app.get_n_windows() > 0)
            app.activate();
        else
            app.open_new_window(-1);
    }

    // ---- events in ----------------------------------------------------------------------------

    _config() {
        const ks = this._ks;
        return {
            allAtOnce: ks.bool('stage-manager-group-by-app'),
            newWindows: ks.string('stage-manager-new-windows'),
            showRecent: ks.bool('stage-manager-show-recent'),
            autohide: ks.bool('stage-manager-autohide'),
        };
    }

    _send(event) {
        if (!this._model)
            return;
        this._apply(this._model.dispatch({ now: nowMs(), ...event }));
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
        this._view.setVisible(this._model.stripVisible, false);
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
        // A window first shown on this workspace has mapped now
        for (const id of [...this._pending]) {
            const actor = this._desktop.metaWindow(id)?.get_compositor_private();
            if (actor?.mapped)
                this._mapped(actor.meta_window);
        }
        this._send({ type: 'workspace', active });
    }

    _removeFocused() {
        const id = this._desktop.model.focusedWindow?.id;
        if (id !== undefined && this._model?.isManaged(id))
            this._send({ type: 'unset', id });
    }

    // ---- effects out --------------------------------------------------------------------------

    _apply(effects) {
        let thumbsBefore = null;
        const animate = { hide: new Set(), show: new Set() };
        for (const f of effects) {
            if (f.type === 'strip')
                thumbsBefore ??= this._view.thumbRects();
            else if (f.type === 'hide' && f.animate)
                f.ids.forEach(id => animate.hide.add(id));
            else if (f.type === 'show' && f.animate)
                f.ids.forEach(id => animate.show.add(id));
        }
        if (effects.some(f => f.type === 'strip'))
            this._render();
        for (const f of effects) {
            if (f.type === 'timer')
                this._startTimer(f.key, f.ms);
            else if (f.type === 'cancel')
                this._stopTimer(f.key);
        }
        this._reconcile(animate, thumbsBefore);
        for (const f of effects) {
            if (f.type === 'focus')
                this._focus(f.id);
            else if (f.type === 'strip-visible')
                this._view.setVisible(f.visible);
        }
        this._syncGeometryWatch();
    }

    _startTimer(key, ms) {
        this._stopTimer(key);
        this._timers.set(key, this._cleanup.timeout(ms, () => {
            this._timers.delete(key);
            this._send({ type: 'timer', key });
            return GLib.SOURCE_REMOVE;
        }, { name: `stage-manager-${key}` }));
    }

    _stopTimer(key) {
        const token = this._timers.get(key);
        if (token === undefined)
            return;
        this._cleanup.release(token);
        this._timers.delete(key);
    }

    _focus(id) {
        const win = id === null ? null : this._desktop.metaWindow(id);
        if (!win || win.minimized || global.display.focus_window === win)
            return;
        win.activate(global.get_current_time());
    }

    // Make the windows look like the model says: hidden ones invisible, the rest as they are.
    // Idempotent and complete, so it also repairs what a missed signal left behind (SM-33).
    _reconcile(animate, thumbsBefore) {
        const hidden = this._model.hiddenIds();
        for (const info of this._desktop.model.windows({ userFacing: false })) {
            const win = this._desktop.metaWindow(info.id);
            if (!win || this._pending.has(info.id))
                continue;
            const want = hidden.has(info.id);
            if (want === this._hider.isHidden(win))
                continue;
            if (want)
                this._hide(win, animate.hide.has(info.id));
            else
                this._show(win, animate.show.has(info.id), thumbsBefore?.get(win) ?? null);
        }
    }

    _hide(win, animated) {
        const actor = win.get_compositor_private();
        const visible = !!actor && actor.mapped && actor.opacity > 0 && !win.minimized;
        const from = this._flights.land(win) ?? { ...rectOf(win.get_frame_rect()), angle: 0 };
        if (!this._hider.hide(win))
            return;
        const to = this._view.thumbRect(win);
        if (animated && visible && to) {
            this._view.setFlying(win, true);
            if (!this._flights.fly(win, { from, to, toStage: false }))
                this._view.setFlying(win, false);
        }
    }

    _show(win, animated, thumb) {
        const from = this._flights.land(win) ?? thumb ?? this._edgePoint(win);
        const fly = animated && !!from && !win.minimized;
        const opacity = this._hider.show(win, { keepTransparent: fly }) ?? 255;
        if (fly) {
            const to = { ...rectOf(win.get_frame_rect()), angle: 0 };
            if (!this._flights.fly(win, { from, to, toStage: true, opacity }))
                win.get_compositor_private().opacity = opacity;
        }
    }

    // A window with no strip slot flies from the strip's edge
    _edgePoint(win) {
        const wa = this._layout.workArea(this._layout.primaryIndex);
        if (!wa)
            return null;
        const f = rectOf(win.get_frame_rect());
        const w = 24;
        const h = f.width > 0 ? w * f.height / f.width : w;
        const x = this._side === 'right' ? wa.x + wa.width - 12 : wa.x + 12;
        return { x: x - w / 2, y: wa.y + wa.height / 2 - h / 2, width: w, height: h, angle: 0 };
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

    _render() {
        if (!this._model)
            return;
        const entries = [];
        for (const set of this._model.strip()) {
            const windows = set.windows.map(id => this._desktop.metaWindow(id)).filter(Boolean);
            if (windows.length === 0)
                continue;
            const apps = [...new Set(windows.map(w => this._tracker.get_window_app(w)).filter(Boolean))];
            entries.push({ id: set.id, windows, set: apps.length > 1, app: apps[0] ?? null, names: apps.map(a => a.get_name()) });
        }
        this._view.update({
            side: this._side, entries, tilt: this._ks.int('stage-manager-tilt'),
            workArea: this._layout.workArea(this._layout.primaryIndex),
        });
        this._syncOverlap();
    }

    // Visible windows on the stage of the active workspace (the managed ones and their dialogs)
    _stageWindows() {
        const out = [];
        for (const id of this._model.stageWindows()) {
            const win = this._desktop.metaWindow(id);
            if (win && !win.minimized)
                out.push(win);
        }
        return out;
    }

    // Does a stage window cover the strip's area? The model decides what that does (SM-16).
    _syncOverlap() {
        const floor = this._view.band;
        const workArea = this._layout.workArea(this._layout.primaryIndex);
        const on = !!floor && this._stageWindows().some(win =>
            overlaps(stageRect(rectOf(win.get_frame_rect()), isMaximized(win), workArea), floor));
        if (on === this._overlapped)
            return;
        this._overlapped = on;
        this._send({ type: 'overlap', on });
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
                this._cleanup.connect(win, 'notify::maximized-horizontal', queue),
            ]);
        }
        this._syncOverlap();
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
            this._syncOverlap();
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
        const onWallpaper = global.stage.get_event_actor(event) instanceof Meta.BackgroundActor;
        const [x, y] = event.get_coords();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            this._press = onWallpaper && !Main.overview.visible && Main.modalCount === 0
                ? { x, y, time: event.get_time() } : null;
            return Clutter.EVENT_PROPAGATE;
        }
        const press = this._press;
        this._press = null;
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

    // A stage window moved by its titlebar and dropped on the strip goes to the strip (SM-25).
    // Resizes never get here.
    _dragBegin(win, op) {
        const moving = op === Meta.GrabOp.MOVING || op === Meta.GrabOp.MOVING_UNCONSTRAINED ||
            op === Meta.GrabOp.KEYBOARD_MOVING;
        const id = win?.get_stable_sequence?.();
        this._drag = moving && id !== undefined && this._model?.stageWindows().includes(id) && this._model.isManaged(id)
            ? { win, frame: rectOf(win.get_frame_rect()) } : null;
    }

    _dragEnd(win) {
        const drag = this._drag;
        this._drag = null;
        const band = this._view.band;
        if (!drag || drag.win !== win || !band || !this._model)
            return;
        const [x, y] = global.get_pointer();
        if (!overlaps({ x, y, width: 1, height: 1 }, band))
            return;
        // Once Mutter has ended the grab (focus changes are refused during it)
        this._cleanup.idle(() => {
            win.move_frame(true, drag.frame.x, drag.frame.y);
            this._send({ type: 'stash', id: win.get_stable_sequence() });
            return GLib.SOURCE_REMOVE;
        }, { name: 'stage-manager-drop' });
    }
}
