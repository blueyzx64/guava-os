// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager strip view: the strip entries float on the wallpaper at the screen edge (as on
// macOS there is no panel under them), each a stack of live, tilted window clones with the app icon badge.
// It also owns the drop target over the stage (while an entry is dragged) and the layer the
// flights fly in, so the whole feature draws inside one container, destroyed on disable.
//
// The view knows only what update() hands it: entries of Meta.Windows and their apps. All
// maths is in geometry.js; the state is in model.js; index.js wires them.
//
// Actor tree (absolute stage coordinates; the container is the 'stage-strip' layout claim's
// chrome actor, hidden over full-screen windows by the layout manager):
//   container      Clutter.Actor 1x1 at 0,0
//     drop         St.Widget .guava-stage-drop over the stage, a DND target, while an entry is dragged
//     strip        Clutter.Actor: slides off the edge when the strip steps aside
//       floor      St.Widget .guava-stage-strip: invisible, the strip's hover and drop area
//                  (it reaches the screen edge, so a pointer resting there keeps the strip out)
//         content  Clutter.Actor moved up by the scroll offset when the entries do not all fit
//         card     St.Button .guava-stage-card per entry: hit box, DND source
//           holder   Clutter.Actor: clones back to front, the focus ring, the label, the badge
//     flights      Clutter.Actor: the windows flying to and from the strip, above everything
//   barrier        Meta.Barrier + Layout.PressureBarrier on the edge: a push reveals the strip
//
// Sharpness: a thumbnail is a live clone of the window actor with thumbEffect.js, which averages
// the texels under each output pixel and rounds the corners in full-size texels. (Without it the
// clone samples a 1:1 texture with plain bilinear filtering and text turns into dark specks.)
// The window's own soft shadow is the edge of the tilted quad and shows no jaggies.
//
// Private API: none. Main.layoutManager (public), ui/dnd.js and Layout.PressureBarrier (public
// classes, same in 48-51). Checked on GNOME Shell 50.6: a clone of an opacity-0 actor paints.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { attachThumbEffect } from './thumbEffect.js';
import {
    METRICS, clonePose, edgeBarrier, edgeFade, groupSide, halves, layerRect, revealOffset, slotBox, slotAt, stackLayers,
    stageArea, stripLayout, stripVisible, tiltAngle,
} from './geometry.js';

const HOVER_SCALE = 1.1;
const HOVER_TILT = 0.4;          // share of the tilt left on hover: the window turns to you
const DRAG_OPACITY = 90;         // an entry left behind while its clone is dragged
const PRESSURE_THRESHOLD = 40;   // px pushed against the edge, as the auto-hide top bar
const PRESSURE_TIMEOUT = 600;
const WHEEL_STEP = 90;           // px scrolled by one wheel notch
const SMOOTH_STEP = 60;          // px per unit of a smooth (touchpad) scroll delta
const SIDE_QUIET = { opacity: 85, scale: 0.97 };   // the half the dragged window will not take
const SIDE_ENTER_SCALE = 0.94;   // a highlight springs up from this

export class StripView {
    /**
     * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup
     * @param {object} env
     * @param {import('../../core/motion.js').Motion} env.motion
     * @param {() => number} env.ms a duration (ms) under the animation speed setting
     * @param {(entryId: string, mods: {add: boolean}) => void} env.onActivate a click
     * @param {(entryId: string) => void} env.onDrop an entry dropped on the stage
     * @param {(dragged: string, target: string, side: 'left'|'right') => void} env.onGroup an entry dropped on another
     * @param {() => void} env.onLayout the strip moved, grew, showed or hid
     * @param {() => ?{radius: number, mask: number[]}} env.corners the corner rounding of thumbnails (thumbEffect.cornerSpec)
     * @param {(text: string) => string} env.gettext
     */
    constructor(cleanup, env) {
        this._cleanup = cleanup;
        this._env = env;
        this._state = {
            side: 'left', workArea: null, entries: [], tilt: METRICS.tilt,
            showRecent: true, autohide: true, overlapped: false, suppressed: false,
        };
        this._thumbs = new Map();     // Meta.Window -> {actor, rect (absolute, unslid), angle, badge}
        this._slots = [];             // [{entryId, rect}] absolute, unslid
        this._flying = new Set();     // windows a flight stands in for
        this._floorRect = null;
        this._scrollMax = 0;          // how far the entries scroll (0: they all fit)
        this._scrollTarget = 0;
        this._firstId = null;         // first entry shown last time
        this._shown = null;           // last applied visibility (null: never)
        this._builtKey = null;        // what the cards were last built from
        this._edge = false;           // the pointer just pushed the edge
        this._dragging = null;        // entry id while an entry is dragged
        this._pending = false;        // an update came during the drag
        this._dropHint = null;        // null | 'near' | 'over': a stage window dragged to the strip
        this._cards = new Map();      // entry id -> its St.Button
        this._groupHint = null;       // {entry, side} while a dragged entry hovers another's card
        this._dragMonitor = null;
        this._anims = new Set();      // running animation handles
        this._dead = false;

        this.container = new Clutter.Actor({ name: 'guava-stage-manager', reactive: false, width: 1, height: 1 });
        cleanup.actor(this.container);
        this.container.connect('destroy', () => {
            this._dead = true;
            this._thumbs.clear();
        });

        this._drop = new St.Widget({ style_class: 'guava-stage-drop', visible: false, reactive: false });
        this._dropLabel = new St.Label({ style_class: 'guava-stage-drop-label', text: env.gettext('Add to Stage') });
        this._drop.layout_manager = new Clutter.BinLayout();
        this._dropLabel.x_align = Clutter.ActorAlign.CENTER;
        this._dropLabel.y_align = Clutter.ActorAlign.CENTER;
        this._drop.add_child(this._dropLabel);
        this._drop._delegate = {
            handleDragOver: source => (source?.guavaStageEntry
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE),
            acceptDrop: source => {
                if (!source?.guavaStageEntry)
                    return false;
                const id = source.guavaStageEntry;
                // After DND finishes its own bookkeeping
                this._cleanup.idle(() => this._env.onDrop(id), { name: 'stage-manager-drop' });
                return true;
            },
        };
        this.container.add_child(this._drop);
        // The two halves of the stage, lit while a dragged entry hovers another's card
        this._sides = {};
        for (const side of ['left', 'right']) {
            const half = new St.Widget({ style_class: 'guava-stage-side', visible: false, reactive: false, opacity: 0 });
            half.set_pivot_point(0.5, 0.5);
            this._sides[side] = half;
            this.container.add_child(half);
        }

        this._strip = new Clutter.Actor({ reactive: false, visible: false });
        this.container.add_child(this._strip);
        this._floor = new St.Widget({ style_class: 'guava-stage-strip', reactive: true, track_hover: true });
        this._strip.add_child(this._floor);
        // The soft glass under the entries, so they read apart from the app behind them
        this._glass = Glass.attach(this._floor, { surface: 'panel', role: 'bar' });
        cleanup.add(() => this._glass.destroy());
        // Entries live in a content actor, moved by the scroll offset
        this._content = new Clutter.Actor({ reactive: false });
        this._floor.add_child(this._content);
        this._content.connect('notify::translation-y', () => this._applyFades());
        this._floor.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._floor.connect('notify::hover', () => this._syncShown());
        // Keyboard: Ctrl+Alt+Tab lists the strip even while it is tucked away; choosing it slides
        // it out and puts the focus on its first card. The strip stays out while focus is inside.
        this._focusWithin = false;
        this._floor.accessible_name = this._env.gettext('Stage Manager');
        this._floor.accessible_role = A11y.Role.TOOL_BAR;
        A11y.focusGroup(cleanup, this._floor, this._env.gettext('Stage Manager'), 'view-grid-symbolic', {
            proxy: this.container,
            focus: () => {
                this._focusWithin = true;
                this._syncShown();
                this._floor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            },
        });
        cleanup.connect(global.stage, 'notify::key-focus', () => {
            const within = A11y.focusWithin(this._floor);
            if (within === this._focusWithin)
                return;
            this._focusWithin = within;
            this._syncShown();
        });

        this._flights = new Clutter.Actor({ reactive: false });
        this.container.add_child(this._flights);

        this._barrier = null;
        this._barrierKey = '';
        this._edgeToken = 0;
        this._pressure = new Layout.PressureBarrier(PRESSURE_THRESHOLD, PRESSURE_TIMEOUT, Shell.ActionMode.NORMAL);
        // A held button is a window drag (to an edge to tile): not a reveal
        this._pressure.setEventFilter(() => {
            const [, , mods] = global.get_pointer();
            return (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        });
        this._pressure.connect('trigger', () => this._edgePushed());
        cleanup.add(() => {
            this._dropBarrier();
            this._pressure.destroy();
        });
        cleanup.add(() => this._cancelAnims());
        cleanup.add(() => this._removeDragMonitor());
    }

    /** Show or hide the glass backdrop of the strip. */
    setBackground(on) {
        if (!this._dead)
            this._glass.setVisible(on);
    }

    /** The layer flights fly in. */
    get flightLayer() {
        return this._flights;
    }

    /**
     * Set what the strip shows; any of: side, workArea, entries [{id, windows: Meta.Window[]
     * (lead first), app: ?Shell.App, names: string[], set}], tilt, slide (-1, 0, 1).
     */
    update(next) {
        if (this._dead)
            return;
        const { slide = 0, ...rest } = next;
        Object.assign(this._state, rest);
        if (this._dragging) {
            this._pending = true;
            return;
        }
        // Cards are rebuilt only when what they show changed: a rebuild while the strip is on
        // screen redraws every card, which reads as a flicker
        const key = this._contentKey();
        if (!slide && key === this._builtKey)
            return;
        this._builtKey = key;
        this._rebuild(slide);
    }

    _contentKey() {
        const { side, workArea, entries, tilt } = this._state;
        return JSON.stringify([side, tilt, workArea, this._env.corners(),
            entries.map(e => [e.id, e.set, e.names, e.windows.map(w => w.get_stable_sequence())])]);
    }

    /** Cheap: only whether the strip is shown (stage windows moved, overview, full screen). */
    setConditions({ showRecent, autohide, overlapped, suppressed }) {
        if (this._dead)
            return;
        Object.assign(this._state, Object.fromEntries(Object.entries({ showRecent, autohide, overlapped, suppressed })
            .filter(([, v]) => v !== undefined)));
        this._syncBarrier();
        this._syncShown();
    }

    /** The floor's rect (absolute, unslid), or null when there are no entries. */
    floorRect() {
        return this._dead || !this._floorRect ? null : { ...this._floorRect };
    }

    /** Is the strip on screen now? */
    get shown() {
        return !!this._shown;
    }

    /**
     * Where a window's clone lies in the strip now (absolute, the slide included), with its
     * tilt `angle`; null when it has none (its entry is past the shown count).
     */
    thumbRect(win) {
        const t = this._dead ? null : this._thumbs.get(win);
        if (!t)
            return null;
        return { ...this._visible(t.rect), angle: t.angle };
    }

    /** Where an entry's slot is now (absolute, slid), or null. */
    slotRect(entryId) {
        const s = this._dead ? null : this._slots.find(x => x.entryId === entryId);
        return s ? this._visible(s.rect) : null;
    }

    /** The entry whose slot is under an absolute point, or null. */
    entryAt(x, y) {
        if (this._dead || !this._shown)
            return null;
        const i = slotAt(this._slots.map(s => this._visible(s.rect)), { x, y });
        return i < 0 || this._fadeOf(this._slots[i].rect) <= 0 ? null : this._slots[i].entryId;
    }

    /** A flight stands in for this window's clone: hide the clone (and badge) until it lands. */
    setFlying(win, flying) {
        if (this._dead)
            return;
        if (flying)
            this._flying.add(win);
        else
            this._flying.delete(win);
        const t = this._thumbs.get(win);
        if (!t)
            return;
        t.actor.opacity = flying ? 0 : t.opacity;
        if (t.badge) {
            t.badge.remove_all_transitions();
            if (flying)
                t.badge.opacity = 0;
            else
                this._ease(t.badge, { opacity: 255 }, { duration: this._env.ms(120), curve: 'enter' });
        }
    }

    /**
     * A stage window is dragged toward the strip: keep the strip out ('near'), light it up
     * while the pointer is over it ('over'); null ends it.
     */
    setDropHint(hint) {
        if (this._dead || hint === this._dropHint)
            return;
        this._dropHint = hint;
        if (hint === 'over')
            this._floor.add_style_pseudo_class('drop');
        else
            this._floor.remove_style_pseudo_class('drop');
        this._syncShown();
    }

    /** Where entries dropped on the stage go, and where a new set is tiled (absolute). */
    stageArea() {
        const wa = this._state.workArea;
        return this._dead || !wa ? null : stageArea(wa, this._floorRect, this._state.side);
    }

    // ---- scrolling -----------------------------------------------------------------------------

    get _offset() {
        return -this._content.translation_y;
    }

    // A rect (absolute, unscrolled) where it is on screen now: slide and scroll included, kept
    // inside the floor so a flight to an entry scrolled out of sight ends at the strip's edge
    _visible(rect) {
        const f = this._floorRect;
        const y = f ? Math.max(f.y, Math.min(f.y + f.height - rect.height, rect.y - this._offset)) : rect.y;
        return { ...rect, x: rect.x + this._strip.translation_x, y };
    }

    _fadeOf(slot) {
        return this._floorRect ? edgeFade(slot, this._offset, this._floorRect) : 1;
    }

    // Entries nearer the top or bottom edge are fainter; those past it are out of reach
    _applyFades() {
        if (this._dead || !this._floorRect)
            return;
        const cards = this._content.get_children();
        for (let i = 0; i < cards.length && i < this._slots.length; i++) {
            const fade = this._fadeOf(this._slots[i].rect);
            cards[i].opacity = Math.round(255 * fade);
            cards[i].reactive = fade > 0;
        }
    }

    // Scroll to an offset (clamped): at once, or eased
    _scrollTo(offset, animate) {
        const target = Math.max(0, Math.min(this._scrollMax, offset));
        this._scrollTarget = target;
        this._content.remove_all_transitions();
        if (!animate) {
            this._content.translation_y = -target;
            return;
        }
        this._ease(this._content, { translation_y: -target }, { duration: this._env.ms(180), curve: 'standard' });
    }

    _onScroll(event) {
        if (this._scrollMax <= 0)
            return Clutter.EVENT_PROPAGATE;
        const dir = event.get_scroll_direction();
        let delta = 0;
        let smooth = false;
        if (dir === Clutter.ScrollDirection.UP)
            delta = -WHEEL_STEP;
        else if (dir === Clutter.ScrollDirection.DOWN)
            delta = WHEEL_STEP;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            delta = event.get_scroll_delta()[1] * SMOOTH_STEP;
            // A touchpad already moves in small steps; a wheel notch is eased
            smooth = event.get_scroll_source() !== Clutter.ScrollSource.WHEEL;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        const base = smooth ? this._offset : this._scrollTarget;
        this._scrollTo(base + delta, !smooth);
        return Clutter.EVENT_STOP;
    }

    // Keyboard focus on an entry brings it into view
    _reveal(index) {
        const slot = this._slots[index]?.rect;
        if (!slot || !this._floorRect || this._scrollMax <= 0)
            return;
        const next = revealOffset(slot, this._scrollTarget, this._floorRect, this._scrollMax);
        if (next !== this._scrollTarget)
            this._scrollTo(next, true);
    }

    // ---- build -------------------------------------------------------------------------------

    _spring(actor, prop, to, onDone) {
        let anim = null;
        anim = this._env.motion.spring(actor, prop, to, {
            spring: 'smooth',
            onDone: finished => {
                if (anim)
                    this._anims.delete(anim);
                onDone?.(finished);
            },
        });
        if (anim.running)
            this._anims.add(anim);
    }

    _ease(actor, props, request) {
        let anim = null;
        anim = this._env.motion.ease(actor, props, {
            ...request,
            onDone: finished => {
                if (anim)
                    this._anims.delete(anim);
                request.onDone?.(finished);
            },
        });
        if (anim.running)
            this._anims.add(anim);
        return anim;
    }

    _cancelAnims() {
        for (const a of [...this._anims])
            a.cancel();
        this._anims.clear();
    }

    _clearCards() {
        this._cards.clear();
        this._thumbs.clear();
        this._slots = [];
        for (const child of this._content.get_children())
            child.destroy();
    }

    _rebuild(slide) {
        const { side, workArea, entries } = this._state;
        this._clearCards();
        const count = workArea ? entries.length : 0;
        if (!workArea || count === 0) {
            this._floorRect = null;
            this._scrollMax = 0;
            this._firstId = null;
            this._syncBarrier();
            this._syncShown();
            return;
        }
        const layout = stripLayout({ workArea, side, count });
        const old = this._floorRect;
        this._scrollMax = layout.scrollMax;
        // A new first entry (the stage changed) shows the top; otherwise the view stays
        const keep = this._firstId === entries[0].id ? Math.min(this._offset, layout.scrollMax) : 0;
        this._firstId = entries[0].id;
        this._scrollTo(keep, false);
        const floor = layout.floor;
        this._floorRect = floor;
        this._placeFloor(old, floor);
        for (let i = 0; i < count; i++) {
            const rect = layout.slots[i];
            this._slots.push({ entryId: entries[i].id, rect });
            this._content.add_child(this._makeCard(entries[i], rect, floor, layout.scale, i));
        }
        this._applyFades();
        this._syncBarrier();
        this._syncShown();
        // Workspace switch: the other workspace's entries slide in from the way it came
        const cards = this._floor;
        if (slide && old && this._shown) {
            cards.translation_y = slide * 48;
            cards.opacity = 0;
            this._ease(cards, { translation_y: 0, opacity: 255 }, { duration: this._env.ms(300), curve: 'emphasized' });
        }
    }

    // The floor eases to its new size when entries come and go
    _placeFloor(old, floor) {
        const f = this._floor;
        const animate = !!old && this._shown && old.x === floor.x && (old.y !== floor.y || old.height !== floor.height);
        if (!animate) {
            f.remove_all_transitions();
            f.set_position(floor.x, floor.y);
            f.set_size(floor.width, floor.height);
            return;
        }
        f.set_position(floor.x, old.y);
        f.set_size(floor.width, old.height);
        this._ease(f, { y: floor.y, height: floor.height }, { duration: this._env.ms(260), curve: 'standard' });
    }

    _makeCard(entry, rect, floor, scale, index) {
        const { side, tilt } = this._state;
        const angle = tiltAngle(side, tilt);
        const names = entry.names.filter(Boolean);
        const button = new St.Button({
            style_class: 'guava-stage-card', reactive: true, can_focus: true, track_hover: true,
            accessible_name: names.join(', ') || this._env.gettext('Window'),
        });
        // Cards live in the floor, which eases its y: keep them where the slots are on screen
        button.set_position(rect.x - floor.x, rect.y - floor.y);
        button.set_size(rect.width, rect.height);
        button.connect('key-focus-in', () => this._reveal(index));
        button.connect('clicked', () => {
            // The click's or the key press's modifiers, so Shift+Enter adds as Shift+click does
            const mods = Clutter.get_current_event()?.get_state() ?? 0;
            this._env.onActivate(entry.id, { add: (mods & Clutter.ModifierType.SHIFT_MASK) !== 0 });
        });

        const holder = new Clutter.Actor({ reactive: false });
        holder.set_size(rect.width, rect.height);
        button.set_child(holder);
        this._makeDraggable(button, holder, entry.id);

        const box = slotBox(rect, scale);
        const layers = stackLayers(entry.windows.length, side, { set: entry.set });
        let front = null;
        for (const layer of [...layers].reverse()) {
            const win = entry.windows[layer.index];
            const t = this._makeThumb(win, box, layer, scale, angle + layer.tilt) ??
                this._makeIconThumb(entry.app, win, box, layer, scale, angle + layer.tilt);
            t.actor.opacity = this._flying.has(win) ? 0 : layer.opacity;
            holder.add_child(t.actor);
            if (win) {
                this._thumbs.set(win, {
                    actor: t.actor, opacity: layer.opacity, angle: angle + layer.tilt, badge: null,
                    rect: { x: rect.x + t.rect.x, y: rect.y + t.rect.y, width: t.rect.width, height: t.rect.height },
                });
            }
            if (layer.index === 0)
                front = { ...t, win };
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

        const label = this._makeLabel(names, front.rect, rect);
        if (label)
            holder.add_child(label);
        // Hover: the lead window lifts, grows a little and turns toward you; the names fade in
        const { scaleX, scaleY } = front;
        button.connect('notify::hover', () => {
            const on = button.hover && !this._dragging;
            const k = on ? HOVER_SCALE : 1;
            const a = on ? angle * HOVER_TILT : angle;
            if (on)
                this._content.set_child_above_sibling(button, null);
            const req = { duration: this._env.ms(200), curve: 'standard' };
            front.actor.remove_all_transitions();
            ring.remove_all_transitions();
            this._ease(front.actor, { scale_x: scaleX * k, scale_y: scaleY * k, scale_z: Math.min(scaleX, scaleY) * k, rotation_angle_y: a }, req);
            this._ease(ring, { scale_x: k, scale_y: k, rotation_angle_y: a }, req);
            if (label) {
                label.remove_all_transitions();
                this._ease(label, { opacity: on ? 255 : 0, translation_y: on ? 0 : -4 },
                    { duration: this._env.ms(180), curve: 'enter' });
            }
        });

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
            const t = this._thumbs.get(front.win);
            if (t)
                t.badge = badge;
            if (this._flying.has(front.win))
                badge.opacity = 0;
        }
        return button;
    }

    _makeLabel(names, front, rect) {
        if (names.length === 0)
            return null;
        const text = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
        const label = new St.Label({ text, style_class: 'guava-stage-label-text' });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const width = Math.round(rect.width + 24);
        const bin = new St.Bin({
            style_class: 'guava-stage-label', reactive: false, opacity: 0, translation_y: -4,
            x_align: Clutter.ActorAlign.CENTER, child: new St.Bin({ child: label }),
        });
        bin.set_position(Math.round(rect.width / 2 - width / 2), Math.round(front.y + front.height + 6));
        bin.set_width(width);
        return bin;
    }

    // Drag an entry: a clone of its stack follows the pointer; dropped on the stage it joins the set
    _makeDraggable(button, holder, entryId) {
        this._cards.set(entryId, button);
        button._delegate = {
            guavaStageEntry: entryId,
            // Another entry dropped on this card forms a set with it
            handleDragOver: source => (source?.guavaStageEntry && source.guavaStageEntry !== entryId
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE),
            acceptDrop: (source, _actor, x, y) => {
                const dragged = source?.guavaStageEntry;
                const slot = this.slotRect(entryId);
                if (!dragged || dragged === entryId || !slot)
                    return false;
                const side = groupSide({ x, y }, slot);
                this._cleanup.idle(() => this._env.onGroup(dragged, entryId, side), { name: 'stage-manager-group' });
                return true;
            },
            getDragActor: () => {
                const clone = new Clutter.Clone({ source: holder, reactive: false });
                clone.set_size(holder.width, holder.height);
                return clone;
            },
            getDragActorSource: () => holder,
        };
        const draggable = DND.makeDraggable(button, { restoreOnSuccess: false });
        draggable.connect('drag-begin', () => {
            this._dragging = entryId;
            holder.opacity = DRAG_OPACITY;
            this._showDropTarget(true);
            this._dragMonitor = { dragMotion: ev => this._groupMotion(ev) };
            DND.addDragMonitor(this._dragMonitor);
            this._syncShown();
        });
        draggable.connect('drag-end', () => {
            if (this._dragging !== entryId)
                return;
            this._dragging = null;
            this._removeDragMonitor();
            this._setGroupHint(null);
            this._showDropTarget(false);
            if (!this._dead && holder.get_stage())
                holder.opacity = 255;
            if (this._pending) {
                this._pending = false;
                this._builtKey = this._contentKey();
                this._rebuild(0);
            } else {
                this._syncShown();
            }
        });
    }

    _showDropTarget(on) {
        const wa = this._state.workArea;
        if (!on || !wa || !this._floorRect) {
            this._drop.visible = false;
            return;
        }
        const area = this.stageArea();
        this._drop.set_position(area.x, area.y);
        this._drop.set_size(area.width, area.height);
        this._drop.opacity = 255;
        this._drop.visible = true;
    }

    _removeDragMonitor() {
        if (!this._dragMonitor)
            return;
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    // The dragged entry is over a card: light the halves of the stage, the pointer's side strongest
    _groupMotion({ x, y }) {
        const target = this._dragging ? this.entryAt(x, y) : null;
        const slot = target && target !== this._dragging ? this.slotRect(target) : null;
        this._setGroupHint(slot ? { entry: target, side: groupSide({ x, y }, slot) } : null);
        return DND.DragMotionResult.CONTINUE;
    }

    _setGroupHint(hint) {
        const old = this._groupHint;
        if (old?.entry === hint?.entry && old?.side === hint?.side)
            return;
        this._groupHint = hint;
        if (old?.entry !== hint?.entry) {
            this._cards.get(old?.entry)?.remove_style_pseudo_class('drop');
            this._cards.get(hint?.entry)?.add_style_pseudo_class('drop');
        }
        const area = this.stageArea();
        const rects = area ? halves(area) : null;
        for (const side of ['left', 'right']) {
            const half = this._sides[side];
            if (!hint || !rects) {
                if (half.visible)
                    this._spring(half, 'opacity', 0, finished => {
                        if (finished && !this._dead && !this._groupHint)
                            half.visible = false;
                    });
                continue;
            }
            if (!half.visible) {
                half.set_position(rects[side].x, rects[side].y);
                half.set_size(rects[side].width, rects[side].height);
                half.opacity = 0;
                half.set_scale(SIDE_ENTER_SCALE, SIDE_ENTER_SCALE);
                half.visible = true;
            }
            const chosen = side === hint.side;
            const scale = chosen ? 1 : SIDE_QUIET.scale;
            this._spring(half, 'opacity', chosen ? 255 : SIDE_QUIET.opacity);
            this._spring(half, 'scale_x', scale);
            this._spring(half, 'scale_y', scale);
        }
        if (this._drop.visible)
            this._spring(this._drop, 'opacity', hint ? 0 : 255);
    }

    // One window: its live clone (the whole buffer, shadow included) posed so the frame fills
    // its layer rect, turned by `angle` about the frame centre.
    _makeThumb(win, box, layer, scale, angle) {
        const actor = win?.get_compositor_private?.();
        if (!actor)
            return null;
        const frame = win.get_frame_rect();
        const buffer = win.get_buffer_rect();
        if (!(frame.width > 0) || !(frame.height > 0))
            return null;
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
        return { actor: clone, rect: { ...rect, x: rect.x + dx, y: rect.y + dy }, scaleX: pose.scaleX, scaleY: pose.scaleY };
    }

    // A window with no actor yet: its app icon on a rounded tile, same pose
    _makeIconThumb(app, win, box, layer, scale, angle) {
        const f = win?.get_frame_rect?.();
        const frame = f?.width > 0 && f?.height > 0 ? f : { width: 16, height: 10 };
        const rect = layerRect(frame, box, layer, scale);
        const tile = new St.Widget({ style_class: 'guava-stage-icon-tile', layout_manager: new Clutter.BinLayout(), reactive: false });
        tile.set_position(Math.round(rect.x), Math.round(rect.y));
        tile.set_size(Math.round(rect.width), Math.round(rect.height));
        tile.set_pivot_point(0.5, 0.5);
        tile.rotation_angle_y = angle;
        const size = Math.round(48 * scale);
        const icon = app?.create_icon_texture(size) ??
            new St.Icon({ icon_name: 'application-x-executable-symbolic', icon_size: size });
        icon.x_align = Clutter.ActorAlign.CENTER;
        icon.y_align = Clutter.ActorAlign.CENTER;
        tile.add_child(icon);
        return { actor: tile, rect: { x: tile.x, y: tile.y, width: tile.width, height: tile.height }, scaleX: 1, scaleY: 1 };
    }

    // ---- edge reveal ---------------------------------------------------------------------------

    _dropBarrier() {
        if (!this._barrier)
            return;
        this._pressure.removeBarrier(this._barrier);
        this._barrier.destroy();
        this._barrier = null;
    }

    // A barrier on the strip's edge while the strip can be hidden and has entries
    _syncBarrier() {
        if (this._dead)
            return;
        const { side, workArea, showRecent, autohide, suppressed } = this._state;
        const lm = Main.layoutManager;
        const monitor = lm.primaryMonitor;
        const want = (!showRecent || autohide) && !suppressed && workArea && this._floorRect && monitor
            ? edgeBarrier(workArea, monitor, lm.monitors.filter(m => m !== monitor), side)
            : null;
        const key = want ? `${want.x1},${want.y1},${want.y2},${want.direction}` : '';
        if (key === this._barrierKey)
            return;
        this._barrierKey = key;
        this._dropBarrier();
        if (!want)
            return;
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: want.x1, x2: want.x2, y1: want.y1, y2: want.y2,
            directions: want.direction === 'negative' ? Meta.BarrierDirection.NEGATIVE_X : Meta.BarrierDirection.POSITIVE_X,
        });
        this._pressure.addBarrier(this._barrier);
    }

    _edgePushed() {
        this._edge = true;
        this._syncShown();
        // A push is a moment: it lasts until the pointer leaves the floor, or this hold ends
        this._cleanup.release(this._edgeToken);
        this._edgeToken = this._cleanup.timeout(1200, () => {
            this._edgeToken = 0;
            this._edge = false;
            this._syncShown();
            return false;
        }, { name: 'stage-strip-edge' });
    }

    _syncShown() {
        if (this._dead)
            return;
        const s = this._state;
        const show = !!this._floorRect && stripVisible({
            showRecent: s.showRecent, autohide: s.autohide, overlapped: s.overlapped,
            suppressed: s.suppressed,
            revealed: this._edge || this._floor.hover || this._focusWithin || !!this._dragging || !!this._dropHint,
        });
        if (show === this._shown)
            return;
        const first = this._shown === null || !this._floorRect;
        this._shown = show;
        this._env.onLayout?.();
        const strip = this._strip;
        strip.remove_all_transitions();
        const away = this._awayX();
        if (show) {
            strip.visible = true;
            if (first) {
                strip.translation_x = 0;
                strip.opacity = 255;
                return;
            }
            this._ease(strip, { translation_x: 0, opacity: 255 }, { duration: this._env.ms(300), curve: 'emphasized' });
            return;
        }
        if (first || !this._floorRect) {
            strip.translation_x = away;
            strip.opacity = 0;
            strip.visible = false;
            return;
        }
        this._ease(strip, { translation_x: away, opacity: 0 }, {
            duration: this._env.ms(260), curve: 'exit',
            onDone: finished => {
                if (finished && !this._dead && this._shown === false)
                    strip.visible = false;
            },
        });
    }

    // How far the strip slides to leave the screen
    _awayX() {
        const wa = this._state.workArea;
        const f = this._floorRect;
        if (!wa || !f)
            return 0;
        return this._state.side === 'right' ? wa.x + wa.width - f.x + 16 : -(f.x - wa.x + f.width + 16);
    }
}
