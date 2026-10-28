// SPDX-License-Identifier: GPL-3.0-or-later
// The snap bar of the drag (Windows 11 Snap Layouts): drag a window to the top centre and a small
// handle slides down under the top bar; move onto it and it expands into a row of layout
// thumbnails; the zone under the pointer lights up in the accent colour. A view: drag.js feeds
// it the pointer, snapModel.js decides the state and the zone, and this draws and animates.
//
// While a window is dragged, the Shell sends no hover to other actors (the move grab owns the
// pointer), so the zone under the pointer is found from its position (snapModel.snapZoneAt) and
// its highlight is an accent overlay whose opacity is sprung.
//
// Motion: every transition is a core/motion spring (reveal, expand, collapse, highlight). The
// corner radius follows the bar's width, so size and corners morph as one. Under reduced
// motion the springs become crossfades (core/motion).
//
// Shell API: St, Clutter.FixedLayout, Main.uiGroup (above the windows), Glass.attach (faux
// glass), core/motion.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Glass } from '../../lib/glass.js';
import {
    HANDLE_H, HANDLE_W, SNAP_STATES, TOP_GAP, nextSnapState, radiusAt, snapGeometry, snapZoneAt,
} from './snapModel.js';

// The grabber line drawn on the handle (px)
const GRAB_W = 36;
const GRAB_H = 4;
// How far above its place the handle starts: its own height and the gap, so it slides out from under the top bar
const SLIDE_PX = HANDLE_H + TOP_GAP;

export class SnapBar {
    /**
     * @param {object} ctx the extension ctx (motion, gettext)
     * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup
     */
    constructor(ctx, cleanup) {
        this._motion = ctx.motion;
        this._ = ctx.gettext ?? (s => s);
        this._cleanup = cleanup;
        this._bar = null;
        this._grab = null;
        this._content = null;
        this._cells = new Map();   // 'layout/zone' -> {hl, anim}
        this._geom = null;
        this._geomKey = '';
        this._state = SNAP_STATES.HIDDEN;
        this._lit = null;          // key of the lit cell
        this._radius = -1;
        this._anims = {};          // slot -> running spring handle
    }

    /** True from the moment the handle is wanted until the pointer has left it. */
    get visible() {
        return this._state !== SNAP_STATES.HIDDEN;
    }

    /**
     * Follow the pointer.
     *
     * @param {{x: number, y: number}} p
     * @param {{x, y, width, height}} monitor
     * @param {number} topEdge the top bar's bottom edge
     * @returns {?string} the zone under the pointer while the bar is expanded, else null
     */
    update(p, monitor, topEdge) {
        const geom = this._geometry(monitor, topEdge);
        this._go(nextSnapState(this._state, p, geom));
        const hit = this._state === SNAP_STATES.BAR ? snapZoneAt(p, geom) : null;
        this._light(hit ? `${hit.layoutId}/${hit.zone}` : null);
        return hit?.zone ?? null;
    }

    /** The drag is over: collapse and hide. */
    close() {
        this._light(null);
        this._go(SNAP_STATES.HIDDEN);
    }

    _geometry(monitor, topEdge) {
        const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height},${topEdge}`;
        if (key === this._geomKey)
            return this._geom;
        // Another monitor or bar height: the old bar goes at once and the new one is built
        this._cancelAll();
        this._state = SNAP_STATES.HIDDEN;
        this._bar?.hide();
        this._geomKey = key;
        this._geom = snapGeometry(monitor, topEdge);
        this._build();
        return this._geom;
    }

    _go(next) {
        const prev = this._state;
        if (next === prev)
            return;
        this._state = next;
        switch (next) {
        case SNAP_STATES.HANDLE:
            this._toHandle(null);
            break;
        case SNAP_STATES.BAR:
            this._expand();
            break;
        default:
            if (prev === SNAP_STATES.BAR) {
                this._toHandle(() => {
                    if (this._state === SNAP_STATES.HIDDEN)
                        this._fadeOut();
                });
            } else {
                this._fadeOut();
            }
        }
    }

    // Reveal the handle (from nothing, or back from the bar)
    _toHandle(onDone) {
        const { handle } = this._geom;
        const bar = this._bar;
        if (!bar.visible) {
            bar.set_position(handle.x, handle.y);
            bar.set_size(handle.width, handle.height);
            bar.opacity = 0;
            bar.translation_y = -SLIDE_PX;
            this._content.opacity = 0;
            this._grab.opacity = 255;
            bar.show();
        }
        this._spring('rect', bar, { x: handle.x, width: handle.width, height: handle.height }, 'smooth', onDone);
        this._spring('slide', bar, { translation_y: 0 }, 'snappy');
        this._spring('fade', bar, { opacity: 255 }, 'quick');
        this._spring('content', this._content, { opacity: 0 }, 'quick');
        this._spring('grab', this._grab, { opacity: 255 }, 'quick');
    }

    _expand() {
        const { bar: rect } = this._geom;
        this._spring('rect', this._bar, { x: rect.x, width: rect.width, height: rect.height }, 'snappy');
        this._spring('content', this._content, { opacity: 255 }, 'quick');
        this._spring('grab', this._grab, { opacity: 0 }, 'quick');
    }

    _fadeOut() {
        const bar = this._bar;
        this._spring('slide', bar, { translation_y: -SLIDE_PX }, 'smooth');
        this._spring('fade', bar, { opacity: 0 }, 'quick', finished => {
            if (finished && this._state === SNAP_STATES.HIDDEN)
                bar.hide();
        });
    }

    // Light the cell `key` (null: none) and dim the one that was lit
    _light(key) {
        if (key === this._lit)
            return;
        for (const [k, to] of [[this._lit, 0], [key, 255]]) {
            const cell = k && this._cells.get(k);
            if (!cell)
                continue;
            cell.anim?.cancel();
            cell.anim = this._motion.spring(cell.hl, 'opacity', to, { spring: 'quick' }, this._cleanup);
        }
        this._lit = key;
    }

    // One spring group per slot: a new one replaces the running one
    _spring(slot, actor, targets, spring, onDone) {
        this._anims[slot]?.cancel();
        this._anims[slot] = this._motion.springs(actor, targets, { spring, onDone }, this._cleanup);
    }

    _cancelAll() {
        for (const anim of Object.values(this._anims))
            anim.cancel();
        this._anims = {};
        for (const cell of this._cells.values())
            cell.anim?.cancel();
        this._lit = null;
    }

    _syncRadius() {
        const r = radiusAt(this._bar.width, this._geom.bar.width);
        if (r === this._radius)
            return;
        this._radius = r;
        this._bar.set_style(`border-radius: ${r}px;`);
    }

    // The actors persist across drags; the thumbnails are rebuilt when the geometry changes
    _build() {
        if (!this._bar) {
            const bar = new St.Widget({
                style_class: 'guava-snap-bar', layout_manager: new Clutter.FixedLayout(),
                visible: false, reactive: false, clip_to_allocation: true,
            });
            this._cleanup.connect(bar, 'notify::width', () => this._syncRadius());
            const glass = Glass.attach(bar, { surface: 'menus', role: 'content' });
            this._cleanup.add(() => glass.destroy());
            this._grab = new St.Widget({
                style_class: 'guava-snap-grab', width: GRAB_W, height: GRAB_H,
                x: Math.round((HANDLE_W - GRAB_W) / 2), y: Math.round((HANDLE_H - GRAB_H) / 2),
            });
            this._content = new St.Widget({ layout_manager: new Clutter.FixedLayout(), opacity: 0 });
            bar.add_child(this._content);
            bar.add_child(this._grab);
            Main.uiGroup.add_child(bar);
            this._cleanup.actor(bar);
            this._bar = bar;
        }
        this._radius = -1;
        this._content.destroy_all_children();
        this._cells.clear();
        const { bar, thumbs } = this._geom;
        this._content.set_size(bar.width, bar.height);
        for (const thumb of thumbs) {
            const frame = new St.Widget({
                style_class: 'guava-snap-thumb', layout_manager: new Clutter.FixedLayout(),
                x: thumb.rect.x, y: thumb.rect.y, width: thumb.rect.width, height: thumb.rect.height,
                accessible_name: this._(thumb.name),
            });
            for (const { zone, rect } of thumb.zones) {
                const cell = new St.Widget({
                    style_class: 'guava-snap-zone', layout_manager: new Clutter.FixedLayout(),
                    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                });
                const hl = new St.Widget({
                    style_class: 'guava-snap-zone-lit', width: rect.width, height: rect.height, opacity: 0,
                });
                cell.add_child(hl);
                frame.add_child(cell);
                this._cells.set(`${thumb.id}/${zone}`, { hl, anim: null });
            }
            this._content.add_child(frame);
        }
    }
}
