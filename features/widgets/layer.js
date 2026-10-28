// SPDX-License-Identifier: GPL-3.0-or-later
// One monitor's desktop widget layer: a non-reactive container in global.window_group, just
// above the wallpaper and below every window (the feature keeps it there, DING included).
// Only the widget cards are reactive, so a click on empty wallpaper still reaches the
// background (its menu, Stage Manager's and Show Desktop's wallpaper clicks).
//
// It renders what the feature tells it: sync(items, grid) creates, moves and drops views;
// setLook() dims; setLive() starts and stops the data; setEditing() shows the remove badges.
// Pointer handling (drag to place, click to open, right-click menu) calls back into the
// feature, which owns the layout.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { CleanupRegistry } from '../../lib/disposables.js';
import { RANKS } from '../../core/desktopLayers.js';
import { rectOf } from '../../core/widgets/model.js';
import { isDrag } from './model.js';

const MONO_EFFECT = 'guava-widgets-mono';

export class DesktopLayer {
    /**
     * @param {object} feature the DesktopWidgets instance (callbacks: moved, openMenu, remove)
     * @param {{index: number, key: string, x: number, y: number, width: number, height: number}} monitor
     */
    constructor(feature, monitor) {
        this._feature = feature;
        this._ctx = feature.ctx;
        this.monitor = monitor;
        this._cleanup = new CleanupRegistry();
        this._cards = new Map(); // item id -> {view, badge, item, cleanup}
        this._live = false;
        this._editing = false;
        this._grid = null;
        this._drag = null;
        this._look = { mono: false, opacity: 255 };

        this.actor = new St.Widget({
            name: 'guava-widgets-layer',
            style_class: 'guava-widgets-layer',
            reactive: false,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        this._outline = new St.Widget({ style_class: 'guava-widget-outline', visible: false, reactive: false });
        this.actor.add_child(this._outline);
        feature.desktopLayers.stack(this._cleanup, { id: 'widgets', rank: RANKS.widgets, actor: this.actor });
    }

    get cards() {
        return this._cards;
    }

    /** Show these items (all of this monitor) on this grid. */
    sync(items, grid) {
        this._grid = grid;
        const ids = new Set(items.map(i => i.id));
        for (const [id, card] of [...this._cards]) {
            const item = items.find(i => i.id === id);
            if (!ids.has(id) || card.item.size !== item.size || card.item.kind !== item.kind)
                this._drop(id);
        }
        for (const item of items) {
            let card = this._cards.get(item.id);
            const fresh = !card;
            if (fresh)
                card = this._create(item);
            else if (JSON.stringify(card.item.config) !== JSON.stringify(item.config))
                card.view.setConfig(item.config);
            card.item = item;
            if (this._drag?.id !== item.id)
                this._place(card, !fresh);
            if (fresh)
                this._appear(card);
        }
    }

    _create(item) {
        const cleanup = new CleanupRegistry();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const view = this._feature.host.createView(item.kind, { size: item.size, config: item.config, scale }, cleanup);
        this.actor.add_child(view.actor);
        const badge = new St.Button({
            style_class: 'guava-widget-remove',
            accessible_name: `${this._feature._('Remove')} ${this._feature._(view.def.title)}`,
            child: new St.Icon({ icon_name: 'list-remove-symbolic', icon_size: 12 }),
            visible: this._editing,
        });
        this.actor.add_child(badge);
        cleanup.add(() => badge.destroy());
        cleanup.connect(badge, 'clicked', () => this._feature.remove(item.id));
        const card = { view, badge, item, cleanup };
        cleanup.connect(view.actor, 'button-press-event', (_a, event) => this._press(card, event));
        cleanup.connect(view.actor, 'touch-event', (_a, event) => this._touch(card, event));
        this._cards.set(item.id, card);
        view.setActive(this._live);
        return card;
    }

    _drop(id) {
        const card = this._cards.get(id);
        if (!card)
            return;
        if (this._drag?.id === id)
            this._endDrag(false);
        this._cards.delete(id);
        card.cleanup.dispose();
    }

    _place(card, animate) {
        const r = rectOf(card.item, this._grid);
        const x = r.x - this.monitor.x;
        const y = r.y - this.monitor.y;
        if (animate && (card.view.actor.x !== x || card.view.actor.y !== y))
            this._ctx.motion.ease(card.view.actor, { x, y }, { duration: 'short', curve: 'standard' }, card.cleanup);
        else
            card.view.actor.set_position(x, y);
        card.badge.set_position(x - 8, y - 8);
    }

    _appear(card) {
        const a = card.view.actor;
        a.set_pivot_point(0.5, 0.5);
        a.set({ opacity: 0, scale_x: 0.85, scale_y: 0.85 });
        this._ctx.motion.ease(a, { opacity: 255, scale_x: 1, scale_y: 1 }, { duration: 'medium', curve: 'emphasized' }, card.cleanup);
    }

    // ---- look and life ----------------------------------------------------------------------

    /** Monochrome and dimmed, or full colour. One effect on the container, not per widget. */
    setLook(look) {
        if (look.mono === this._look.mono && look.opacity === this._look.opacity)
            return;
        this._look = look;
        const a = this.actor;
        let effect = a.get_effect(MONO_EFFECT);
        if (look.mono && !effect) {
            effect = new Clutter.DesaturateEffect({ factor: 0 });
            a.add_effect_with_name(MONO_EFFECT, effect);
        }
        const ms = this._ctx.motion.duration({ duration: 'long' });
        if (effect) {
            a.remove_transition(`@effects.${MONO_EFFECT}.factor`);
            const target = look.mono ? 1 : 0;
            const done = () => {
                if (!this._look.mono && a.get_effect(MONO_EFFECT))
                    a.remove_effect_by_name(MONO_EFFECT);
            };
            if (ms > 0) {
                a.ease_property(`@effects.${MONO_EFFECT}.factor`, target, {
                    duration: ms, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: done,
                });
            } else {
                effect.factor = target;
                done();
            }
        }
        this._ctx.motion.ease(a, { opacity: look.opacity }, { duration: 'long', curve: 'standard' }, this._cleanup);
    }

    get look() {
        return this._look;
    }

    /** Keep the widgets' data live (visible) or pause it (covered, overview). */
    setLive(live) {
        if (live === this._live)
            return;
        this._live = live;
        for (const card of this._cards.values())
            card.view.setActive(live);
    }

    get live() {
        return this._live;
    }

    setEditing(on) {
        this._editing = on;
        for (const card of this._cards.values())
            card.badge.visible = on;
        if (on)
            this.actor.add_style_class_name('guava-widgets-editing');
        else
            this.actor.remove_style_class_name('guava-widgets-editing');
    }

    // ---- pointer ------------------------------------------------------------------------------

    // Buttons inside a widget (Now Playing) act in place; the card itself drags or opens
    _onButton(card, event) {
        for (let a = global.stage.get_event_actor(event); a && a !== card.view.actor; a = a.get_parent()) {
            if (a instanceof St.Button)
                return true;
        }
        return false;
    }

    _press(card, event) {
        if (this._drag || this._onButton(card, event))
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._feature.openMenu(this, card, event.get_coords());
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._startPress(card, event.get_coords(), null);
        return Clutter.EVENT_STOP;
    }

    _touch(card, event) {
        if (event.type() !== Clutter.EventType.TOUCH_BEGIN || this._drag || this._onButton(card, event))
            return Clutter.EVENT_PROPAGATE;
        this._startPress(card, event.get_coords(), event.get_event_sequence());
        return Clutter.EVENT_STOP;
    }

    _startPress(card, [x, y], sequence) {
        const actor = card.view.actor;
        const grab = global.stage.grab(actor);
        const d = {
            id: card.item.id, card, grab, sequence, startX: x, startY: y,
            originX: actor.x, originY: actor.y, dragging: false, cleanup: new CleanupRegistry(),
        };
        this._drag = d;
        d.cleanup.connect(actor, 'motion-event', (_a, ev) => this._motion(ev));
        d.cleanup.connect(actor, 'button-release-event', (_a, ev) => this._release(ev));
        d.cleanup.connect(actor, 'touch-event', (_a, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.TOUCH_UPDATE)
                return this._motion(ev);
            if (t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.TOUCH_CANCEL)
                return this._release(ev);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _motion(event) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - d.startX;
        const dy = y - d.startY;
        if (!d.dragging) {
            if (!isDrag(dx, dy))
                return Clutter.EVENT_STOP;
            d.dragging = true;
            this.actor.set_child_above_sibling(d.card.view.actor, null);
            d.card.view.actor.add_style_class_name('guava-widget-dragging');
            d.card.badge.visible = false;
            this._outline.visible = true;
        }
        const nx = d.originX + dx;
        const ny = d.originY + dy;
        d.card.view.actor.set_position(nx, ny);
        const loose = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const target = this._feature.previewMove(d.id, nx + this.monitor.x, ny + this.monitor.y, loose);
        if (target) {
            this._outline.set_position(target.x - this.monitor.x, target.y - this.monitor.y);
            this._outline.set_size(target.width, target.height);
        }
        return Clutter.EVENT_STOP;
    }

    _release(event) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        if (!d.dragging) {
            this._endDrag(false);
            d.card.view.activate();
            return Clutter.EVENT_STOP;
        }
        const loose = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const a = d.card.view.actor;
        const px = a.x + this.monitor.x;
        const py = a.y + this.monitor.y;
        this._endDrag(true);
        this._feature.moved(d.id, px, py, loose);
        return Clutter.EVENT_STOP;
    }

    _endDrag(placed) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        d.cleanup.dispose();
        d.grab.dismiss();
        this._outline.visible = false;
        const card = this._cards.get(d.id);
        if (!card)
            return;
        card.view.actor.remove_style_class_name('guava-widget-dragging');
        card.badge.visible = this._editing;
        if (!placed)
            this._place(card, true);
    }

    /** Animate a card back to its stored place (a refused drop). */
    replace(id) {
        const card = this._cards.get(id);
        if (card)
            this._place(card, true);
    }

    destroy() {
        this._endDrag(false);
        for (const id of [...this._cards.keys()])
            this._drop(id);
        this._cleanup.dispose();
        this.actor.destroy();
    }
}
