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
// Input out (env): onActivate(setId, {add}), onEdge(on), onHover(on), onPush(), onReveal().
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
import {
    METRICS, clonePose, edgeBarrier, layerRect, slotBox, stackLayers, stripLayout, tiltAngle,
} from './geometry.js';

const PRESSURE_THRESHOLD = 40;   // px pushed against the edge, as the auto-hide top bar
const PRESSURE_TIMEOUT = 600;
const SLIDE_MS = 220;
const EDGE_PX = 2;

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
        for (const card of this._cards.values())
            card.destroy();
        this._cards.clear();
        this._thumbs.clear();
        const { floor, slots, scale } = this._layout;
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
