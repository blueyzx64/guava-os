---
name: gnome-blur-glass
description: Real blur and Liquid Glass on GNOME Shell 50 for Guava OS. Use when working on lib/glass.js, lib/glassParams.js, features/liquidGlass, styles/base.css glass fills, the "blur" layer, panel/dock/menu translucency, Shell.BlurEffect (ACTOR vs BACKGROUND mode), static wallpaper blur vs dynamic backdrop blur, Blur my Shell coexistence, blur artefacts (squares, stale blur, flicker, blur not fading with opacity), blur cost on llvmpipe/iGPU, or HiDPI blur radius.
---

# Blur and glass on GNOME Shell 50

Guava today: `lib/glass.js` is **faux glass** — style classes + an inline fill fragment, no blur,
no shader, no offscreen (`lib/glass.js:1-31`). `layers: 'blur'` "resolves but draws nothing"
(`:20-21`). Anything below is what a real blur layer must respect. Sources:
GNOME Shell 50.6 C (`refs/gnome-shell-src/src/shell-blur-effect.c`), Blur my Shell master
(`refs/blur-my-shell/src/`), Kiwi (`refs/kiwi-is-not-apple/apps/`). Refs dir:
`/home/user/.swarm/guava-os/refs/`.

## 1. Shell.BlurEffect (the only blur GNOME ships)

Properties (Shell-18 typelib, verified): `radius` (**int**), `brightness` (0..1), `mode`
(`Shell.BlurMode.ACTOR` = 0, `BACKGROUND` = 1), plus `enabled`, `name`.

| | ACTOR | BACKGROUND |
|---|---|---|
| What is blurred | the actor and its children | the framebuffer pixels already drawn *under* the actor this frame |
| Caching | re-blurs only when the actor is dirty (`needs_repaint`, `shell-blur-effect.c:598-616`) | **re-blurs every paint** (`:613-614`, doc comment `:42-44`) |
| Opacity | follows `paint_opacity` | **ignores actor opacity**: blurred backdrop painted at 255 (`:641-643`) |
| Cost | ~0 after first frame | blit + downscale + 2-pass gaussian each frame the actor repaints |

Internals worth knowing:
- Downscale: while `radius > 12` (`MAX_RADIUS`, `:54`) and both sides > 256 px, the texture is
  halved and the radius halved (`calculate_downscale_factor`, `:290-314`). Big radii are cheap;
  small surfaces (< 512 px) with big radii are blurred at full size.
- BACKGROUND copies with a `ClutterBlitNode` from the *current* framebuffer at the actor's
  transformed box (`paint_background`, `:453-497`). Pixels outside this frame's redraw clip
  are whatever the buffer held before → **stale/square artefacts** when only part of the area
  under the surface repainted (GNOME Shell issue #2857). Kiwi and older Blur my Shell force a
  coalesced `effect.queue_repaint()` on `restacked`, WM `map/destroy/minimize/unminimize/
  switch-workspace`, overview `showing/hidden`, background `notify::content`, and on the
  surface's own paint (throttled: `refs/kiwi-is-not-apple/apps/blurPaintSignal.js`,
  `apps/panelTransparency.js:117-176`).
- If an ancestor is painted offscreen (actor opacity < 255 with `AUTOMATIC_FOR_OPACITY` and
  overlaps, an OffscreenEffect, a Clone), the "framebuffer" is that offscreen, which holds
  nothing of the desktop → the blur shows black/transparent. Blur my Shell detects this
  (`render/backdrop/capture.js:73-100`).
- Scale: the Shell scales the radius itself — `radius: BLUR_RADIUS * themeContext.scale_factor`,
  re-set on `notify::scale-factor` (`ui/unlockDialog.js:581-583,726-738`). Do the same.
- Harness check (2026-11-03, run `20261103-065754-guava-os-f44`): a 200×60 BACKGROUND blur at
  `opacity = 60` still showed a fully opaque blurred backdrop (`shots/r1-blur-op60.png`).

## 2. Two architectures

### Static blur (wallpaper only) — cheap, the default for menu bar and dock
Blur a **copy of the wallpaper**, clip it to the surface. Windows behind the surface are not
blurred (macOS shows windows through the menu bar; static blur shows the wallpaper).
- Blur my Shell: `pipelines/pipeline.js:46-109` `create_background_with_effects`: a
  `Background.BackgroundManager({container, monitorIndex, controlPosition: false})` fills a
  hidden source widget; a `Clutter.Clone` of it carries the effects; the result is inserted in
  a zero-size `Meta.BackgroundGroup` at index 0 of the panel box
  (`components/panel/panel_background.js:10-51`) and `set_clip()`ped to the panel rect
  (`:69-94`). Keep new background actors *below* (`pipeline.js:99-104`) or a solid colour
  flashes while the wallpaper loads.
- With an ACTOR-mode blur on that clone the blur is computed once per wallpaper change.
- Lock screen does exactly this with `Shell.BlurEffect` (`ui/unlockDialog.js:700-724`).

### Dynamic blur (what is behind, including windows) — expensive
- Simple: `Shell.BlurEffect({mode: BACKGROUND})` on a sibling widget below the surface content
  (the zero-size `Meta.BackgroundGroup` trick keeps it out of layout:
  `refs/kiwi-is-not-apple/apps/panelTransparency.js:66-108`). Accept the costs in §1, and
  repaint on the events above.
- Blur my Shell master no longer uses Shell.BlurEffect at all: it captures the backdrop with
  its own `Clutter.Effect` that `blit`s only the damaged rectangles of the stage view into a
  cached texture (`render/backdrop/capture.js:297-359`, damage from
  `paintContext.get_redraw_clip()`, `:138-168`), tracks the painted view with stage
  `before-paint`/`after-paint` (`render/backdrop/painted_view.js`), re-queues overlapping
  surfaces (`render/backdrop/damage.js`), and blurs with a dual-Kawase chain whose pass count
  comes from the radius (`effects/blur/kawase_sampling.js:1-17`) scaled by
  `themeScale * resourceScale` (`effects/blur/dual_kawase_blur.js:441-443`), and **multiplies
  the output by `paint_opacity`** (`:461`). ~2,000 lines; GPL-3.0 (compatible with Guava's
  GPL-3.0-or-later, attribution required). Allocates arrays per paint (`.map`, `flatMap`), so
  do not copy it verbatim into a hot path.

## 3. What Guava's glass should do (recommendation)

1. **Keep faux glass as the base layer** (it is free and follows rounded shapes). Add blur as an
   optional layer *under* the fill, never on the surface actor itself (an effect on the surface
   would blur its text).
2. Menu bar and dock: **static wallpaper blur** (BackgroundManager + Clone + ACTOR blur, clipped).
   Re-create on `Main.layoutManager` `monitors-changed`; scale radius on
   `St.ThemeContext` `notify::scale-factor`.
3. Popups, Control Center, Spotlight, notch: dynamic BACKGROUND blur only while open, with the
   effect `enabled = false` (not removed) when hidden; repaint on the event list in §1.
4. Fades: BACKGROUND blur does not fade with opacity. Either fade `brightness`/`radius` with
   the surface (and disable at 0), or crossfade the faux layer only. Never animate an opaque
   blur under a fading surface (it pops).
5. Degrade first under load (principles §2 "Graceful under load"): `Glass.wants()` should return
   faux-only when `global.backend.is_rendering_hardware_accelerated()` is false, under Reduce
   Transparency (already opaque), and while a full-screen window is on the monitor (no blur
   over unredirected games; `lib/compat.js:202` `setUnredirectAllowed`).
6. Never stack Guava blur over Blur my Shell's on the same surface; `features/liquidGlass/prefs.js:24-25,94-95`
   already detects BMS. Guava must not edit BMS settings.

## 4. Cost rules

- Dynamic blur cost ∝ area × repaints. A 1280×32 menu bar re-blurred on every window move is
  fine on a GPU, visible on llvmpipe (the harness). Measure with `perf_start/perf_stop` against
  the stock overview baseline (`guava-harness` skill).
- Radius ≤ 12 px blurs at full resolution (no downscale): prefer ≥ 24 px for big areas.
- Each `Shell.BlurEffect` owns 2–3 FBOs sized to the actor × resource scale: release them by
  removing the effect when a surface is destroyed, not just hidden for minutes.
- Fractional scaling: Blur my Shell insets damage rects by one logical pixel at fractional
  scales to avoid old-frame pixels at edges (`render/backdrop/capture.js:147-152`).

## 5. Pitfalls

- Blur on an actor inside `Main.uiGroup` that is under an OffscreenEffect (Guava color filters
  put a shader on `global.stage`, `features/colorFilters/`) → backdrop capture reads the
  filter's offscreen. Test blur with color filters on.
- Screenshots/screencasts paint the stage into a different framebuffer: BACKGROUND blur there
  blits from that framebuffer (fine), but a custom capture must not cache it (BMS
  `painted_view.js` comment).
- `Shell.BlurEffect` `radius` is an int: `radius: 30 * 1.25` is silently truncated.
- Brightness < 1 darkens the whole blur; macOS glass brightens and saturates instead. A
  saturation step needs your own shader (BMS `effects/color/`), not BlurEffect.
- ⚠ Unverified: cost numbers on real Intel/AMD GPUs; the harness is software-rendered.
