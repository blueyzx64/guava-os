// SPDX-License-Identifier: GPL-3.0-or-later
// The look of a window clone drawn small: area-averaged downscale and rounded corners.
//
// Mutter samples a window's texture with a mipmap chain only on some paths, and a clone of a
// window actor that carries Guava's own corner effect samples that effect's 1:1 offscreen texture
// with plain bilinear filtering (see features/roundedCorners/effect.js): text in a thumbnail turns
// into scattered dark pixels. This effect puts the clone's own offscreen pass to use. That pass
// holds the window at full size (a scaled clone's allocation is the buffer), and the fragment
// shader averages the texels under each output pixel (a box filter, as many taps per axis as
// texels per pixel, at most 8) before the transform shrinks it. The corner mask is applied per
// tap in full-size texels, so the rounded corners are antialiased by the same average.
//
// The clone is scaled (set_scale), not resized: the effect follows its scale_x.
//
// Where Shell.GLSLEffect exists (48-50) the effect is one of those: its snippet sees the paint
// opacity (cogl_color_in), which the program-style ShaderEffect of those versions ignores, so a
// fading ancestor (the scrolling strip's cards) still fades the thumbnail. On 51 it is a snippet
// ShaderEffect, which does.

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

import { GLSL_EFFECT, createShaderEffect } from '../../lib/compat.js';

const MAX_TAPS = 8;

const DECLARATIONS = `
uniform float guava_w;
uniform float guava_h;
uniform float guava_x0;
uniform float guava_y0;
uniform float guava_x1;
uniform float guava_y1;
uniform float guava_r;
uniform float guava_tl;
uniform float guava_tr;
uniform float guava_br;
uniform float guava_bl;
uniform float guava_k;

float guava_mask(vec2 p) {
    vec2 c = clamp(p, vec2(guava_x0, guava_y0) + vec2(guava_r), vec2(guava_x1, guava_y1) - vec2(guava_r));
    vec2 d = p - c;
    if (guava_r <= 0.0 || d.x == 0.0 || d.y == 0.0)
        return 1.0;
    float on = d.y < 0.0 ? (d.x < 0.0 ? guava_tl : guava_tr) : (d.x > 0.0 ? guava_br : guava_bl);
    if (on < 0.5)
        return 1.0;
    return length(d) <= guava_r ? 1.0 : 0.0;
}
`;

const EFFECT_FN = `
vec4 guava_effect(vec2 uv, vec4 color) {
    vec2 size = vec2(guava_w, guava_h);
    vec2 p0 = uv * size;
    float n = clamp(ceil(guava_k), 1.0, ${MAX_TAPS}.0);
    vec4 sum = vec4(0.0);
    for (int i = 0; i < ${MAX_TAPS}; i++) {
        if (float(i) >= n)
            break;
        for (int j = 0; j < ${MAX_TAPS}; j++) {
            if (float(j) >= n)
                break;
            vec2 o = (vec2(float(i), float(j)) + 0.5) / n - 0.5;
            vec2 p = p0 + o * guava_k;
            sum += guava_sample(p / size) * guava_mask(p);
        }
    }
    return sum / (n * n);
}
`;

const GLSL_CODE = `
cogl_color_out = guava_effect(cogl_tex_coord_in[0].xy, cogl_color_out) * cogl_color_in;
if (cogl_color_out.a > 0.0)
    cogl_color_out.rgb /= cogl_color_out.a;
`;

let _Glsl = null;

// Shell.GLSLEffect subclass, registered on first use; null where Shell.GLSLEffect is gone
function glslClass() {
    if (_Glsl || !GLSL_EFFECT)
        return _Glsl;
    _Glsl = GObject.registerClass(
    class GuavaThumbEffect extends GLSL_EFFECT {
        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, `${DECLARATIONS}
                vec4 guava_sample(vec2 uv) { return texture2D(cogl_sampler0, uv); }
                ${EFFECT_FN}`, GLSL_CODE, false);
        }
    });
    return _Glsl;
}

// The effect and a setter for its float uniforms, or null where no shader API works
function createEffect() {
    const Glsl = glslClass();
    if (Glsl) {
        const effect = new Glsl();
        return { effect, set: (name, v) => effect.set_uniform_float(effect.get_uniform_location(name), 1, [v]) };
    }
    const effect = createShaderEffect({ declarations: DECLARATIONS, effectFn: EFFECT_FN });
    // set_uniform_value takes a float; an integral JS number would become an int uniform
    return effect ? { effect, set: (name, v) => effect.set_uniform_value(name, v + 1e-4) } : null;
}

/**
 * The corners to cut from the rounded-corners settings (their ranges: radius 0-24, 'top' or 'all').
 * @returns {{radius: number, mask: number[]}} radius 0 when rounding is off
 */
export function cornerSpec({ enabled, radius, which }) {
    return {
        radius: enabled ? Math.max(0, Math.min(24, radius)) : 0,
        mask: which === 'all' ? [1, 1, 1, 1] : [1, 1, 0, 0],
    };
}

/**
 * Put the effect on a scaled clone of a window actor. It follows the clone's scale_x.
 * @param {Clutter.Clone} clone sized to the window's buffer, scaled with set_scale
 * @param {{width: number, height: number}} buffer
 * @param {{x: number, y: number, width: number, height: number}} frame inside the buffer
 * @param {{radius: number, mask: number[]}} corners from cornerSpec()
 * @returns {boolean} false where shaders are unavailable (the clone is left as it is)
 */
export function attachThumbEffect(clone, buffer, frame, corners) {
    const made = createEffect();
    if (!made)
        return false;
    const f = made.set;
    f('guava_w', buffer.width);
    f('guava_h', buffer.height);
    f('guava_x0', frame.x);
    f('guava_y0', frame.y);
    f('guava_x1', frame.x + frame.width);
    f('guava_y1', frame.y + frame.height);
    f('guava_r', corners.radius);
    ['tl', 'tr', 'br', 'bl'].forEach((k, i) => f(`guava_${k}`, corners.mask[i]));
    const follow = () => f('guava_k', 1 / Math.max(clone.scale_x, 0.01));
    follow();
    clone.connect('notify::scale-x', follow);
    clone.add_effect(made.effect);
    return true;
}
