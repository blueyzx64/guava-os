// SPDX-License-Identifier: GPL-3.0-or-later
// The Genie: an offscreen effect that draws the window as thin strips, one per line of the
// window across the funnel. Each strip is a textured rectangle whose width, centre and place
// come from model.genieRow(), so the window's edge nearest the dock narrows into a funnel and
// slides into the icon. The window is painted once into the effect's buffer; per frame only the
// strips move (the arrays are reused, nothing is allocated).
//
// The effect sits on a container exactly as big as `reach` (the window and its target) holding
// a clone of the window: the funnel never leaves the container's box, which is what Clutter's
// offscreen effects can draw into (on GNOME 50 the window actor itself cuts the funnel off at
// the window's own edges).
//
// Shell API: Clutter.OffscreenEffect (get_pipeline, get_target_size, vfunc_paint_target),
// Clutter.PipelineNode (add_texture_rectangle), Cogl.Pipeline.set_color (premultiplied); checked on GNOME 50.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

import { genieRow } from './model.js';

// At most this many strips: about one per pixel of a window's height, enough for an edge
// without steps
const MAX_STRIPS = 720;

export const GenieEffect = GObject.registerClass({
    GTypeName: 'GuavaGenieEffect',
}, class GenieEffect extends Clutter.OffscreenEffect {
    /**
     * @param {object} frame model.genieFrame()
     * @param {{x,y,width,height}} reach the container's stage rect (whole pixels)
     */
    _init(frame, reach) {
        super._init();
        this._frame = frame;
        this._reach = reach;
        // Where the window sits in the container
        this._offX = frame.winX - reach.x;
        this._offY = frame.winY - reach.y;
        this._strips = Math.min(MAX_STRIPS, Math.max(1, Math.ceil(frame.extent)));
        // Per edge between strips: where it falls; per strip: its centre and width along the dock
        this._edge = new Float64Array(this._strips + 1);
        this._centre = new Float64Array(this._strips);
        this._width = new Float64Array(this._strips);
        this._row = { s: 0, centre: 0, width: 0 };
        this._box = new Clutter.ActorBox();
        this._color = new Cogl.Color();
        this.progress = 0;
        this._layout();
    }

    setProgress(p) {
        if (p === this.progress)
            return;
        this.progress = p;
        this._layout();
        this.queue_repaint();
    }

    // The funnel at the current progress, in stage coordinates
    _layout() {
        const f = this._frame;
        const n = this._strips;
        const row = this._row;
        for (let i = 0; i <= n; i++)
            this._edge[i] = genieRow(f, i / n, this.progress, row).s;
        for (let i = 0; i < n; i++) {
            genieRow(f, (i + 0.5) / n, this.progress, row);
            this._centre[i] = row.centre;
            this._width[i] = row.width;
        }
    }

    vfunc_paint_target(node, _paintContext) {
        const [ok, texWidth] = this.get_target_size();
        if (!ok)
            return;
        const reach = this._reach;
        const f = this._frame;
        // Buffer pixels per logical pixel (the monitor's scale)
        const k = texWidth / reach.width;
        const pipeline = this.get_pipeline();
        const a = this.get_actor().get_paint_opacity() / 255;
        this._color.init_from_4f(a, a, a, a);
        pipeline.set_color(this._color);
        const strips = Clutter.PipelineNode.new(pipeline);
        node.add_child(strips);

        const n = this._strips;
        const box = this._box;
        const cw = reach.width;
        const ch = reach.height;
        const position = f.position;
        const across0 = position === 'bottom' ? this._offY : this._offX;
        const acrossLen = position === 'bottom' ? f.winH : f.winW;
        const acrossFull = position === 'bottom' ? ch : cw;
        const alongFull = position === 'bottom' ? cw : ch;
        const along0 = position === 'bottom' ? this._offX : this._offY;
        const alongLen = position === 'bottom' ? f.winW : f.winH;
        for (let i = 0; i < n; i++) {
            const d0 = i / n;
            const d1 = (i + 1) / n;
            const s0 = this._edge[i];
            const s1 = this._edge[i + 1];
            const half = this._width[i] / 2;
            const lo = this._centre[i] - half;
            const hi = this._centre[i] + half;
            // The strip's span across the funnel, in the container's coordinates
            let a0, a1, t0, t1;
            if (position === 'left') {
                a0 = -s1 - reach.x;
                a1 = -s0 - reach.x;
                t0 = across0 + (1 - d1) * acrossLen;
                t1 = across0 + (1 - d0) * acrossLen;
            } else if (position === 'right') {
                a0 = s0 - reach.x;
                a1 = s1 - reach.x;
                t0 = across0 + d0 * acrossLen;
                t1 = across0 + d1 * acrossLen;
            } else {
                a0 = s0 - reach.y;
                a1 = s1 - reach.y;
                t0 = across0 + d0 * acrossLen;
                t1 = across0 + d1 * acrossLen;
            }
            const l0 = lo - (position === 'bottom' ? reach.x : reach.y);
            const l1 = hi - (position === 'bottom' ? reach.x : reach.y);
            const u0 = along0 / alongFull;
            const u1 = (along0 + alongLen) / alongFull;
            if (position === 'bottom') {
                box.set_origin(l0 * k, a0 * k);
                box.set_size((l1 - l0) * k, (a1 - a0) * k);
                strips.add_texture_rectangle(box, u0, t0 / acrossFull, u1, t1 / acrossFull);
            } else {
                box.set_origin(a0 * k, l0 * k);
                box.set_size((a1 - a0) * k, (l1 - l0) * k);
                strips.add_texture_rectangle(box, t0 / acrossFull, u0, t1 / acrossFull, u1);
            }
        }
    }
});
