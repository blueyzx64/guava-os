# Blur, shaders and effects (Liquid Glass)

Summary: `Shell.BlurEffect` (modes, the radius/sigma change, the repaint bug), custom GLSL through `Clutter.ShaderEffect` and Cogl snippets (with the 48-50 vs 51 API split), and Shell.GLSLEffect, which was removed in 51.
It also covers how Blur my Shell builds its blur and "Liquid Glass" effects, the performance rules, and why St CSS cannot do `backdrop-filter`.
Verified against gnome-shell `src/shell-blur-effect.{c,h}` (45.0, 46.0, main), `js/ui/lightbox.js` (50.0 vs main), mutter `clutter-shader-effect.h` (50.0 vs main), NEWS, and aunetx/blur-my-shell master. For the visual spec, see the apple-design skill's `liquid-glass.md`.

## Contents
1. What you can and cannot do
2. Shell.BlurEffect
3. Custom shaders: 48-50 vs 51
4. Liquid Glass composition recipe
5. How Blur my Shell does it
6. Performance rules
7. Sources

## 1. What you can and cannot do
- St CSS has **no** `backdrop-filter`, `filter` or `mix-blend-mode`.
  `st-theme-node.c` has no "filter" property at all. It does support
  `box-shadow`, `text-shadow`, `border-radius`, gradients
  (`background-gradient-*`) and the `st-mix`/`st-lighten`/`st-darken`/`st-transparentize`
  color functions (47+). All blur and refraction must come from
  `Clutter.Effect`s attached to actors.
- An effect paints its actor (ACTOR mode) or samples what is already in the
  framebuffer beneath the actor (BACKGROUND mode). Real windows are painted
  before Shell chrome, so chrome can blur windows behind it.
- mutter 51 added Wayland `ext-background-effect-v1` blur (51.beta !5071).
  That lets *clients* request background blur behind their windows. The only
  Shell-side hook is `global.compositor.set_background_blur_params(radius,
  saturation, noise)` (defaults 24, 1.25, 0.015; mutter 51.0 `meta/compositor.h`),
  which tunes those client blurs. It cannot blur Shell actors.

## 2. Shell.BlurEffect
```js
const effect = new Shell.BlurEffect({
    mode: Shell.BlurMode.BACKGROUND,   // or ACTOR
    radius: 30,                         // int, logical px. 46+ (45: `sigma`, with radius = 2 x sigma)
    brightness: 0.9,                    // float, multiplies rgb
});
widget.add_effect_with_name('guava-blur', effect);
// disable(): widget.remove_effect_by_name('guava-blur') or destroy the widget
```
- Properties: `radius` (int), `brightness` (float) and `mode` (enum). 46.0,
  47.0, 48.0 and main all expose exactly `radius`, `brightness` and `mode`.
  45.0 exposed `sigma`. The Shell's own lock screen uses
  `BLUR_RADIUS = 90 * scale_factor`, which was `BLUR_SIGMA = 45` in 45.
- From the source docs: "BACKGROUND can be computationally expensive, since
  the contents beneath the actor cannot be cached." ACTOR mode caches the
  result until the actor changes. Internally it downscales (`MIN_DOWNSCALE_SIZE 256`,
  `MAX_RADIUS 12` per pass).
- Scale the radius by `St.ThemeContext.get_for_stage(global.stage).scale_factor`
  if you want the same look on HiDPI.
- **Repaint bug (GNOME Shell #2857):** BACKGROUND blur doesn't repaint when
  content above or below it changes, which leaves stale squares. Guava already
  has `(Kiwi: apps/blurPaintSignal.js; Guava equivalent not verified)`, a `Clutter.Effect` that emits on paint and
  throttles `effect.queue_repaint()`, the same approach Blur my Shell uses.
  Reuse it.
- Layout trick used by Guava and Blur my Shell: put the blur widget inside a
  `Meta.BackgroundGroup({width: 0, height: 0})` inserted at index 0 of the
  target container, so it doesn't take part in layout. Then sync its
  position and size to the target on `notify::position`, `notify::size` and
  `notify::allocation` (see `(Kiwi: apps/panelTransparency.js; Guava equivalent not verified)` and `(Kiwi: apps/dockBlur.js; Guava equivalent not verified)`).
- For a static wallpaper blur, use ACTOR mode on a holder around
  `Background.BackgroundManager` (Guava `(Kiwi: apps/overviewWallpaper.js; Guava equivalent not verified)`). It's
  cheap because it's cached.

## 3. Custom shaders: 48-50 vs 51
| | GNOME 48, 49, 50 | GNOME 51 |
|---|---|---|
| `Shell.GLSLEffect` | exists (`add_glsl_snippet(hook, decls, code, isReplace)`, `get_uniform_location`, `set_uniform_float`, `vfunc_build_pipeline`) | **removed** (NEWS 51.alpha !4241; file absent at tag 51.0) |
| `Clutter.ShaderEffect` | GLSL *program*: `set_shader_source(src)` or `vfunc_get_static_shader_source()`. The source has a full `main()` and samples `uniform sampler2D tex`. | Cogl *snippet*: `Clutter.ShaderEffect.new_with_snippet(snippet)` or `vfunc_get_static_snippet()`. `cogl_color_out` already holds the actor's color. |
| uniforms | `set_uniform_value(name, value)` | `set_uniform_float(name, nComponents, [values])`, `set_uniform_value()` |

51 example (from `js/ui/lightbox.js` main):
```js
const DECL = 'uniform float brightness;\n';
const CODE = 'cogl_color_out.rgb *= brightness;\n';
const Effect = GObject.registerClass(class extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECL, null);
        s.set_replace(CODE);          // replace: you write cogl_color_out yourself
        return s;
    }
});
const fx = new Effect(); fx.set_uniform_float('brightness', 1, [0.8]);
```
Version-agnostic (the Guava pattern in `(Kiwi: apps/minimizedToDock.js; Guava equivalent not verified)`):
```js
if (Clutter.ShaderEffect.prototype.set_shader_source) {   // 48-50
    effect = new LegacyEffect();      // class calling this.set_shader_source(fullGlsl) in constructor
} else {                              // 51+
    effect = Clutter.ShaderEffect.new_with_snippet(
        Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decls, `${body}\ncogl_color_out *= a;`));
}
```
- Snippet variables: `cogl_color_in`, `cogl_color_out`, `cogl_tex_coord_in[0]`
  and, per layer N, `uniform sampler2D cogl_samplerN` / `cogl_texture_lookupN()`
  (mutter 51.0 cogl-pipeline-fragend-glsl.c; lightbox uses `cogl_tex_coord_in[0].xy`).
- On 48+, use `Cogl.SnippetHook` (not `Shell.SnippetHook`; gjs.guide 48).
- Cache snippets. Blur my Shell keeps a `Map` of snippets keyed by source
  (`render/shader/snippet_cache.js`) and clears it in `disable()`.
- A `Clutter.ShaderEffect` is a `Clutter.OffscreenEffect`: the actor renders
  to a texture every time it changes. It's cheap for small actors and costly
  full-screen.

## 4. Liquid Glass composition recipe (panel, dock, Spotlight, Control Center)
Stack the layers back to front inside one container:
1. **Backdrop blur**: an `St.Widget` with `Shell.BlurEffect` BACKGROUND,
   radius 20 to 40, brightness 0.9 to 1.0, plus the paint-signal throttle.
2. **Tint**: CSS `background-color: rgba(255,255,255,0.12)` (light) or
   `rgba(30,30,30,0.35)` (dark) on the shape. Use `-st-accent-color` with
   `st-transparentize()` for an accent tint (47+).
3. **Rim and specular**: CSS `border: 1px solid rgba(255,255,255,0.35)`,
   `border-radius`, and one `box-shadow` per element. St parses a single
   shadow (`inset` allowed); a comma list is not supported and extra values
   log "Ignoring excess values in shadow definition" (st-theme-node.c
   `parse_shadow_property`). Put `inset 0 1px 0 rgba(255,255,255,0.25)` on an
   inner child and `0 8px 24px rgba(0,0,0,0.25)` on the outer container.
4. **Refraction (optional, expensive)**: a shader effect on the blur widget
   that offsets UVs near the edges (lens or bezel). This needs a snippet
   effect that samples a texture. Study Blur my Shell's
   `effects/refraction/refraction.js` ("Liquid Glass": refraction scale,
   bezel width, rim, fresnel, RGB fringing, tint) before writing your own.
5. Clip to rounded corners. St `border-radius` clips the background, but not
   effects. Blur my Shell has a `CornerEffect`, and Guava has a
   `RoundedCornersEffect` in `(Kiwi: apps/minimizedToDock.js; Guava equivalent not verified)`.

## 5. How Blur my Shell does it (master, shell-version 46 to 51)
- Its own `DualKawaseBlurEffect` is a `Clutter.Effect` with
  `vfunc_paint_node`. It builds `Clutter.LayerNode`/`PipelineNode` passes into
  offscreen `Cogl.Texture2D` targets. It reads the current stage-view
  framebuffer only during a view paint (`render/backdrop/painted_view.js`
  tracks `global.stage` `before-paint` and `after-paint`), so screencasts
  don't pin framebuffers.
- Shader effects derive from a `SurfaceShaderEffect` (a `Clutter.ShaderEffect`
  subclass) that wraps GLSL into a snippet `bms_fragment()`. That shows the
  51-style snippet path, and the same code runs on 46 to 51.
- Pipelines (ordered effect lists) are reused across components (panel, dash,
  overview, popups, applications).
- Lesson for Guava: start with `Shell.BlurEffect` (it's simple and maintained
  upstream). Move to a custom `Clutter.Effect` only if you need refraction,
  dynamic radius per pixel, or better quality per cost.

## 6. Performance rules
- Every BACKGROUND blur re-renders each frame its region is damaged. Keep
  blurred areas small (panel, dock, menus) and avoid full-screen BACKGROUND
  blurs. For full screen, prefer ACTOR mode on a static wallpaper clone.
- Disable or skip effects when the actor is hidden
  (`effect.enabled = actor.visible`), during the overview if the area isn't
  visible, and when fullscreen apps unredirect.
- Throttle `queue_repaint()` to at most once per frame, coalescing with
  `GLib.idle_add` or laters.
- Watch for the `ACTOR_DIRTY` paint flag (Blur my Shell refreshes input only
  when it is set).
- Measure with Sysprof: gnome-shell starts the GJS profiler when launched
  with `GJS_TRACE_FD`/`GJS_ENABLE_PROFILER` (src/main.c `shell_profiler_init`).
  There is no `GNOME_SHELL_DEBUG` (only `SHELL_DEBUG=backtrace-warnings|backtrace-segfaults`)
  and Looking Glass has no frame-timing view.
- Offer a "reduce transparency" pref and honour `St.Settings` `high-contrast`
  and `enable-animations`.

## 7. Sources
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/shell-blur-effect.c (tags 45.0 sigma, 46.0+ radius)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/lightbox.js (51 snippet effect) vs .../50.0/js/ui/lightbox.js (Shell.GLSLEffect)
- https://gitlab.gnome.org/GNOME/mutter/-/blob/main/clutter/clutter/clutter-shader-effect.h (vs 50.0)
- gnome-shell NEWS 51.alpha "Replace GLSLEffect with ClutterShaderEffect"; mutter NEWS 51.alpha "Remove CoglProgram/Shader API", 51.beta "Add ext-background-effect-v1 blur support"
- https://gjs.guide/extensions/upgrading/gnome-shell-46.html (radius = sigma x 2)
- https://gjs.guide/extensions/upgrading/gnome-shell-48.html (Cogl.SnippetHook)
- https://github.com/aunetx/blur-my-shell (src/effects/blur/dual_kawase_blur.js, src/effects/refraction/, src/render/)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2857 "Windows shadows causing artefacts with the new Shell.BlurEffect" (open; cited by Guava and Blur my Shell for the repaint workaround)
