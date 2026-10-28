// SPDX-License-Identifier: GPL-3.0-or-later
// The per-window corner mask: a Shell.GLSLEffect (an OffscreenEffect) on the MetaWindowActor.
//
// The actor (window, CSD shadow margins, SSD shadow, subsurfaces) is rendered into the effect's
// texture, then drawn through this fragment snippet. Only the corner quadrants around the
// window's *frame* rect that the corner mask selects are touched (the area beyond the arc
// centres, inside and outside the frame); everything else, including the shadow along the
// straight edges and the corners left square ('top' mode keeps the bottom ones), passes through
// unchanged.
//
// In a corner quadrant, a pixel near or outside the rounded-rect boundary is not cut to
// transparent, which would leave a square notch in the shadow and the 1px CSD outline standing
// around a rounded corner. It takes the texel found at the same signed distance from the
// straight frame edges (the side and the top or bottom, blended by the angle, filtered linearly
// by hand). So the window's own edge (content, outline, shadow) bends around the arc, and the
// arc is antialiased like the straight edge. Pixels deeper inside than a 3-pixel band keep
// their content. Windows without a shadow find transparent padding beyond the edge and get
// clean transparent corners. When the app already rounds a corner at least as much as the
// setting (libadwaita), a probe just inside the arc is transparent and the corner is left as
// the app drew it.
//
// Coordinates: the snippet works in texture pixels. The texture covers the enlarged bounding box
// of the actor's local paint volume at ceil(resource scale) (mutter 50
// clutter_offscreen_effect_pre_paint, mirrored by model.fboOrigin). That box can change without
// a signal (an X11 shadow grows on focus), so paint_target re-checks the texture size and
// recomputes when it differs.
//
// Clones (overview, Stage Manager strip and flights) do not use the effect: a clone would draw
// the effect's 1:1 texture scaled down with plain bilinear filtering (no mipmaps), which aliases
// and blurs every thumbnail. Without the effect, a clone samples mutter's own window texture,
// which mutter mipmaps below half size. Thumbnails keep the corners the app drew itself.

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';

import { GLSL_EFFECT } from '../../lib/compat.js';
import { fboOrigin, shaderGeometry } from './model.js';

export const EFFECT_NAME = 'guava-rounded-corners';

const DECLARATIONS = `
uniform vec2 guava_tex;
uniform vec4 guava_frame;
uniform float guava_radius;
uniform float guava_aa;
uniform vec4 guava_corners;

vec4 guava_raw(vec2 px) {
    if (px.x < 0.0 || px.y < 0.0 || px.x > guava_tex.x || px.y > guava_tex.y)
        return vec4(0.0);
    return texture2D(cogl_sampler0, px / guava_tex);
}

// Linear filtering along one axis, by hand: the texture is sampled NEAREST at integer scales
vec4 guava_lin(vec2 px, vec2 axis) {
    float f = fract(dot(px, axis) - 0.5);
    vec2 p0 = px - axis * f;
    return mix(guava_raw(p0), guava_raw(p0 + axis), f);
}
`;

// p: this pixel; c: the nearest corner-arc centre (p clamped into the frame shrunk by r).
// d.x and d.y both non-zero means p is in one of the four corner quadrants, inside or outside
// the frame. probe: a point just inside the arc on the corner's diagonal; transparent there
// means the app already rounds this corner at least as much, so it is left alone.
// guava_corners: which corners are rounded, 1 or 0 for top-left, top-right, bottom-right,
// bottom-left (texture y grows downwards, like the frame rect).
const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * guava_tex;
float r = guava_radius;
vec2 c = clamp(p, guava_frame.xy + vec2(r), guava_frame.zw - vec2(r));
vec2 d = p - c;
vec2 sg = sign(d);
float on = sg.y < 0.0 ? (sg.x < 0.0 ? guava_corners.x : guava_corners.y)
                      : (sg.x > 0.0 ? guava_corners.z : guava_corners.w);
if (r > 0.0 && d.x != 0.0 && d.y != 0.0 && on > 0.5) {
    vec2 probe = c + sg * (r * 0.7071 - 0.5 * guava_aa);
    float dist = length(d) - r;
    float band = 3.0 * guava_aa;
    if (dist > -band - guava_aa && guava_raw(probe).a > 0.5) {
        vec2 cc = floor(c) + 0.5;
        vec4 side = guava_lin(vec2(sg.x > 0.0 ? guava_frame.z + dist : guava_frame.x - dist, cc.y), vec2(1.0, 0.0));
        vec4 top = guava_lin(vec2(cc.x, sg.y > 0.0 ? guava_frame.w + dist : guava_frame.y - dist), vec2(0.0, 1.0));
        vec2 w = d * d;
        vec4 edge = mix(top, side, w.x / (w.x + w.y)) * cogl_color_in;
        cogl_color_out = mix(cogl_color_out, edge, clamp((dist + band + guava_aa) / guava_aa, 0.0, 1.0));
    }
}
if (cogl_color_out.a > 0.0)
    cogl_color_out.rgb /= cogl_color_out.a;
`;

let _Effect = null;

/**
 * The effect class, registered on first use (Shell.GLSLEffect is gone on 51).
 *
 * @returns {?typeof GObject.Object} null where Shell.GLSLEffect does not exist
 */
export function effectClass() {
    if (_Effect || !GLSL_EFFECT)
        return _Effect;
    _Effect = GObject.registerClass(
    class GuavaRoundedCornersEffect extends GLSL_EFFECT {
        constructor() {
            super();
            this._loc = {
                tex: this.get_uniform_location('guava_tex'),
                frame: this.get_uniform_location('guava_frame'),
                radius: this.get_uniform_location('guava_radius'),
                aa: this.get_uniform_location('guava_aa'),
                corners: this.get_uniform_location('guava_corners'),
            };
            this._frame = null;   // frame in actor-local logical px
            this._radius = 0;
            this._corners = [1, 1, 1, 1];
            this._key = '';       // texture size and scale the uniforms were computed for
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
        }

        /**
         * @param {{x: number, y: number, width: number, height: number}} frame actor-local
         * @param {number} radius logical px
         * @param {number[]} corners model.cornerMask(): 1 or 0 for TL, TR, BR, BL
         */
        setGeometry(frame, radius, corners) {
            const same = this._frame && this._radius === radius &&
                corners.every((v, i) => this._corners[i] === v) &&
                ['x', 'y', 'width', 'height'].every(k => this._frame[k] === frame[k]);
            if (same)
                return;
            this._frame = frame;
            this._radius = radius;
            this._corners = [...corners];
            this._key = '';
            this.queue_repaint();
        }

        _update(actor, texWidth, texHeight) {
            // get_resource_scale() is the ceiled scale the texture is drawn at; the monitor's
            // own (fractional) scale sets how wide one screen pixel is for the antialiasing
            const win = actor.meta_window;
            const monitor = win?.get_monitor() ?? -1;
            const scale = monitor >= 0 ? global.display.get_monitor_scale(monitor) : actor.get_resource_scale();
            const key = `${texWidth}x${texHeight}@${scale}`;
            if (key === this._key)
                return;
            this._key = key;
            const pv = actor.get_paint_volume();
            const origin = pv ? pv.get_origin() : null;
            const volume = pv ? { x: origin.x, y: origin.y, width: pv.get_width(), height: pv.get_height() } : null;
            const box = actor.get_allocation_box();
            const g = shaderGeometry({
                frame: this._frame,
                origin: fboOrigin(volume, { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 }),
                radius: this._radius,
                resourceScale: scale,
                texWidth,
                texHeight,
            });
            this.set_uniform_float(this._loc.tex, 2, g.tex);
            this.set_uniform_float(this._loc.frame, 4, g.frame);
            this.set_uniform_float(this._loc.radius, 1, [g.radius]);
            this.set_uniform_float(this._loc.aa, 1, [g.aa]);
            this.set_uniform_float(this._loc.corners, 4, this._corners);
        }

        vfunc_pre_paint(node, paintContext) {
            if (this.get_actor()?.is_in_clone_paint())
                return false;
            return super.vfunc_pre_paint(node, paintContext);
        }

        vfunc_paint_target(node, paintContext) {
            const actor = this.get_actor();
            if (actor && this._frame) {
                const [ok, w, h] = this.get_target_size();
                if (ok)
                    this._update(actor, w, h);
            }
            super.vfunc_paint_target(node, paintContext);
        }
    });
    return _Effect;
}
