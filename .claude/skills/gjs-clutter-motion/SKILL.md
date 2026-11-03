---
name: gjs-clutter-motion
description: Clutter/St animation and GPU effects on GNOME Shell 50 for Guava OS. Use when animating anything (core/motion.js ease/spring/tween, actor.ease, easeAsync, Clutter.Timeline, transitions, retargeting/interrupting, onStopped), writing offscreen effects or shaders (Clutter.OffscreenEffect, DeformEffect, Shell.GLSLEffect, Clutter.ShaderEffect, Cogl snippets, GLSL uniforms, premultiplied alpha), HiDPI/fractional scaling (resource scale, FBO size, texture filtering), frame clock and per-frame performance (no allocation per frame), reduced motion, or jitter/jump/flicker reported by the harness. Files: core/motion.js, core/motionModel.js, lib/compat.js, features/minimizeEffect/genie.js, features/roundedCorners/effect.js, features/colorFilters.
---

# Motion and effects on Clutter 18 (GNOME 50)

Sources: Shell 50.6 JS `refs/gnome-shell-50.6-js/org/gnome/shell/ui/environment.js`; Mutter 50.6
`refs/mutter-src/clutter/clutter/*.c`; Shell C `refs/gnome-shell-src/src/` (refs dir
`/home/user/.swarm/guava-os/refs/`).

## 1. Guava rule: one animation path

Everything animates through `ctx.motion` (`core/motion.js`), with **named** durations/curves/
springs from `core/motionModel.js` (`DURATIONS` micro 100 … extraLong 550 ms; `CURVES` standard
EASE_OUT_CUBIC, emphasized EASE_OUT_EXPO, move EASE_IN_OUT_CUBIC, …; `SPRINGS` snappy/smooth/
bouncy/quick in SwiftUI response/damping) and an `owner` CleanupRegistry so disable cancels it.

| API | Engine | Use |
|---|---|---|
| `motion.ease(actor, props, {duration, curve, delay, repeat, autoReverse, onDone}, owner)` | `actor.ease` (Clutter implicit transitions) | actor properties |
| `motion.spring(actor, prop, to, {spring}, owner)` / `springs(actor, {x,y,…})` | one `Clutter.Timeline` + a precomputed keyframe table (`springKeyframes`) | overshoot motion |
| `motion.tween(actor, {duration, curve, reverse}, p => …, owner)` | `Clutter.Timeline` `new-frame`, eased `get_progress()` | meshes, shader progress, computed layouts |

`motionModel.resolve()` applies: animations off ⇒ duration 0, end state at once; reduced motion
(`org.gnome.desktop.a11y.interface reduced-motion` = 'reduce' on 50; `St.Settings` has no
`reduced_motion` on 50) ⇒ transform props jump, only opacity crossfades ≤150 ms. Never read
these settings in a feature.

## 2. actor.ease facts (environment.js, 50.6)

- `ease()` first **removes the running transition of each eased property** (its `onStopped(false)`
  fires) then sets the new target with implicit easing, so the new transition starts **from the
  current interpolated value** (`_easeActor`, `:144-205`). That is retargeting without
  velocity: direction flips are instant (the harness counts a reversal; fine for user
  reversals, not for a spring that should carry momentum).
- Duration × `St.Settings.slow_down_factor`; **0 when `enable_animations` is false** unless
  `animationRequired: true` (`misc/animationUtils.js:23-33`).
- Only the **first** created transition drives `onStopped/onComplete` (`:197-203`). A target
  equal to the current value still creates a transition (harness, 2026-11-03).
- **Unmapped actor (hidden or not on stage) ⇒ no transition**: the value jumps to the target
  and `onStopped(true)` runs synchronously (harness). So `actor.ease()` *then* `show()` does not
  animate: show (or add to the stage) first. A `Clutter.Timeline` bound to a hidden actor
  still ticks and completes (13 frames / 200 ms measured), so `motion.tween/spring` do run.
- `ease()` returns nothing on 50 and swallows the CANCELLED rejection
  (`:342-344`, `logErrorUnlessCancelled`); `easeAsync()` **rejects** with "Transition was stopped before completing" when
  interrupted (verified) — wrap it in try/catch.
- While any ease with duration runs, the Shell calls `global.compositor.disable_unredirect()`
  and `global.begin_work()` (`:104-122`): a never-ending ease (repeatCount −1) keeps full-screen
  games composited forever.
- `repeatCount`/`autoReverse` go on every transition; Guava exposes them as `repeat`/`autoReverse`.

## 3. Guava motion pitfalls (read core/motion.js before changing it)

- `spring(actor, prop, …)` cancels a Clutter transition on `prop` but **not an earlier spring
  timeline on the same prop** (`core/motion.js` spring: `actor.remove_transition` only). Two
  springs then write the property on alternate frames → jitter. Keep the handle and
  `cancel()` it before re-springing (the `springs()` doc says so); a central per-actor/prop
  registry in Motion would make this impossible to get wrong.
- A spring retarget restarts from the current value with zero velocity (keyframe table is
  normalised). For drag-release or interrupted bounces, macOS keeps velocity: compute the
  current velocity from the table (`springAt` derivative) and seed the next spring
  (`TODO`, not implemented).
- `tween()`/`spring()` timelines are bound to `actor` → they tick on that actor's stage-view
  frame clock (`Clutter.Timeline` `actor`/`frame-clock` props); they tick even while the actor
  is hidden (measured), unlike `ease()` (§2).
- `onDone(false)` means cancelled: leave the end-state reset to the caller's `finish()`
  (pattern: `features/minimizeEffect/index.js:161-176`).

## 4. Frame clock and hot paths

- One frame clock per stage view (monitor). `global.stage` signals `before-update`,
  `prepare-frame`, `before-paint`, `after-paint`, `presented` (verified signal list). Prefer
  property signals that fire per change over per-frame hooks.
- Per-frame code (`new-frame`, `vfunc_paint*`, `allocate`, `position-changed` during a drag)
  must allocate nothing: preallocate typed arrays, `Clutter.ActorBox`, `Cogl.Color`, reuse result
  objects (`features/minimizeEffect/genie.js:40-48` keeps `Float64Array`s, one box, one colour).
  Avoid template strings, `.map`, spreads, closures per frame.
- "Run before the next paint": `global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, fn)`.
- Set many properties with direct setters (`set_position`, `set_size`, `set_scale`) — `actor.set({…})`
  allocates an object.

## 5. Offscreen effects and shaders

`Clutter.OffscreenEffect` (`clutter-offscreen-effect.c`, 50.6):
- FBO = bounding box of the actor's **paint volume** (else allocation), enlarged, × **ceil(resource
  scale)** (`:358-391`). Paint into it once; `vfunc_paint_target(node, ctx)` draws the texture —
  **coordinates there are texture pixels**, hence Genie's `k = texWidth / reach.width`
  (`genie.js:80-81`).
- Texture filter: NEAREST at integer scales, LINEAR at fractional (`:183-205`). Fractional
  scaling ⇒ an offscreen effect softens text slightly; Guava's rounded corners filter by hand
  (`features/roundedCorners/effect.js:44-58`).
- The deformed output is still culled/clipped to the actor's paint volume. Fixes: draw in a
  container sized to the full motion (Guava Genie, `genie.js:8-11`), or return `false` from
  `vfunc_modify_paint_volume` (no volume ⇒ no culling, full-stage redraw; Compiz Magic Lamp
  `extension.js:444-446`, Guava `lib/compat.js:134-139`).
- `vfunc_pre_paint` returning false skips the effect for that paint; Guava skips clones so
  thumbnails sample Mutter's mipmapped texture (`roundedCorners/effect.js:170-174`).
- `Clutter.DeformEffect` (`set_n_tiles`, `vfunc_deform_vertex(w,h,v)`) still exists on 50;
  call `invalidate()` per frame.

`Shell.GLSLEffect` (50 only; removed in 51 ⚠ per Burn My Windows `src/Shader.js:30`):
- `vfunc_build_pipeline()` runs **once per GType** and the pipeline is shared by every instance
  (`shell-glsl-effect.c:120-139`): one shader per registered class; per-instance state only in
  uniforms. `add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, decls, code, false)`.
- Blend is `SRC_COLOR * SRC_COLOR[A] + DST * (1 - SRC_COLOR[A])`: output **un-premultiplied**
  colour (divide rgb by a, as `roundedCorners/effect.js:89-90`).
- Cache `get_uniform_location(name)` in the constructor; `set_uniform_float(loc, n, [..])`.
- Guava access: `lib/compat.js:193` `GLSL_EFFECT`; subclass lazily (`effect.js:94-104`).

`Clutter.ShaderEffect` (Guava `lib/compat.js:154` `createShaderEffect`): whole-fragment program
via `set_shader_source` on 50. `set_uniform_value(name, 1)` with an integral JS number makes an
**int** uniform: use `floatUniform(v)` (`compat.js:180`).

## 6. HiDPI and fractional scaling

- `St.ThemeContext.get_for_stage(global.stage).scale_factor`: integer UI scale (CSS px ×).
- `global.display.get_monitor_scale(i)`: the monitor's (possibly fractional) scale.
- `actor.get_resource_scale()`: ceiled scale the actor's textures render at; signals
  `resource-scale-changed`, `real-resource-scale-changed`. Redraw caches on them.
- Never cache a texture below the monitor scale; re-render icons/glass on scale changes
  (principles §2 "Sharp"). Sizes from CSS are already scaled; JS pixel constants are not
  (multiply by `scale_factor`).
- ⚠ Measured in the harness only at scale 1; fractional paths are unverified there.

## 7. Debug checklist for "it jumps / flickers"

1. Was an old transition/timeline still running on the same prop? (§3)
2. `set()` of the start state after `show()` ⇒ one frame at the old state: set first, then show.
3. Pivot point changed mid-animation ⇒ jump (set pivot before scaling; stock resets to (0,0)).
4. Allocation (layout manager) overriding x/y: animate `translation_*`, not `x/y`, on laid-out
   children.
5. Offscreen first frame (~290 ms shader compile in llvmpipe): warm up.
6. Measure with `track_actor`/`track_stop` (`guava-harness` skill).
