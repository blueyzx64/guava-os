// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager strip: the thumbnails of the sets waiting at the screen edge, and the ways the
// pointer reaches them. Pure drawing and input; what is shown and when comes from the model.
//
//   container  one chrome actor (named guava-stage-manager) holding, in screen coordinates:
//     edge        a 2 px hover strip on the screen edge (SM-17: resting on it reveals)
//     strip       slides in and out (SM-16, SM-18), holds the floor
//     floor       St.Widget .guava-stage-strip: glass backdrop, hover area, the cards
//     card        St.Button .guava-stage-card per set: live Clutter.Clone thumbnails of the
//                 windows at the window's own resolution (SM-20), tilted, stacked; app badge
//     flights     the layer where flights.js flies clones
//   barrier     Meta.Barrier + Layout.PressureBarrier on the edge: a push reveals (SM-17)
//
//     drop        St.Widget .guava-stage-drop over the stage while a thumbnail is dragged onto it;
//                 .guava-stage-drop-card around the thumbnail a dragged window would join (SM-34)
//
// Input out (env): onActivate(setId, {add}), onDropThumb(setId), onEdge(on), onHover(on),
// onPush(), onReveal().
// Private API: none. Main.layoutManager and Layout.PressureBarrier are public Shell modules.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { attachThumbEffect } from './thumbEffect.js';
import { DRAG_PX, dragStarted, thumbDropTarget } from './dragModel.js';
import {
    METRICS, clonePose, edgeBarrier, layerRect, slotBox, stackLayers, stripLayout, tiltAngle,
} from './geometry.js';

const PRESSURE_THRESHOLD = 40;   // px pushed against the edge, as the auto-hide top bar
const PRESSURE_TIMEOUT = 600;
const SLIDE_MS = 220;
const EDGE_PX = 2;
const DRAG_DIM = 70;            // opacity of the thumbnail whose copy is being dragged
const DROP_MS = 140;

export class StripView {
    /**
     * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup
     * @param {object} env
     */
    constructor(cleanup, env) {
        this._cleanup = cleanup;
        this._env = env;
        this._state = { side: 'left', entries: [], tilt: 22, workArea: null };
        this._layout = null;
        this._cards = new Map();     // set id -> St.Button
        this._thumbs = new Map();    // Meta.Window -> {actor, rect}
        this._flying = new Set();    // windows whose thumbnail waits for a flight to land
        this._shown = null;
        this._slide = null;
        this._barrier = null;
        this._barrierKey = '';
        this._dead = false;
        this._drag = null;           // a thumbnail being dragged: {entry, proxy, token, ...}
        this._cardRects = [];        // [{id, rect}] screen rects of the thumbnails

        this.container = new Clutter.Actor({ name: 'guava-stage-manager', reactive: false, width: 1, height: 1 });
        cleanup.actor(this.container);
        this.container.connect('destroy', () => {
            this._dead = true;
            this._thumbs.clear();
        });

        this._edge = new St.Widget({ name: 'guava-stage-edge', reactive: true, track_hover: true, opacity: 0 });
        this._edge.connect('notify::hover', () => env.onEdge(this._edge.hover));
        this.container.add_child(this._edge);

        this._strip = new Clutter.Actor({ reactive: false, visible: false });
        this.container.add_child(this._strip);
        this._floor = new St.Widget({ style_class: 'guava-stage-strip', reactive: true, track_hover: true });
        this._floor.connect('notify::hover', () => env.onHover(this._floor.hover));
        this._strip.add_child(this._floor);
        // The soft glass under the entries, so they read apart from the app behind them
        this._glass = Glass.attach(this._floor, { surface: 'panel', role: 'bar' });
        cleanup.add(() => this._glass.destroy());

        // Keyboard: Ctrl+Alt+Tab lists the strip; choosing it reveals it and focuses its first card
        this._floor.accessible_name = env.gettext('Stage Manager');
        this._floor.accessible_role = A11y.Role.TOOL_BAR;
        A11y.focusGroup(cleanup, this._floor, env.gettext('Stage Manager'), 'view-grid-symbolic', {
            proxy: this.container,
            focus: () => {
                env.onReveal();
                this._floor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            },
        });

        // Drop highlights: the stage a dragged thumbnail would join, the thumbnail a dragged window would join
        this._dropStage = new St.Widget({ style_class: 'guava-stage-drop', reactive: false, visible: false, opacity: 0 });
        this.container.add_child(this._dropStage);
        this._dropCard = new St.Widget({ style_class: 'guava-stage-drop-card', reactive: false, visible: false, opacity: 0 });
        this.container.add_child(this._dropCard);

        this.flightLayer = new Clutter.Actor({ reactive: false });
        this.container.add_child(this.flightLayer);

        this._pressure = new Layout.PressureBarrier(PRESSURE_THRESHOLD, PRESSURE_TIMEOUT, Shell.ActionMode.NORMAL);
        // A held button is a window drag (to an edge to tile): not a reveal
        this._pressure.setEventFilter(() => {
            const [, , mods] = global.get_pointer();
            return (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        });
        this._pressure.connect('trigger', () => env.onPush());
        cleanup.add(() => {
            this._dropBarrier();
            this._pressure.destroy();
        });
        cleanup.add(() => this._slide?.cancel());
        cleanup.add(() => this._endDrag(false, true));
    }

    /** Show or hide the glass backdrop of the strip. */
    setBackground(on) {
        if (!this._dead)
            this._glass.setVisible(on);
    }

    /** The strip's band on screen (the area a dragged window is dropped on), or null. */
    get band() {
        return this._layout?.floor ?? null;
    }

    /**
     * Redraw: entries [{id, windows: Meta.Window[] (lead first), app: ?Shell.App, names, set}].
     * @param {{side?, entries?, tilt?, workArea?}} state
     */
    update(state) {
        if (this._dead)
            return;
        Object.assign(this._state, state);
        const { side, entries, workArea } = this._state;
        if (!workArea)
            return;
        this._layout = stripLayout({ workArea, side, count: entries.length });
        this._placeEdge(workArea, side);
        // A redraw under a drag (the set changed): the drag ends where it is
        this._endDrag(false, true);
        for (const card of this._cards.values())
            card.destroy();
        this._cards.clear();
        this._thumbs.clear();
        const { floor, slots, scale } = this._layout;
        this._cardRects = entries.map((e, i) => ({ id: e.id, rect: slots[i] })).filter(c => c.rect);
        if (!floor) {
            this._floor.visible = false;
            this._dropBarrier();
            return;
        }
        this._floor.visible = true;
        this._floor.set_position(floor.x, floor.y);
        this._floor.set_size(floor.width, floor.height);
        entries.forEach((entry, i) => {
            const card = this._makeCard(entry, slots[i], floor, scale, i);
            this._cards.set(entry.id, card);
            this._floor.add_child(card);
        });
        this._syncBarrier();
        this._placeStrip();
    }

    /** Slide the strip in or out. Interruptible: it turns round from where it is. */
    setVisible(visible, animate = true) {
        if (this._dead || visible === this._shown)
            return;
        this._shown = visible;
        this._slide?.cancel();
        const away = this._awayX();
        const target = { translation_x: visible ? 0 : away, opacity: visible ? 255 : 0 };
        if (visible)
            this._strip.visible = true;
        const done = finished => {
            if (finished && !visible && !this._dead)
                this._strip.visible = false;
        };
        if (!animate) {
            this._strip.set(target);
            done(true);
            return;
        }
        this._slide = this._env.motion.ease(this._strip, target, {
            duration: this._env.ms(SLIDE_MS), curve: 'standard', onDone: done,
        }, this._cleanup);
    }

    /**
     * The workspace changed (SM-27): the strip, already redrawn for the new workspace, slides in
     * from its edge again, like the workspace does. A hidden strip stays hidden.
     */
    replay() {
        if (this._dead || this._shown !== true)
            return;
        this._slide?.cancel();
        this._strip.set({ translation_x: this._awayX(), opacity: 0 });
        this._strip.visible = true;
        this._slide = this._env.motion.ease(this._strip, { translation_x: 0, opacity: 255 }, {
            duration: this._env.ms(SLIDE_MS), curve: 'standard',
        }, this._cleanup);
    }

    /** Where a window's thumbnail is (screen rect, with its tilt), or null. */
    thumbRect(win) {
        const t = this._thumbs.get(win);
        return t ? { ...t.rect, angle: t.angle } : null;
    }

    /** Every thumbnail's rect now, by window (where a window flies from when its set comes up). */
    thumbRects() {
        return new Map([...this._thumbs].map(([win, t]) => [win, { ...t.rect, angle: t.angle }]));
    }

    /** A window is flying to or from its thumbnail: the thumbnail stays out of sight. */
    setFlying(win, on) {
        const t = this._thumbs.get(win);
        if (on)
            this._flying.add(win);
        else
            this._flying.delete(win);
        if (t)
            t.actor.opacity = on ? 0 : t.opacity;
    }

    /** Screen rects of the thumbnails, [{id, rect}], for the drop test of a dragged window. */
    get cards() {
        return this._shown === false ? [] : this._cardRects;
    }

    /** Light the thumbnail a dragged window would join (null: none). */
    highlightCard(id) {
        if (this._dead)
            return;
        const card = id === null ? null : this._cardRects.find(c => c.id === id);
        if (!card) {
            this._fadeDrop(this._dropCard, false);
            return;
        }
        const pad = 6;
        const r = card.rect;
        this._dropCard.set_position(Math.round(r.x - pad), Math.round(r.y - pad));
        this._dropCard.set_size(Math.round(r.width + 2 * pad), Math.round(r.height + 2 * pad));
        this._fadeDrop(this._dropCard, true);
    }

    // ---- dragging a thumbnail onto the stage (SM-34) ------------------------------------------

    _press(entry, event) {
        if (this._dead || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag(false, true);
        const [x, y] = event.get_coords();
        const drag = { entry, start: { x, y }, active: false, proxy: null, token: 0, target: null };
        this._drag = drag;
        drag.token = this._cleanup.connect(global.stage, 'captured-event', (_s, ev) => this._dragEvent(drag, ev));
        return Clutter.EVENT_PROPAGATE;
    }

    _dragEvent(drag, ev) {
        if (this._drag !== drag)
            return Clutter.EVENT_PROPAGATE;
        const type = ev.type();
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = ev.get_coords();
            if (!drag.active) {
                if (!dragStarted(drag.start, { x, y }, DRAG_PX))
                    return Clutter.EVENT_PROPAGATE;
                this._beginDrag(drag);
                if (this._drag !== drag)
                    return Clutter.EVENT_PROPAGATE;
            }
            this._moveDrag(drag, x, y);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === 1) {
            if (!drag.active) {
                this._endDrag(false, true);
                return Clutter.EVENT_PROPAGATE;
            }
            const [x, y] = ev.get_coords();
            this._moveDrag(drag, x, y);
            this._endDrag(drag.target === 'stage');
            return Clutter.EVENT_STOP;
        }
        if (drag.active && type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
            this._endDrag(false);
            return Clutter.EVENT_STOP;
        }
        // While dragging, nothing else reaches the shell
        if (drag.active && type !== Clutter.EventType.LEAVE && type !== Clutter.EventType.ENTER)
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    }

    _beginDrag(drag) {
        drag.active = true;
        // The card lets go of the pointer (no click at the end)
        this._cards.get(drag.entry.id)?.fake_release?.();
        // A modal grab on a transparent overlay: every event of the drag reaches us, whatever is under
        // the pointer (a client window would otherwise take the stream), and Esc is ours
        const overlay = new Clutter.Actor({ reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height });
        Main.uiGroup.add_child(overlay);
        drag.overlay = overlay;
        drag.grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.POPUP });
        if (!drag.grab) {
            // The Shell is busy with another grab: no drag
            this._popGrab(drag);
            this._endDrag(false, true);
            return;
        }
        overlay.grab_key_focus();
        overlay.connect('event', (_a, ev) => this._dragEvent(drag, ev));
        const win = drag.entry.windows[0];
        const thumb = this._thumbs.get(win);
        const actor = win?.get_compositor_private?.();
        const frame = win?.get_frame_rect?.();
        drag.thumbs = drag.entry.windows.map(w => this._thumbs.get(w)).filter(Boolean);
        if (!thumb || !actor || !(frame?.width > 0)) {
            // No thumbnail to carry: the drag still shows the drop zone
            drag.proxy = null;
            return;
        }
        const buffer = win.get_buffer_rect();
        const s = thumb.rect.width / frame.width;
        const proxy = new Clutter.Clone({ source: actor, reactive: false });
        proxy.set_size(buffer.width, buffer.height);
        proxy.set_pivot_point(0, 0);
        proxy.set_scale(s, s);
        // The clone's origin sits at the buffer corner; the frame is inset by the shadow
        drag.inset = { x: (frame.x - buffer.x) * s, y: (frame.y - buffer.y) * s };
        drag.offset = { x: drag.start.x - thumb.rect.x, y: drag.start.y - thumb.rect.y };
        drag.home = { x: thumb.rect.x - drag.inset.x, y: thumb.rect.y - drag.inset.y, scale: s };
        proxy.set_position(drag.home.x, drag.home.y);
        this.flightLayer.add_child(proxy);
        drag.proxy = proxy;
        attachThumbEffect(proxy, buffer, { x: frame.x - buffer.x, y: frame.y - buffer.y, width: frame.width, height: frame.height },
            this._env.corners());
        for (const t of drag.thumbs)
            t.actor.opacity = DRAG_DIM * t.opacity / 255;
        this._env.onReveal();
    }

    _popGrab(drag) {
        if (drag.grab) {
            try {
                Main.popModal(drag.grab);
            } catch (e) {
                console.error('[Guava] stage manager: popModal failed:', e);
            }
            drag.grab = null;
        }
        drag.overlay?.destroy();
        drag.overlay = null;
    }

    _moveDrag(drag, x, y) {
        if (drag.proxy) {
            drag.proxy.set_position(x - drag.offset.x - drag.inset.x, y - drag.offset.y - drag.inset.y);
        }
        const { workArea } = this._state;
        const target = thumbDropTarget({ x, y }, { band: this.band, workArea });
        if (target !== drag.target) {
            drag.target = target;
            this._lightStage(target === 'stage');
        }
        // Keep the strip revealed while the pointer works on it
        this._env.onReveal();
    }

    // Stage highlight: the work area beside the strip
    _lightStage(on) {
        const { workArea, side } = this._state;
        if (on && workArea) {
            const w = METRICS.stripWidth;
            this._dropStage.set_position(side === 'right' ? workArea.x + 8 : workArea.x + w, workArea.y + 8);
            this._dropStage.set_size(workArea.width - w - 8, workArea.height - 16);
        }
        this._fadeDrop(this._dropStage, on);
    }

    _fadeDrop(actor, on) {
        if (this._dead)
            return;
        if (on)
            actor.visible = true;
        else if (!actor.visible)
            return;
        this._env.motion.ease(actor, { opacity: on ? 255 : 0 }, {
            duration: this._env.ms(DROP_MS), curve: 'standard',
            onDone: finished => {
                if (finished && !on && !this._dead)
                    actor.visible = false;
            },
        }, this._cleanup);
    }

    /**
     * End the drag. `commit`: the thumbnail was dropped on the stage (the set joins it). Otherwise
     * (Esc, a drop on the strip) the copy flies back. `now`: no animation (teardown, redraw).
     */
    _endDrag(commit, now = false) {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        if (drag.token)
            this._cleanup.release(drag.token);
        this._popGrab(drag);
        if (!drag.active)
            return;
        const restore = () => {
            for (const t of drag.thumbs ?? [])
                t.actor.opacity = t.opacity;
        };
        this._lightStage(false);
        const proxy = drag.proxy;
        const finish = () => {
            if (this._dead)
                return;
            restore();
            proxy?.destroy();
        };
        if (this._dead || now || !proxy) {
            finish();
            if (commit && !this._dead)
                this._env.onDropThumb(drag.entry.id);
            return;
        }
        if (commit) {
            // The set joins the stage; its windows fly in from the thumbnail, the copy melts away
            restore();
            this._env.onDropThumb(drag.entry.id);
            this._env.motion.ease(proxy, { opacity: 0 }, {
                duration: this._env.ms(DROP_MS), curve: 'standard', onDone: () => !this._dead && proxy.destroy(),
            }, this._cleanup);
            return;
        }
        this._env.motion.ease(proxy, { x: drag.home.x, y: drag.home.y }, {
            duration: this._env.ms(DROP_MS * 1.5), curve: 'standard', onDone: finish,
        }, this._cleanup);
    }

    // ---- internals --------------------------------------------------------------------------

    _awayX() {
        return (this._state.side === 'right' ? 1 : -1) * (METRICS.stripWidth + 24);
    }

    _placeStrip() {
        if (this._shown === false && !this._slide?.running)
            this._strip.translation_x = this._awayX();
    }

    _placeEdge(workArea, side) {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const x = side === 'right' ? mon.x + mon.width - EDGE_PX : mon.x;
        this._edge.set_position(x, workArea.y);
        this._edge.set_size(EDGE_PX, workArea.height);
    }

    _makeCard(entry, rect, floor, scale, index) {
        const { side, tilt } = this._state;
        const angle = tiltAngle(side, tilt);
        const names = entry.names.filter(Boolean);
        const button = new St.Button({
            style_class: 'guava-stage-card', reactive: true, can_focus: true, track_hover: true,
            accessible_name: names.join(', ') || this._env.gettext('Window'),
        });
        button.set_position(rect.x - floor.x, rect.y - floor.y);
        button.set_size(rect.width, rect.height);
        button.connect('key-focus-in', () => this._env.onReveal());
        button.connect('clicked', () => {
            // The click's or the key press's modifiers, so Shift+Enter adds as Shift+click does
            const mods = Clutter.get_current_event()?.get_state() ?? 0;
            this._env.onActivate(entry.id, { add: (mods & Clutter.ModifierType.SHIFT_MASK) !== 0 });
        });
        button.connect('button-press-event', (_b, event) => this._press(entry, event));
        const holder = new Clutter.Actor({ reactive: false });
        holder.set_size(rect.width, rect.height);
        button.set_child(holder);

        const box = slotBox(rect, scale);
        const layers = stackLayers(entry.windows.length, side, { set: entry.set });
        let front = null;
        for (const layer of [...layers].reverse()) {
            const win = entry.windows[layer.index];
            const t = this._makeThumb(win, box, layer, scale, angle + layer.tilt);
            if (!t)
                continue;
            t.actor.opacity = this._flying.has(win) ? 0 : layer.opacity;
            holder.add_child(t.actor);
            this._thumbs.set(win, {
                actor: t.actor, opacity: layer.opacity, angle: angle + layer.tilt,
                rect: { x: rect.x + t.rect.x, y: rect.y + t.rect.y, width: t.rect.width, height: t.rect.height },
            });
            if (layer.index === 0)
                front = t;
        }
        if (!front)
            return button;

        // Keyboard focus ring in the lead window's pose
        const ring = new St.Widget({ style_class: 'guava-stage-focus', reactive: false, visible: false });
        ring.set_position(Math.round(front.rect.x), Math.round(front.rect.y));
        ring.set_size(Math.round(front.rect.width), Math.round(front.rect.height));
        ring.set_pivot_point(0.5, 0.5);
        ring.rotation_angle_y = angle;
        holder.add_child(ring);
        button.connect('key-focus-in', () => (ring.visible = true));
        button.connect('key-focus-out', () => (ring.visible = false));

        if (entry.app) {
            const size = Math.round(METRICS.badge * scale);
            const icon = entry.app.create_icon_texture(size);
            icon.add_style_class_name('guava-stage-badge-icon');
            const badge = new St.Bin({ style_class: 'guava-stage-badge', child: icon, reactive: false });
            // Bottom right of the tilted lead window (its projected near edge)
            const r = front.rect;
            const halfW = r.width / 2 * Math.cos(angle * Math.PI / 180);
            const overhang = Math.round(size * 0.35);
            badge.set_position(Math.round(r.x + r.width / 2 + halfW - size + overhang),
                Math.round(r.y + r.height - size + overhang));
            holder.add_child(badge);
        }
        return button;
    }

    // One window: its live clone (the whole buffer, shadow included) posed so the frame fills
    // its layer rect, turned by `angle` about the frame centre; an icon tile before it has an actor.
    _makeThumb(win, box, layer, scale, angle) {
        const actor = win?.get_compositor_private?.();
        const frame = win?.get_frame_rect?.();
        if (!actor || !(frame?.width > 0) || !(frame?.height > 0))
            return null;
        const buffer = win.get_buffer_rect();
        const rect = layerRect(frame, box, layer, scale);
        const pose = clonePose(frame, buffer, rect);
        if (!pose)
            return null;
        const clone = new Clutter.Clone({ source: actor, reactive: false });
        clone.set_size(buffer.width, buffer.height);
        clone.set_pivot_point(pose.pivotX, pose.pivotY);
        clone.set_position(Math.round(pose.x), Math.round(pose.y));
        clone.set_scale(pose.scaleX, pose.scaleY);
        clone.scale_z = pose.scale;
        clone.rotation_angle_y = angle;
        attachThumbEffect(clone, buffer, { x: frame.x - buffer.x, y: frame.y - buffer.y, width: frame.width, height: frame.height },
            this._env.corners());
        const dx = Math.round(pose.x) - pose.x;
        const dy = Math.round(pose.y) - pose.y;
        return { actor: clone, rect: { ...rect, x: rect.x + dx, y: rect.y + dy } };
    }

    // ---- edge pressure ----------------------------------------------------------------------

    _dropBarrier() {
        if (!this._barrier)
            return;
        this._pressure.removeBarrier(this._barrier);
        this._barrier.destroy();
        this._barrier = null;
        this._barrierKey = '';
    }

    // A barrier on the strip's edge, where no other monitor continues past it
    _syncBarrier() {
        const { side, workArea } = this._state;
        const lm = Main.layoutManager;
        const monitor = lm.primaryMonitor;
        const want = workArea && monitor
            ? edgeBarrier(workArea, monitor, lm.monitors.filter(m => m !== monitor), side) : null;
        const key = want ? `${want.x1},${want.y1},${want.y2},${want.direction}` : '';
        if (key === this._barrierKey)
            return;
        this._dropBarrier();
        this._barrierKey = key;
        if (!want)
            return;
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: want.x1, x2: want.x2, y1: want.y1, y2: want.y2,
            directions: want.direction === 'negative' ? Meta.BarrierDirection.NEGATIVE_X : Meta.BarrierDirection.POSITIVE_X,
        });
        this._pressure.addBarrier(this._barrier);
    }
}
