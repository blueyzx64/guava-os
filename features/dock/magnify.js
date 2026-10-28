// SPDX-License-Identifier: GPL-3.0-or-later
// Dock magnification (macOS "Magnification", off by default). The icons near the pointer
// grow (model.magnify: a raised-cosine falloff) and move apart; the slab grows by the same
// amount on each side through two spacers at its ends, so the glass stays around the icons.
//
// No jitter: scales and offsets come from the rest layout, captured when the pointer enters
// (or the items change), never from the magnified one. Per pointer move: a few set_scale /
// translation writes and two spacer widths, into arrays allocated once per rest layout.
// The amount eases in and out through core/motion (tween), so it honours reduced motion and
// animations off like every Guava animation.
//
// Shell API: Clutter motion-event, transform_stage_point.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { magnify, magnifyScale } from './model.js';

// Icons grow away from the screen edge
const PIVOTS = Object.freeze({ bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5] });

export class Magnifier {
    /**
     * @param {object} host the Dock: motion, metrics, config, horizontal, position
     * @param {import('./view.js').DockView} view
     * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup the view build's registry
     */
    constructor(host, view, cleanup) {
        this._host = host;
        this._view = view;
        this._cleanup = cleanup;
        this._amount = 0;
        this._target = 0;
        this._tween = null;
        this._pointer = null;
        this._rest = null;
        this._out = { scales: [], offsets: [], before: 0, after: 0 };
        // Measured in the harness
        this.stats = { applies: 0, usTotal: 0 };
        cleanup.connect(view.frame, 'motion-event', (_a, event) => {
            this._pointerAt(event.get_coords());
            return Clutter.EVENT_PROPAGATE;
        });
        cleanup.add(() => {
            this._tween?.cancel();
            this._reset();
        });
    }

    get active() {
        return this._amount > 0;
    }

    /** The pointer entered or left the dock. */
    setHovered(hovered) {
        if (!this._host.config.magnification)
            hovered = false;
        const target = hovered ? 1 : 0;
        if (target === this._target)
            return;
        this._target = target;
        if (hovered && this._amount === 0)
            this._captureRest();
        this._tween?.cancel();
        const from = this._amount;
        this._tween = this._host.motion.tween(this._view.frame, {
            duration: 'short', curve: hovered ? 'standard' : 'move',
        }, p => {
            this._amount = from + (target - from) * p;
            this._apply();
        }, this._cleanup);
    }

    /** The items are about to change: restore the icons while they are alive. */
    invalidate() {
        if (!this.active)
            return;
        this._reset();
        this._amount = 0;
        this._target = 0;
        this._tween?.cancel();
    }

    /** The items changed: read the rest layout again if the pointer is still over the dock. */
    resume() {
        // The queued sync can run while the Shell tears the chrome down (shutdown)
        if (this._view.alive && this._view.frame.hover)
            this.setHovered(true);
    }

    _pointerAt([sx, sy]) {
        if (!this._rest)
            return;
        const [ok, x, y] = this._view.band.transform_stage_point(sx, sy);
        if (!ok)
            return;
        this._pointer = this._host.horizontal ? x : y;
        this._apply();
    }

    // Rest centres and sizes along the dock, in band coordinates (the band does not move)
    _captureRest() {
        const items = [...this._view.items()];
        const horizontal = this._host.horizontal;
        const n = items.length;
        const rest = {
            items, count: n,
            actors: items.map(i => i.actor),
            // The running dot keeps its size (macOS)
            keep: items.map(i => i.indicator ?? null),
            centres: new Float64Array(n), sizes: new Float64Array(n), weights: new Float64Array(n),
        };
        this._out.scales = new Float64Array(n);
        this._out.offsets = new Float64Array(n);
        const pivot = PIVOTS[this._host.position];
        const pill = this._view.pill;
        const [px, py] = pill.get_transformed_position();
        const [bx, by] = this._view.band.get_transformed_position();
        items.forEach((item, i) => {
            const a = item.actor;
            const start = horizontal ? px - bx + a.x : py - by + a.y;
            const size = horizontal ? a.width : a.height;
            rest.centres[i] = start + size / 2;
            rest.sizes[i] = size;
            rest.weights[i] = item.magnifies ? 1 : 0;
            a.set_pivot_point(pivot[0], pivot[1]);
            rest.keep[i]?.set_pivot_point(pivot[0], pivot[1]);
        });
        this._rest = rest;
    }

    _apply() {
        const rest = this._rest;
        if (!rest || this._pointer === null)
            return;
        const t0 = GLib.get_monotonic_time();
        const m = this._host.metrics;
        const out = magnify({
            centres: rest.centres, sizes: rest.sizes, weights: rest.weights, count: rest.count,
            pointer: this._pointer, tile: m.tile,
            maxScale: magnifyScale(m.icon, this._host.config.magnifiedSize), amount: this._amount,
        }, this._out);
        // The spacers grow the slab; it is centred on the edge, so the row moves by half the
        // growth; the translation puts each icon back where magnify() wants it
        // The total is rounded once: rounding both ends would move the slab by 1 px while the
        // pointer glides and the total stays the same
        const before = Math.round(out.before);
        const after = Math.round(out.before + out.after) - before;
        this._view.setGrowth(before, after);
        const drift = before - (before + after) / 2;
        const prop = this._host.horizontal ? 'translation_x' : 'translation_y';
        for (let i = 0; i < rest.count; i++) {
            const a = rest.actors[i];
            const s = out.scales[i];
            a.set_scale(s, s);
            a[prop] = out.offsets[i] - drift;
            rest.keep[i]?.set_scale(1 / s, 1 / s);
        }
        if (this._amount === 0 && this._target === 0)
            this._reset();
        this.stats.applies++;
        this.stats.usTotal += GLib.get_monotonic_time() - t0;
    }

    _reset() {
        const rest = this._rest;
        this._rest = null;
        this._pointer = null;
        if (!rest)
            return;
        rest.actors.forEach((a, i) => {
            if (!a.get_parent())
                return;
            a.set_scale(1, 1);
            a.translation_x = a.translation_y = 0;
            rest.keep[i]?.set_scale(1, 1);
        });
        this._view.setGrowth(0, 0);
    }
}
