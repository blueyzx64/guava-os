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
// the window's own edges). The texture is at the monitor's scale (rounded up) and covers the
// container's box padded by Clutter for effects (model.textureBox): the strips map through
// that box, so at rest every texel lands on one device pixel (sharp at any scale).
//
// Shell API: Clutter.OffscreenEffect (get_pipeline, get_target_size, vfunc_paint_target),
// Clutter.Actor.get_resource_scale,
// Clutter.PipelineNode (add_texture_rectangle), Cogl.Pipeline.set_color (premultiplied); checked on GNOME 50.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

import { genieRow, textureBox } from './model.js';

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
        const [ok, texWidth, texHeight] = this.get_target_size();
        if (!ok)
            return;
        const f = this._frame;
        // The texture covers the actor's paint box, which Clutter enlarges for effects (a few
        // pixels past the container): map through it so every texel lands on one pixel
        const actor = this.get_actor();
        const box = textureBox(this._reach, texWidth, texHeight, actor.get_resource_scale());
        const kx = texWidth / box.width;
        const ky = texHeight / box.height;
        this.map = { x: box.x, y: box.y, width: box.width, height: box.height, texWidth, texHeight };
        const pipeline = this.get_pipeline();
        const a = actor.get_paint_opacity() / 255;
        this._color.init_from_4f(a, a, a, a);
        pipeline.set_color(this._color);
        const strips = Clutter.PipelineNode.new(pipeline);
        node.add_child(strips);

        const n = this._strips;
        const rect = this._box;
        const position = f.position;
        const bottom = position === 'bottom';
        // Across the funnel (towards the dock) and along it, relative to the texture's box
        const acrossOrigin = bottom ? box.y : box.x;
        const alongOrigin = bottom ? box.x : box.y;
        const across0 = (bottom ? f.winY : f.winX) - acrossOrigin;
        const acrossLen = bottom ? f.winH : f.winW;
        const acrossFull = bottom ? box.height : box.width;
        const along0 = (bottom ? f.winX : f.winY) - alongOrigin;
        const alongFull = bottom ? box.width : box.height;
        const u0 = along0 / alongFull;
        const u1 = (along0 + (bottom ? f.winW : f.winH)) / alongFull;
        for (let i = 0; i < n; i++) {
            const d0 = i / n;
            const d1 = (i + 1) / n;
            const s0 = this._edge[i];
            const s1 = this._edge[i + 1];
            const half = this._width[i] / 2;
            // The strip's span across the funnel and the line of the window it shows
            let a0, a1, t0, t1;
            if (position === 'left') {
                a0 = -s1 - acrossOrigin;
                a1 = -s0 - acrossOrigin;
                t0 = across0 + (1 - d1) * acrossLen;
                t1 = across0 + (1 - d0) * acrossLen;
            } else {
                a0 = s0 - acrossOrigin;
                a1 = s1 - acrossOrigin;
                t0 = across0 + d0 * acrossLen;
                t1 = across0 + d1 * acrossLen;
            }
            const l0 = this._centre[i] - half - alongOrigin;
            const l1 = this._centre[i] + half - alongOrigin;
            if (bottom) {
                rect.set_origin(l0 * kx, a0 * ky);
                rect.set_size((l1 - l0) * kx, (a1 - a0) * ky);
                strips.add_texture_rectangle(rect, u0, t0 / acrossFull, u1, t1 / acrossFull);
            } else {
                rect.set_origin(a0 * kx, l0 * ky);
                rect.set_size((a1 - a0) * kx, (l1 - l0) * ky);
                strips.add_texture_rectangle(rect, t0 / acrossFull, u0, t1 / acrossFull, u1);
            }
        }
    }
});
