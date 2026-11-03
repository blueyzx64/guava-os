// SPDX-License-Identifier: GPL-3.0-or-later
// GlassBlurEffect: the real backdrop of Guava's Liquid Glass (lib/glass.js attaches it; the
// numbers come from lib/glassParams.js). One Clutter.Effect on the surface actor itself paints,
// before the actor's own content:
//   1. a copy of what is behind the surface, read from the stage view's framebuffer at device
//      pixels (fractional scaling included), with a margin around it so the edges blur
//      naturally;
//   2. a Gaussian blur (Clutter.BlurNode) at a reduced size where the blur hides it
//      (glassParams.downscaleFor), then
//   3. one pipeline: saturation boost, brightness (dark glass) or lift (light glass), the tint
//      gradient laid over it, the rounded-rect mask (no square corners) and the presence
//      (0..1, for fades such as the menu bar leaving Mission Control).
// Without a backdrop (blur off, Reduce Transparency, contrast) the same pipeline draws the tint
// alone, so every tier fades the same way.
//
// Cost: steps 1-2 run only when the backdrop can have changed. 'auto' surfaces (menu bar,
// dock) keep their last blur while only the wallpaper lies behind them (no window actor
// overlaps), and recapture for a short while after invalidate() (wallpaper, monitors, overview);
// 'live' surfaces (menus, overlays) recapture whenever they are painted. Clutter paints a
// surface only when something in its area changed, so a window moving elsewhere costs nothing.
// Under load (LoadGovernor) live recapture freezes: the last blur stays on screen.
// Screenshots and screencasts paint without a stage view: they get the last blur.
//
// The idea of reading the stage view's framebuffer (an ancestor painted offscreen, a menu fading
// in, holds nothing of what is behind it) and of capturing outside the redraw clip comes from
// Blur my Shell (GPL-3.0, Aurélien Hamy and contributors, src/render/backdrop/capture.js); the
// node layout follows GNOME Shell's ShellBlurEffect (GPL-2.0+, src/shell-blur-effect.c).
//
// Shell API: Clutter.Effect vfunc_paint_node, Clutter.BlitNode / BlurNode / LayerNode /
// PipelineNode, stage before-paint (the view), Cogl offscreens and snippets.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';

import { LoadGovernor, downscaleFor, liveCaptureDue } from './glassParams.js';

/** Live recapture keeps going this long after invalidate() (the wallpaper cross-fade is 1 s). */
const SETTLE_MS = 1500;

const DECLARATIONS = `
uniform vec2 g_size;
uniform vec4 g_uv;
uniform float g_radius;
uniform float g_scale;
uniform float g_sat;
uniform float g_bright;
uniform float g_lift;
uniform float g_blur;
uniform float g_alpha;
uniform vec4 g_top;
uniform vec4 g_bottom;
`;

// cogl_tex_coord0_in spans the captured texture; g_uv maps it back to the surface (0..1)
const SOURCE = `
vec2 uv = (cogl_tex_coord0_in.st - g_uv.xy) / g_uv.zw;
vec3 back = cogl_color_out.rgb;
float l = dot(back, vec3(0.2126, 0.7152, 0.0722));
back = clamp(mix(vec3(l), back, g_sat), 0.0, 1.0) * g_bright;
back = back + (vec3(1.0) - back) * g_lift;
vec4 tint = mix(g_top, g_bottom, clamp(uv.y, 0.0, 1.0));
vec3 rgb = mix(back, tint.rgb, tint.a);
float a = 1.0;
if (g_blur < 0.5) {
    rgb = tint.rgb;
    a = tint.a;
}
vec2 p = uv * g_size;
vec2 h = g_size * 0.5;
vec2 q = abs(p - h) - (h - vec2(g_radius));
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - g_radius;
float m = clamp(0.5 - d * g_scale, 0.0, 1.0);
cogl_color_out = vec4(rgb * a, a) * (m * g_alpha);
`;

let _snippet = null;
function snippet() {
    _snippet ??= Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, SOURCE);
    return _snippet;
}

// The stage view being painted (ClutterPaintContext.get_stage_view is not introspected):
// set from the stage's before-paint, cleared after-paint (lib/glass.js connects them), so a
// screenshot or screencast painted outside a view never reads a stale framebuffer.
let paintedView = null;

/** stage 'before-paint' (view) / 'after-paint' (null). */
export function setPaintedView(view) {
    paintedView = view;
}

let onFailure = null;

/** fn() runs once when a paint fails, so the service can bring the St fills back. */
export function setFailureHandler(fn) {
    onFailure = fn;
}

/** One governor for every live surface: load is global. */
export const governor = new LoadGovernor();

let degraded = false;

/** The frame budget is blown (ctx.motion.env.degraded): live surfaces refresh their blur slowly. */
export function setDegraded(on) {
    degraded = !!on;
}

/** Is the API there (Shell 50 has it; a missing piece means St fills only). */
export function blurSupported() {
    return !!(Clutter.BlurNode && Clutter.BlitNode && Clutter.LayerNode?.new_to_framebuffer &&
        Cogl.Offscreen?.new_with_texture && Cogl.Texture2D?.new_with_size);
}

function setupProjection(fb, width, height) {
    const m = new Graphene.Matrix();
    m.init_translate(new Graphene.Point3D({ x: -width / 2, y: -height / 2, z: 0 }));
    m.scale(2 / width, -2 / height, 1);
    fb.set_projection_matrix(m);
}

function overlaps(a, b) {
    return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

export const GlassBlurEffect = GObject.registerClass(
class GlassBlurEffect extends Clutter.Effect {
    _init(params = {}) {
        super._init({ name: 'guava-glass' });
        this._mode = params.mode ?? 'live';     // 'live' | 'auto'
        this._margin = params.margin ?? 0;      // logical px -> device px at paint
        this._look = null;                      // {top, bottom, blur} (glassParams.effectColors)
        this._radius = 0;
        this._presence = 1;
        this._cogl = null;
        this._pipeline = null;
        this._uniforms = null;
        this._bg = null;        // {fb, tex, pipeline, w, h}
        this._out = null;       // {fb, tex, w, h}
        this._key = '';         // capture geometry of the cached blur
        this._valid = false;    // the cached blur shows the current backdrop
        this._settleUntil = 0;
        this._lastCapture = -1;       // monotonic ms of the last backdrop capture (live surfaces are throttled)
        this._settleId = 0;
        this._uv = [0, 0, 1, 1];
    }

    // ---- set by lib/glass.js ---------------------------------------------------------

    /** @param {?{top: number[], bottom: number[], blur: ?object}} look  null: draw nothing */
    setLook(look, radius) {
        this._look = look;
        this._radius = Math.max(0, radius ?? 0);
        if (!look?.blur)
            this._valid = false;
        this.queue_repaint();
    }

    get presence() {
        return this._presence;
    }

    setPresence(p) {
        p = Math.max(0, Math.min(1, p));
        if (p === this._presence)
            return;
        this._presence = p;
        this.get_actor()?.queue_redraw();
    }

    /** What lies behind may have changed: recapture now and for SETTLE_MS. */
    invalidate() {
        this._valid = false;
        this._settleUntil = GLib.get_monotonic_time() / 1000 + SETTLE_MS;
        if (!this._settleId) {
            // One more paint after the settle time takes the final, static blur
            this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS + 50, () => {
                this._settleId = 0;
                this._valid = false;
                this.get_actor()?.queue_redraw();
                return GLib.SOURCE_REMOVE;
            });
        }
        this.get_actor()?.queue_redraw();
    }

    destroyResources() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._bg = null;
        this._out = null;
        this._pipeline = null;
        this._valid = false;
    }

    vfunc_set_actor(actor) {
        if (!actor)
            this.destroyResources();
        super.vfunc_set_actor(actor);
    }

    // ---- paint -----------------------------------------------------------------------

    vfunc_paint_node(node, _paintContext, _flags) {
        const actor = this.get_actor();
        try {
            if (actor && this._look && this._presence > 0)
                this._paintGlass(actor, node);
        } catch (e) {
            // Never take the surface down with the glass: log once, draw St only from now on
            console.error('[Guava] glass blur failed, surfaces fall back to plain fills:', e);
            this._look = null;
            this.enabled = false;
            const fn = onFailure;
            onFailure = null;
            if (fn) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    fn();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        node.add_child(new Clutter.ActorNode(actor, -1));
    }

    _ensurePipeline(view) {
        if (this._pipeline)
            return;
        const ctx = view.get_framebuffer().get_context();
        this._cogl = ctx;
        const p = Cogl.Pipeline.new(ctx);
        p.set_layer_null_texture(0);
        p.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        p.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        p.add_snippet(snippet());
        this._pipeline = p;
        this._uniforms = {};
        for (const n of ['g_size', 'g_uv', 'g_radius', 'g_scale', 'g_sat', 'g_bright', 'g_lift', 'g_blur',
            'g_alpha', 'g_top', 'g_bottom'])
            this._uniforms[n] = p.get_uniform_location(n);
    }

    _fbo(width, height, withPipeline) {
        const tex = Cogl.Texture2D.new_with_size(this._cogl, width, height);
        const fb = Cogl.Offscreen.new_with_texture(tex);
        fb.allocate();
        setupProjection(fb, width, height);
        let pipeline = null;
        if (withPipeline) {
            pipeline = Cogl.Pipeline.new(this._cogl);
            pipeline.set_layer_texture(0, tex);
            pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        }
        return { fb, tex, pipeline, w: width, h: height };
    }

    _setUniforms(actor, scale, blurOn) {
        const p = this._pipeline;
        const u = this._uniforms;
        const look = this._look;
        const b = look.blur ?? { saturation: 1, brightness: 1, lift: 0 };
        p.set_uniform_float(u.g_size, 2, 1, [actor.width, actor.height]);
        p.set_uniform_float(u.g_uv, 4, 1, this._uv);
        p.set_uniform_1f(u.g_radius, this._radius);
        p.set_uniform_1f(u.g_scale, scale);
        p.set_uniform_1f(u.g_sat, b.saturation);
        p.set_uniform_1f(u.g_bright, b.brightness);
        p.set_uniform_1f(u.g_lift, b.lift);
        p.set_uniform_1f(u.g_blur, blurOn ? 1 : 0);
        p.set_uniform_1f(u.g_alpha, this._presence * actor.get_paint_opacity() / 255);
        p.set_uniform_float(u.g_top, 4, 1, look.top);
        p.set_uniform_float(u.g_bottom, 4, 1, look.bottom);
    }

    _paintGlass(actor, node) {
        const view = paintedView;
        if (!view) {
            // A screenshot or screencast: the last blur, or the tint alone before the first one
            if (!this._pipeline)
                return;
            this._draw(actor, node, 1, !!this._out && !!this._look.blur);
            return;
        }
        this._ensurePipeline(view);
        const scale = view.get_scale();
        if (!this._look.blur) {
            this._draw(actor, node, scale, false);
            return;
        }

        // The surface's box in the view's framebuffer, in device pixels, plus the margin
        const layout = view.layout;
        const src = view.get_framebuffer();
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        if (aw < 1 || ah < 1)
            return;
        const m = Math.ceil(this._margin * scale);
        const box = {
            x1: Math.floor((ax - layout.x) * scale), y1: Math.floor((ay - layout.y) * scale),
            x2: Math.ceil((ax + aw - layout.x) * scale), y2: Math.ceil((ay + ah - layout.y) * scale),
        };
        const cap = {
            x1: Math.max(0, box.x1 - m), y1: Math.max(0, box.y1 - m),
            x2: Math.min(src.get_width(), box.x2 + m), y2: Math.min(src.get_height(), box.y2 + m),
        };
        const cw = cap.x2 - cap.x1;
        const ch = cap.y2 - cap.y1;
        if (cw < 1 || ch < 1) {
            this._draw(actor, node, scale, false);
            return;
        }
        const key = `${cap.x1},${cap.y1},${cw},${ch},${scale},${this._look.blur.sigma}`;
        const now = GLib.get_monotonic_time() / 1000;
        let capture = !this._valid || key !== this._key || now < this._settleUntil;
        if (this._mode === 'auto' && !capture)
            capture = this._windowBehind(ax, ay, aw, ah);
        if (this._mode === 'live' || capture) {
            const frozen = governor.frame(now, 1000 / (view.get_refresh_rate() || 60));
            // Under load a surface that already has a blur keeps it
            if (frozen && this._out && key === this._key)
                capture = false;
            else if (this._mode === 'live')
                capture = capture || liveCaptureDue(this._lastCapture, now, degraded);
        }
        if (capture)
            this._capture(node, src, cap, box, key, scale);
        else
            this._draw(actor, node, scale, !!this._out);
    }

    // A window actor in the surface's area: the backdrop is not just the wallpaper
    _windowBehind(x, y, w, h) {
        const me = { x1: x, y1: y, x2: x + w, y2: y + h };
        for (const wa of global.get_window_actors()) {
            if (!wa.visible || !wa.mapped || wa.opacity === 0)
                continue;
            const [wx, wy] = wa.get_transformed_position();
            const [ww, wh] = wa.get_transformed_size();
            if (overlaps(me, { x1: wx, y1: wy, x2: wx + ww, y2: wy + wh }))
                return true;
        }
        return false;
    }

    _capture(node, src, cap, box, key, scale) {
        const actor = this.get_actor();
        const cw = cap.x2 - cap.x1;
        const ch = cap.y2 - cap.y1;
        const sigma = this._look.blur.sigma * scale;
        const ds = downscaleFor(sigma, cw, ch);
        const tw = Math.max(1, Math.floor(cw / ds));
        const th = Math.max(1, Math.floor(ch / ds));
        if (!this._bg || this._bg.w !== cw || this._bg.h !== ch)
            this._bg = this._fbo(cw, ch, true);
        if (!this._out || this._out.w !== tw || this._out.h !== th) {
            this._out = this._fbo(tw, th, false);
            this._pipeline.set_layer_texture(0, this._out.tex);
        }
        // The surface inside the captured texture (0..1), for the mask and the tint
        this._uv = [(box.x1 - cap.x1) / cw, (box.y1 - cap.y1) / ch, (box.x2 - box.x1) / cw, (box.y2 - box.y1) / ch];
        this._setUniforms(actor, scale, true);

        // out <- blur(downscale(bg <- blit(view)))
        const outNode = Clutter.LayerNode.new_to_framebuffer(this._out.fb, this._pipeline);
        node.add_child(outNode);
        this._addSurfaceRect(outNode, actor);
        const blurNode = Clutter.BlurNode.new(tw, th, sigma / ds);
        outNode.add_child(blurNode);
        blurNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: tw, y2: th }));
        const bgNode = Clutter.LayerNode.new_to_framebuffer(this._bg.fb, this._bg.pipeline);
        blurNode.add_child(bgNode);
        bgNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: tw, y2: th }));
        const blit = Clutter.BlitNode.new(src);
        bgNode.add_child(blit);
        blit.add_blit_rectangle(cap.x1, cap.y1, 0, 0, cw, ch);

        this._key = key;
        this._valid = true;
        this._lastCapture = GLib.get_monotonic_time() / 1000;
    }

    _draw(actor, node, scale, blurOn) {
        this._setUniforms(actor, scale, blurOn);
        const pn = Clutter.PipelineNode.new(this._pipeline);
        node.add_child(pn);
        this._addSurfaceRect(pn, actor);
    }

    // The surface's own rect, textured with the part of the capture it covers
    _addSurfaceRect(pnode, actor) {
        const [u, v, du, dv] = this._uv;
        pnode.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: actor.width, y2: actor.height }),
            u, v, u + du, v + dv);
    }
});
