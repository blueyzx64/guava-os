// SPDX-License-Identifier: GPL-3.0-or-later
// The notch actors. No state logic: index.js feeds render() the view model from
// stateMachine.view() plus what the pages need to show, and gets clicks back through handlers.
//
//   - `placeholder` sits in the panel's centre box (PanelLayout) and only reserves room.
//   - `island` is the black pill. It lives in the top chrome so it can grow below the bar and
//     take input there. It is centred on the primary monitor and glued to its top edge.
//   - two `ears` flank the island's top corners: the small concave fillets where a MacBook
//     notch flares into the screen's top edge. They are siblings of the island (it clips to its
//     allocation), pinned to its edges by snap constraints so they follow every frame of the
//     grow and shrink animations, and painted in the island's own background colour.
//
// Motion (core/motion): the shape springs (a little overshoot growing, none shrinking); the new
// content fades in once the shape is most of the way there and the old one fades out at once,
// so text never shows squeezed. Pages keep the size of their target shape and stay centred
// while the island springs around them (it clips), so nothing reflows mid-animation. Tabs of
// the expanded view share one shape; switching slides the body in from the side of the tab.
// The three tab bodies are built once (the other two when the main loop is idle) and parked
// hidden, so a switch only animates; a body is rebuilt when its data changed.
//
// Idle cost: no timers or animations run unless something is shown that moves (the playing
// waveform, a countdown, the open dashboard's clock and scrubber).

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import * as A11y from '../../lib/a11y.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { SIZES } from './stateMachine.js';
import { cardSize } from './dashboardModel.js';
import { tabDirection, TABS } from './model.js';
import { label, icon, themed, button, artwork, track, CenterLayout } from './ui.js';
import { pill, tickMs } from './pills.js';
import { OutsideClick } from '../../lib/outsideClick.js';
import { InputRing } from '../../lib/inputRing.js';
import { nowTab, trayTab, widgetsTab, DASH_SIZE } from './tabs.js';

// Springs in SwiftUI terms (core/motionModel.js): grow with a slight overshoot, shrink without
const GROW_SPRING = Object.freeze({ response: 0.42, damping: 0.8 });
const SHRINK_SPRING = Object.freeze({ response: 0.32, damping: 1 });
const TAB_SPRING = Object.freeze({ response: 0.34, damping: 1 });
const CONTENT_DELAY_MS = 150;    // the shape is ~85 % there
const LIVE_TICK_MS = 1000;       // clocks, countdowns and the scrubber while shown
const BARS = 4;
const BAR_HEIGHT = 16;
const BAR_TICK_MS = 300;
const BAR_REST = [0.38, 0.75, 0.56, 0.31];   // waveform scale when paused or without motion
const BAR_PEAK = [0.62, 1, 0.88, 0.56];
const BAR_FLOOR = 0.25;
const EAR_RADIUS = 10;   // the fillet where the notch meets the top edge, logical px
const TAB_SLIDE = 24;    // px the tab body travels when switching

export class NotchView {
    /**
     * @param {CleanupRegistry} cleanup everything made here is released on dispose
     * @param {object} handlers {onClick, onDismiss, onHover(bool), onExpand, onAction(id, index),
     *   onMedia('previous'|'toggle'|'next'), onToggleDnd, onToggleMic, onCopy(entryId), onCollapse,
     *   onOpenNotification(notification), onOpenList, onSeek(fraction 0..1), onTab(tab),
     *   onActivityAction(activity, id), onShelf(action, uri), onShelfLayout(layout|null), isShelfHelperWindow(window), onTimerPreset(minutes),
     *   onOpenWeather, onOpenCalendar, getPosition(): Promise<number|null>}
     * @param {function(string): string} gettext
     * @param {import('../../core/motion.js').Motion} motion
     */
    constructor(cleanup, handlers, gettext, motion) {
        this._cleanup = cleanup;
        this._h = handlers;
        this._ = gettext;
        this._motion = motion;
        this._destroyed = false;
        this._signature = null;
        this._kind = null;
        this._content = null;
        this._page = null;
        this._dash = null;           // {page, buttons, holder, bodies: Map(tab -> {actor, sig, live}),
                                     //  current, tab, live, prebuild}
        this._barTimer = 0;
        this._liveTimer = 0;
        this._liveMs = null;         // the current pill's refresh interval (pills.js tickMs)
        this._springs = [];          // core/motion handles of the shape
        this._fade = null;
        this._size = SIZES.idle;
        this._ears = null;
        this._pinned = false;        // a clicked (pinned) dashboard is open
        this._open = false;          // a dashboard (pinned or hover-opened) is open
        this._captureId = 0;         // stage 'captured-event' (Escape) while pinned
        this._focusId = 0;           // display 'notify::focus-window' while pinned
        this._outside = null;        // OutsideClick: the press anywhere outside the dashboard
        this._focusedWindow = null;  // the window that had the input focus when it opened
        this._pressOnSurface = false;
        // Where the pointer is, by source: the island, its input plate (while the shelf helper's
        // window is under the shelf the island gives up its own input) and that window
        this._hoverSrc = { island: false, plate: false, helper: false };
        this._hoverOn = false;
        this._shelfDrag = false;     // the helper's window is under the shelf: tiles are its to take
        this._plate = null;
        this._dragging = false;      // a drag from the shelf is running
        this._layout = null;         // shelfLayout() as last reported
        this._hoverIntent = { enabled: true, delayMs: 300 };
        this._hoverTimer = 0;
        this._anim = new CleanupRegistry();   // owner of running animations, disposed with the view

        this.placeholder = new St.Widget({
            style_class: 'guava-notch-placeholder',
            width: SIZES.idle.w + 8,
            height: 1,
            y_expand: true,
            reactive: false,
        });
        cleanup.add(() => this.placeholder.destroy());

        this._island = new St.Widget({
            name: 'guava-notch',
            style_class: 'guava-notch',
            layout_manager: new CenterLayout(),
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            width: SIZES.idle.w,
            height: SIZES.idle.h,
            accessible_name: gettext('Notch'),
            accessible_role: A11y.Role.PANEL,
        });
        Main.layoutManager.addTopChrome(this._island);
        // Keyboard entry: Ctrl+Alt+Tab lists the notch; choosing it opens the dashboard (which
        // takes the key focus), where Tab and the arrows walk the tabs and buttons
        A11y.focusGroup(cleanup, this._island, gettext('Notch'), 'view-pin-symbolic', {
            focus: () => {
                if (!this._pinned)
                    this._h.onClick?.();
                this._island.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            },
        });
        cleanup.add(() => {
            this._destroyed = true;
            this._page = null;
            this._dropDash();
            this._stopShape();
            this._stopTimers();
            this._cancelHoverIntent();
            this._interface = null;
            this._unwatchKeys();
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
        });
        // Added after the island's cleanup, so it runs before it (newest first): the animations
        // are cancelled while their actors still exist
        cleanup.add(() => this._anim.dispose());

        cleanup.connect(this._island, 'notify::hover', () => {
            const hover = this._island.hover;
            this._hoverSrc.island = hover;
            this._emitHover();
            if (hover)
                this._startHoverIntent();
            else
                this._cancelHoverIntent();
        });
        // A press or release on a button inside the card belongs to that button. Bubbling up
        // here it used to count as a click on the notch too, which collapsed the dashboard
        // and destroyed the button before it could emit 'clicked'.
        cleanup.connect(this._island, 'button-press-event', (_a, event) => {
            this._pressOnSurface = !this._onControl(this._eventActor(event));
            return this._pressOnSurface ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });
        cleanup.connect(this._island, 'button-release-event', (_a, event) =>
            this._surfaceRelease(event, this._pressOnSurface && !this._onControl(this._eventActor(event))));
        cleanup.connect(Main.layoutManager, 'monitors-changed', () => this._place(this._size, false));

        this._addEars();
        // The island and its ears stay above the catcher
        this._outside = new OutsideClick(cleanup, 'guava-notch-catcher', [...this._ears, this._island], () => this._h.onCollapse?.());
        this._plate = new InputRing(cleanup, 'guava-notch-plate', {
            press: () => {
                this._pressOnSurface = true;
                return Clutter.EVENT_STOP;
            },
            release: event => this._surfaceRelease(event, this._pressOnSurface),
            hover: on => {
                this._hoverSrc.plate = on;
                this._emitHover();
            },
        });
        this._place(SIZES.idle, false);
    }

    // A release that ends a press on the notch itself (not on a button): a click on the card
    _surfaceRelease(event, own) {
        this._pressOnSurface = false;
        if (!own)
            return Clutter.EVENT_PROPAGATE;
        this._cancelHoverIntent();
        if (event.get_button() === Clutter.BUTTON_SECONDARY)
            this._h.onDismiss();
        else
            this._h.onClick();
        return Clutter.EVENT_STOP;
    }

    // One hover value for the state machine, from every place the pointer can be on the notch
    _emitHover() {
        const on = Object.values(this._hoverSrc).some(Boolean);
        if (on === this._hoverOn)
            return;
        this._hoverOn = on;
        this._h.onHover(on);
    }

    /** The pointer is on the shelf helper's window, or a drag from it is running. */
    setHelperHover(on) {
        this._hoverSrc.helper = on;
        this._emitHover();
    }

    /** @param {{enabled: boolean, delayMs: number}} intent hover-to-expand settings */
    setHoverIntent(intent) {
        this._hoverIntent = { ...intent };
        if (!intent.enabled)
            this._cancelHoverIntent();
    }

    _startHoverIntent() {
        this._cancelHoverIntent();
        if (!this._hoverIntent.enabled)
            return;
        this._hoverTimer = this._cleanup.timeout(Math.max(1, this._hoverIntent.delayMs), () => {
            this._hoverTimer = 0;
            if (!this._destroyed && this._island.hover)
                this._h.onExpand();
            return GLib.SOURCE_REMOVE;
        }, { name: 'notch hover intent' });
    }

    _cancelHoverIntent() {
        if (this._hoverTimer)
            this._cleanup.release(this._hoverTimer);
        this._hoverTimer = 0;
    }

    get actor() {
        return this._island;
    }

    // The actor the pointer is on. Clutter.Event.get_source() is gone since GNOME 45.
    _eventActor(event) {
        return global.stage.get_event_actor?.(event) ?? event.get_source?.() ?? null;
    }

    /** True if `actor` is, or sits inside, a reactive button of the current page. */
    _onControl(actor) {
        for (let a = actor; a && a !== this._island; a = a.get_parent()) {
            if (a instanceof St.Button && a.reactive)
                return true;
        }
        return false;
    }

    // ---- outside click and Escape ---------------------------------------------------------
    // While a dashboard is open, opened by hover or pinned by a click, a press outside it
    // collapses it and goes on to whatever was pressed (outsideClick.js says how). A pinned
    // dashboard also takes the key focus, like a panel menu minus the grab, and watches the
    // stage for Escape, which collapses it and stops there.

    _syncOutside() {
        const shown = this._open && this._island.visible;
        // Not during a drag from the shelf: the windows must be under the pointer for the drop
        if (shown && !this._dragging)
            this._outside.start(this._shelfDrag ? this._dashboardRect() : null);
        else
            this._outside.stop();
        if (shown && this._pinned)
            this._watchKeys();
        else
            this._unwatchKeys();
    }

    _watchKeys() {
        if (this._captureId || this._destroyed)
            return;
        this._captureId = global.stage.connect('captured-event', (_s, event) => this._onCaptured(event));
        // A window taking the focus by the keyboard also closes it
        this._focusId = global.display.connect('notify::focus-window', () => {
            const focused = global.display.focus_window;
            if (focused && !this._h.isShelfHelperWindow?.(focused))
                this._h.onCollapse?.();
        });
        // The keyboard goes to the island: the window gives up the input focus and gets it back
        // when the dashboard closes, unless another one was focused meanwhile
        this._focusedWindow = global.display.focus_window;
        global.display.unset_input_focus(global.get_current_time());
        this._island.grab_key_focus();
    }

    _unwatchKeys() {
        if (!this._captureId)
            return;
        global.stage.disconnect(this._captureId);
        this._captureId = 0;
        global.display.disconnect(this._focusId);
        this._focusId = 0;
        const window = this._focusedWindow;
        this._focusedWindow = null;
        const focused = global.display.focus_window;
        if (window && !this._destroyed && (!focused || this._h.isShelfHelperWindow?.(focused)))
            window.activate(global.get_current_time());
    }

    _onCaptured(event) {
        if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._h.onCollapse?.();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- shelf drag-out -------------------------------------------------------------------
    // A Shell actor cannot start a Wayland drag, so index.js runs the shelf helper
    // (shelfHelper.js), whose transparent window goes exactly over the shelf's tiles. Once
    // that window is placed, setShelfDrag(true) lets presses on the tiles fall through to it:
    // the island and the tiles stop taking input there, an input plate under the island takes
    // over everywhere else on the dashboard (clicks and hover), and the outside-click layer
    // leaves the dashboard alone.

    _dashboardRect() {
        const m = this._monitor();
        return { x: m.x + Math.round((m.width - DASH_SIZE.w) / 2), y: m.y, w: DASH_SIZE.w, h: DASH_SIZE.h };
    }

    // Where the shelf's tiles are on screen (stage px) once the dashboard has settled on the
    // Tray tab, else null. The helper's window is placed from this.
    _shelfLayout() {
        const dash = this._dash;
        if (!this._open || !dash || dash.tab !== 'tray' || dash.sliding || this._springs.some(sp => sp.running))
            return null;
        const shelf = dash.current?.shelf;
        if (!shelf?.tiles.length || !shelf.grid.mapped)
            return null;
        const at = a => {
            const [x, y] = a.get_transformed_position();
            const [w, h] = a.get_transformed_size();
            return { x, y, w, h };
        };
        return { box: at(shelf.grid), tiles: shelf.tiles.map(t => ({ uri: t.uri, icon: t.icon, ...at(t.actor) })) };
    }

    _reportShelf() {
        if (this._destroyed)
            return;
        this._layout = this._shelfLayout();
        if (!this._layout)
            this.setShelfDrag(false);
        this._h.onShelfLayout?.(this._layout);
    }

    /** @param {boolean} on a drag from the shelf is running: nothing of the notch may sit on the windows */
    setDragging(on) {
        if (this._destroyed || on === this._dragging)
            return;
        this._dragging = on;
        this._syncPlate();
        this._syncOutside();
    }

    // The input plate stands in for the island while the helper's window is under the shelf. Not
    // during the drag itself: the dashboard sits over the top of the window below (a maximized
    // window, or one touching the top bar, reaches right under it), and a drop there must reach
    // that window, so nothing of the notch may take the pointer then.
    _syncPlate() {
        if (this._shelfDrag && !this._dragging) {
            this._plate.place(this._dashboardRect(), this._layout.box);
            this._plate.restack([...this._ears, this._island]);
            return;
        }
        this._plate.hide();
        this._hoverSrc.plate = false;
    }

    /** @param {boolean} on the helper's window is placed over the tiles (or is gone) */
    setShelfDrag(on) {
        if (this._destroyed)
            return;
        on = on && !!this._layout;
        if (on === this._shelfDrag)
            return;
        this._shelfDrag = on;
        this._island.reactive = !on;
        this._dash?.current?.shelf?.tiles.forEach(t => {
            t.actor.reactive = !on;
        });
        if (on)
            this._hoverSrc.island = false;
        this._syncPlate();
        this._emitHover();
        this._syncOutside();
    }

    // ---- ears -----------------------------------------------------------------------------
    // Each ear is an EAR_RADIUS square just outside one top corner of the island, filled with
    // the island's background colour minus a quarter circle centred on the ear's outer bottom
    // corner. The island's top corners are square, so ear and island share one straight edge
    // and the black runs from the island's side into the top edge along a smooth arc.
    // The ears touch the island but never overlap it, so a translucent fill is not doubled
    // along the seam. Snap constraints put both edges of each ear on the island's allocation
    // (fractional while it eases), so there is no gap at any width.

    _addEars() {
        const parent = this._island.get_parent();
        const edge = Clutter.SnapEdge;
        const snap = (ear, from, to, offset) => ear.add_constraint(new Clutter.SnapConstraint({
            source: this._island, from_edge: from, to_edge: to, offset,
        }));
        this._ears = ['left', 'right'].map(side => {
            const ear = new St.DrawingArea({
                name: `guava-notch-ear-${side}`,
                style_class: 'guava-notch-ear',
                reactive: false,
            });
            ear.connect('repaint', () => this._paintEar(ear, side));
            parent.insert_child_below(ear, this._island);
            if (side === 'left') {
                snap(ear, edge.RIGHT, edge.LEFT, 0);
                snap(ear, edge.LEFT, edge.LEFT, -EAR_RADIUS);
            } else {
                snap(ear, edge.LEFT, edge.RIGHT, 0);
                snap(ear, edge.RIGHT, edge.RIGHT, EAR_RADIUS);
            }
            snap(ear, edge.TOP, edge.TOP, 0);
            snap(ear, edge.BOTTOM, edge.TOP, EAR_RADIUS);
            // Shown, hidden and faded with the island
            this._island.bind_property('visible', ear, 'visible', GObject.BindingFlags.SYNC_CREATE);
            this._island.bind_property('opacity', ear, 'opacity', GObject.BindingFlags.SYNC_CREATE);
            return ear;
        });
        // A theme or Glass change to the island's fill repaints the ears in the same colour
        this._cleanup.connect(this._island, 'style-changed', () => this._ears?.forEach(e => e.queue_repaint()));
        this._cleanup.add(() => {
            this._ears?.forEach(e => e.destroy());
            this._ears = null;
        });
    }

    _paintEar(ear, side) {
        const cr = ear.get_context();
        try {
            const [w, h] = ear.get_surface_size();
            const c = this._island.get_theme_node().get_background_color();
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            // The square, minus the circle of radius w centred on the outer bottom corner
            const cx = side === 'left' ? 0 : w;
            cr.newPath();
            cr.rectangle(0, 0, w, h);
            cr.arc(cx, h, w, 0, 2 * Math.PI);
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }


    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _stopShape() {
        const springs = this._springs;
        this._springs = [];
        springs.forEach(s => s.cancel());
    }

    _place(size, animate) {
        if (this._destroyed)
            return;
        this._size = size;
        const monitor = this._monitor();
        if (!monitor)
            return;
        const island = this._island;
        island.style = `border-radius: 0 0 ${size.r}px ${size.r}px;`;
        this._stopShape();
        island.y = monitor.y;
        const x = monitor.x + Math.round((monitor.width - size.w) / 2);
        if (!animate || !island.mapped) {
            island.set_size(size.w, size.h);
            island.x = x;
            return;
        }
        // Three springs on one curve (core/motion: reduced motion and animations-off jump to
        // the end). The position springs with the size, so the island stays centred on every
        // frame without a handler moving it from inside the allocation.
        const growing = size.w * size.h > island.width * island.height;
        const request = { spring: growing ? GROW_SPRING : SHRINK_SPRING };
        this._springs = [
            this._motion.spring(island, 'width', size.w,
                { ...request, onDone: finished => finished && this._reportShelf() }, this._anim),
            this._motion.spring(island, 'height', size.h, request, this._anim),
            this._motion.spring(island, 'x', x, request, this._anim),
        ];
    }

    /** @param {boolean} show the island is on screen at all (bar visible, not hidden by fullscreen) */
    setShown(show) {
        if (this._destroyed)
            return;
        this._island.visible = show;
        this._syncOutside();
    }

    /**
     * @param {object} vm stateMachine.view(state)
     * @param {object} ctx {notification, media, dnd, count, recent, clipboard, shelf, selected,
     *   widgets: {events, weather, mic, dnd, focus (features/focus state()), timersEnabled}}
     */
    render(vm, ctx) {
        if (this._destroyed)
            return;
        const n = ctx.notification;
        const dashboard = vm.kind === 'expanded' && vm.content === 'dashboard';
        const signature = this._signatureOf(vm, ctx, dashboard);
        if (signature === this._signature)
            return;
        this._signature = signature;

        // The dashboard stays and only its body changes: a tab switch, or new data in a tab
        if (dashboard && this._dash && this._page === this._dash.page) {
            this._open = true;
            this._pinned = !!vm.pinned;
            this._syncOutside();
            this._updateDashboard(vm, ctx);
            this._reportShelf();
            return;
        }

        const shapeChanged = this._kind !== vm.kind || this._content !== vm.content ||
            (vm.kind === 'live-activity' && this._size.w !== vm.size.w);
        this._kind = vm.kind;
        this._content = vm.content;

        let size = dashboard ? DASH_SIZE : vm.size;
        if (vm.kind === 'expanded' && !dashboard && n)
            size = cardSize({ actions: (n.actions?.length ?? 0) > 0 });
        const growing = size.w * size.h > this._island.width * this._island.height;

        this._place(size, true);
        this._open = dashboard;
        this._pinned = dashboard && !!vm.pinned;
        this._syncOutside();

        const old = this._page;
        this._page = null;
        this._dropDash();
        this._liveMs = null;
        this._stopTimers();
        if (old)
            this._retire(old, shapeChanged);
        let page;
        const live = [];
        try {
            page = this._build(vm, ctx, live);
        } catch (e) {
            // Never leave a half-built page behind; draw an empty pill and retry next time.
            console.error('[Guava] notch page failed:', e);
            this._stopTimers();
            this._signature = null;
            this._dropDash();
            page = new St.Widget();
        }
        this._page = page;
        page.set_size(size.w, size.h);
        this._island.add_child(page);
        // A dashboard's refreshers live with its tab body (_fillDashboard)
        if (this._dash)
            this._startLive(page, this._dash.live);
        else
            this._startLive(page, live, this._liveMs ?? LIVE_TICK_MS);
        this._reportShelf();
        if (shapeChanged) {
            // The content arrives once the shape is nearly there; a slight drop from above
            // reads as coming out of the notch.
            page.opacity = 0;
            page.translation_y = growing ? -6 : 0;
            this._motion.ease(page, { opacity: 255, translation_y: 0 }, {
                duration: 'short', curve: 'standard', delay: growing ? CONTENT_DELAY_MS : 40,
            }, this._anim);
        }
    }

    // What the current page depends on, as one string (render() skips an identical frame)
    _signatureOf(vm, ctx, dashboard) {
        const n = ctx.notification;
        let dash = null;
        if (dashboard) {
            dash = [vm.tab, vm.pinned, vm.dropping, ctx.dnd, this._tabData(vm.tab, vm, ctx)];
        }
        return JSON.stringify([
            vm.kind, vm.content, vm.notificationId, vm.badge,
            dashboard ? null : vm.activity?.key ?? null, dashboard ? null : vm.activity?.data ?? null,
            vm.kind === 'live-activity' ? vm.activity?.kind : null,
            vm.osd?.kind, vm.osd?.level, vm.osd?.label,
            dash,
            n ? [n.title, n.body, n.actions?.length ?? 0] : null,
        ]);
    }

    // What one tab's body depends on, plain data (its signature in the tab cache)
    _tabData(tab, vm, ctx) {
        if (tab === 'now') {
            const media = ctx.media ? { ...ctx.media, appIcon: undefined } : null; // icons are not JSON
            const acts = (vm.activities ?? []).map(a => [a.key, a.kind, a.data]);
            return [media, acts, ctx.count, (ctx.recent ?? []).map(r => [r.title, r.app, r.when, r.body])];
        }
        if (tab === 'tray') {
            return [ctx.clipboard, ctx.selected, ctx.shelf.clipboardHasFiles,
                ctx.shelf.uris.map(u => [u, ctx.shelf.info(u).name, ctx.shelf.info(u).missing, !!ctx.shelf.info(u).gicon])];
        }
        return [ctx.widgets];
    }

    _stopTimers() {
        for (const key of ['_barTimer', '_liveTimer']) {
            if (this[key])
                this._cleanup.release(this[key]);
            this[key] = 0;
        }
    }

    // The old page fades out quickly while the shape changes, and takes no more clicks.
    _retire(old, fade, extra = {}) {
        const walk = a => {
            if (a instanceof St.Button)
                a.reactive = false;
            a.get_children().forEach(walk);
        };
        walk(old);
        if (!fade) {
            old.destroy();
            return;
        }
        this._motion.ease(old, { opacity: 0, ...extra }, {
            duration: 'micro', curve: 'enter',
            onDone: () => {
                if (!this._destroyed && old.get_parent())
                    old.destroy();
            },
        }, this._anim);
    }

    _build(vm, ctx, live) {
        switch (vm.kind) {
        case 'live-activity': return this._activityPage(vm.activity, ctx, live);
        case 'osd': return this._osdPage(vm.osd);
        case 'compact': return this._compactPage(ctx.notification, vm.badge);
        case 'expanded':
            return vm.content === 'dashboard'
                ? this._dashboardPage(vm, ctx)
                : this._cardPage(vm.notificationId, ctx.notification, vm.badge);
        default:
            return new St.Widget();
        }
    }

    // ---- dashboard: header with tabs, then the body of the current tab --------------------

    _dashboardPage(vm, ctx) {
        const page = new St.BoxLayout({
            style_class: 'guava-notch-dash',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const header = new St.BoxLayout({ style_class: 'guava-notch-dash-header' });
        const tabs = new St.BoxLayout({ style_class: 'guava-notch-tabs', x_expand: true });
        const names = { now: this._('Now'), tray: this._('Tray'), widgets: this._('Widgets') };
        const buttons = new Map();
        for (const tab of TABS) {
            const b = button({
                styleClass: 'guava-notch-tab', text: names[tab], accessibleName: names[tab],
                toggle: tab === vm.tab, onClick: () => this._h.onTab(tab),
            });
            b.accessible_role = A11y.Role.PAGE_TAB;
            buttons.set(tab, b);
            tabs.add_child(b);
        }
        header.add_child(tabs);
        header.add_child(label(GLib.DateTime.new_now_local().format('%a %e %b').replace(/\s+/g, ' '), 'guava-notch-dash-date'));
        page.add_child(header);
        const holder = new St.Widget({
            style_class: 'guava-notch-dash-holder', layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true, clip_to_allocation: true,
        });
        page.add_child(holder);
        this._dash = { page, buttons, holder, bodies: new Map(), current: null, tab: null, live: [], prebuild: 0, sliding: false };
        this._fillDashboard(vm, ctx);
        return page;
    }

    _dropDash() {
        if (this._dash?.prebuild)
            this._cleanup.release(this._dash.prebuild);
        this._dash = null;
    }

    _updateDashboard(vm, ctx) {
        this._stopTimers();
        this._fillDashboard(vm, ctx);
        this._startLive(this._dash.page, this._dash.live);
    }

    // Show the body of the tab. A switch slides the old body out and the new one in; both are
    // already built (see _tabBody), so it only animates.
    _fillDashboard(vm, ctx) {
        const dash = this._dash;
        const from = dash.tab;
        dash.tab = vm.tab;
        for (const [tab, b] of dash.buttons)
            b.checked = tab === vm.tab;
        const old = dash.current;
        const entry = this._tabBody(vm.tab, vm, ctx);
        dash.current = entry;
        dash.live = entry.live;
        this._prebuildTabs(vm, ctx);
        const switching = !!old && old.tab !== vm.tab;
        dash.sliding = switching;
        if (!switching) {
            entry.actor.visible = true;
            return;
        }
        const dir = tabDirection(from, vm.tab);
        // One critically damped spring carries the body sideways while it fades; no overshoot,
        // so the slide settles without a visible reversal
        const slide = (actor, to, onDone) => {
            this._motion.ease(actor, { opacity: to.opacity }, { duration: 'short', curve: 'standard' }, this._anim);
            this._motion.spring(actor, 'translation_x', to.translation_x, { spring: TAB_SPRING, onDone }, this._anim);
        };
        slide(old.actor, { opacity: 0, translation_x: -dir * TAB_SLIDE }, () => {
            if (!this._destroyed && dash.current !== old)
                old.actor.visible = false;
        });
        const actor = entry.actor;
        actor.remove_all_transitions();
        actor.set({ visible: true, opacity: 0, translation_x: dir * TAB_SLIDE });
        slide(actor, { opacity: 255, translation_x: 0 }, finished => {
            if (!finished || this._destroyed || this._dash !== dash)
                return;
            dash.sliding = false;
            this._reportShelf();
        });
    }

    // The tab's body: the built one while its data is unchanged, else a new one (and the old
    // one is destroyed). A new body starts shown; a parked one is hidden.
    _tabBody(tab, vm, ctx) {
        const dash = this._dash;
        const sig = JSON.stringify(this._tabData(tab, vm, ctx));
        const cached = dash.bodies.get(tab);
        if (cached?.sig === sig)
            return cached;
        const live = [];
        const env = {
            _: this._, h: this._h, live, alive: () => !this._destroyed,
            clockFormat: () => this._clockFormat(),
        };
        let actor;
        try {
            actor = tab === 'tray' ? trayTab(env, { ...ctx, dropping: !!vm.dropping })
                : tab === 'widgets' ? widgetsTab(env, ctx.widgets)
                    : nowTab(env, { ...ctx, activities: vm.activities });
        } catch (e) {
            console.error('[Guava] notch tab failed:', e);
            this._signature = null;
            actor = new St.Widget();
        }
        // Fades paint each child with the body's opacity instead of drawing the whole body into
        // an offscreen buffer first (a costly first frame); the children do not overlap
        actor.offscreen_redirect = 0;
        cached?.actor.destroy();
        const entry = { tab, actor, sig, live, shelf: env.shelf ?? null };
        dash.bodies.set(tab, entry);
        dash.holder.add_child(actor);
        return entry;
    }

    // Build the tabs that are not shown yet once the main loop is idle, then hide them after
    // their first layout (style, icons and sizes are done by then), so they cost nothing but
    // memory and a later switch has only the slide left.
    _prebuildTabs(vm, ctx) {
        const dash = this._dash;
        if (dash.prebuild || dash.bodies.size === TABS.length)
            return;
        dash.prebuild = this._cleanup.idle(() => {
            dash.prebuild = 0;
            if (this._destroyed || this._dash !== dash)
                return;
            for (const tab of TABS) {
                if (!dash.bodies.has(tab))
                    this._park(this._tabBody(tab, vm, ctx));
            }
        }, { name: 'notch tabs' });
    }

    _park(entry) {
        const { actor } = entry;
        actor.opacity = 0;
        const token = this._cleanup.connect(global.stage, 'after-update', () => {
            this._cleanup.release(token);
            const dash = this._dash;
            if (dash?.bodies.get(entry.tab) !== entry)
                return; // replaced or gone meanwhile
            if (dash.current !== entry)
                actor.visible = false;
            actor.opacity = 255;
        });
    }

    // ---- small pieces --------------------------------------------------------------------

    _row(styleClass) {
        return new St.BoxLayout({ style_class: `guava-notch-row ${styleClass}` });
    }

    _notificationIcon(notification) {
        return notification.gicon ?? notification.source?.icon ?? themed('dialog-information-symbolic');
    }

    // The music waveform: fixed-height bars scaled about their centre (transforms only, no
    // relayout), moving while playing when motion is allowed.
    _bars(playing) {
        const box = new St.BoxLayout({
            style_class: 'guava-notch-bars', y_align: Clutter.ActorAlign.CENTER,
        });
        const bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({
                style_class: 'guava-notch-bar', height: BAR_HEIGHT, y_align: Clutter.ActorAlign.CENTER,
                pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
                scale_y: BAR_REST[i],
            });
            bars.push(bar);
            box.add_child(bar);
        }
        const env = this._motion.env;
        if (playing && env.animations && !env.reducedMotion) {
            this._barTimer = this._cleanup.timeout(BAR_TICK_MS, () => {
                for (let i = 0; i < bars.length; i++) {
                    const bar = bars[i];
                    if (bar.get_stage() === null)
                        return GLib.SOURCE_REMOVE;
                    bar.ease({
                        scale_y: BAR_FLOOR + Math.random() * (BAR_PEAK[i] - BAR_FLOOR),
                        duration: BAR_TICK_MS,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    });
                }
                return GLib.SOURCE_CONTINUE;
            }, { name: 'notch bars' });
        } else if (!playing) {
            box.add_style_class_name('guava-notch-bars-paused');
        }
        return box;
    }

    // Runs every function in `fns` now and then every `ms` (default a second) while `page` is
    // on screen.
    _startLive(page, fns, ms = LIVE_TICK_MS) {
        if (this._liveTimer)
            this._cleanup.release(this._liveTimer);
        this._liveTimer = 0;
        if (!fns.length)
            return;
        const run = () => fns.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.error('[Guava] notch refresh failed:', e);
            }
        });
        run();
        this._liveTimer = this._cleanup.timeout(ms, () => {
            if (this._destroyed || this._page !== page)
                return GLib.SOURCE_REMOVE;
            run();
            return GLib.SOURCE_CONTINUE;
        }, { name: 'notch live' });
    }

    _clockFormat() {
        try {
            this._interface ??= new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            return this._interface.get_string('clock-format');
        } catch (_e) {
            return '24h';
        }
    }

    // ---- pills -----------------------------------------------------------------------------

    // Music like a compact Dynamic Island: tiny art at the left, the waveform at the right, the
    // title between them. Every other kind comes from pills.js.
    _activityPage(activity, ctx, live) {
        if (activity.kind === 'media' || activity.kind === 'media-paused' || !activity.kind) {
            const data = activity.data;
            const row = this._row('guava-notch-activity guava-notch-pill-media');
            row.add_child(artwork({ art: data.art, appIcon: ctx.media?.appIcon }, 20, 'guava-notch-artwork-small'));
            row.add_child(label(data.title, 'guava-notch-pill-title', { x_expand: true }));
            row.add_child(this._bars(data.playing));
            return row;
        }
        const page = pill(activity, { _: this._, live, onAction: this._h.onActivityAction });
        this._liveMs = tickMs(activity);
        if (this._liveMs === null)
            live.length = 0;
        return page;
    }

    _osdPage(osd) {
        const row = this._row('guava-notch-osd');
        const fallback = osd.kind === 'copied' ? 'edit-paste-symbolic' : 'audio-volume-high-symbolic';
        row.add_child(icon(osd.icon ?? themed(fallback), 16));
        const level = osd.level;
        if (level === null || level === undefined) {
            row.add_child(label(osd.label ?? '', 'guava-notch-pill-title', { x_expand: true }));
            return row;
        }
        const max = osd.maxLevel && osd.maxLevel > 0 ? osd.maxLevel : 1;
        const fraction = Math.max(0, Math.min(1, level / max));
        row.add_child(track('guava-notch-track', 'guava-notch-fill', 6, fraction));
        row.add_child(label(`${Math.round(level * 100)}`, 'guava-notch-value'));
        return row;
    }

    _compactPage(notification, badge) {
        const row = this._row('guava-notch-compact');
        if (!notification)
            return row;
        row.add_child(icon(this._notificationIcon(notification), 18));
        row.add_child(label(notification.title, 'guava-notch-pill-title', { x_expand: true }));
        if (badge > 0)
            row.add_child(label(`+${badge}`, 'guava-notch-badge'));
        return row;
    }

    // ---- notification card -------------------------------------------------------------------

    _cardPage(id, notification, badge) {
        const card = new St.BoxLayout({
            style_class: 'guava-notch-card',
            orientation: Clutter.Orientation.VERTICAL,
            accessible_role: A11y.Role.NOTIFICATION,
        });
        if (!notification)
            return card;
        card.accessible_name = [notification.source?.title, notification.title].filter(Boolean).join(': ');

        const header = new St.BoxLayout({ style_class: 'guava-notch-card-header' });
        header.add_child(icon(this._notificationIcon(notification), 20, 'guava-notch-card-icon'));
        const app = notification.source?.title ?? '';
        const when = notification.datetime?.format?.('%H:%M') ?? '';
        header.add_child(label(app, 'guava-notch-card-app', { x_expand: true }));
        if (badge > 0)
            header.add_child(label(`+${badge}`, 'guava-notch-badge'));
        if (when)
            header.add_child(label(when, 'guava-notch-card-time'));
        const close = new St.Button({
            style_class: 'guava-notch-close',
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 12 }),
            can_focus: true,
            accessible_name: this._('Dismiss'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        close.connect('clicked', () => this._h.onDismiss());
        header.add_child(close);
        card.add_child(header);

        card.add_child(label(notification.title, 'guava-notch-card-title'));
        const body = new St.Label({ style_class: 'guava-notch-card-body', x_expand: true, y_expand: true });
        body.clutter_text.line_wrap = true;
        body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const text = notification.body ?? '';
        // Same as the stock banner (messageList.js URLHighlighter, 48-51): fixMarkup keeps only
        // the tags notifications may use when the sender asked for markup, and escapes everything
        // otherwise, so the result is always safe for set_markup().
        try {
            body.clutter_text.set_markup(Util.fixMarkup(text, !!notification.useBodyMarkup));
        } catch (_e) {
            body.text = text;
        }
        card.add_child(body);

        const actions = (notification.actions ?? []).slice(0, 2);
        if (actions.length) {
            const row = new St.BoxLayout({ style_class: 'guava-notch-actions' });
            actions.forEach((action, index) => {
                const button = new St.Button({
                    style_class: 'guava-notch-action',
                    label: action.label,
                    can_focus: true,
                    x_expand: true,
                });
                button.connect('clicked', () => this._h.onAction(id, index));
                row.add_child(button);
            });
            card.add_child(row);
        }
        return card;
    }
}
