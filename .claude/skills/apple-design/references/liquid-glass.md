# Liquid Glass: what Apple does, and how Guava recreates it

Summary: Liquid Glass is Apple's 2025 adaptive, lensing material for the control
and navigation layer. It comes in regular and clear variants, can be tinted, and
uses concentric shapes. Guava approximates it with `Shell.BlurEffect`, a tint
layer, a rim and an inset highlight. It scales across performance tiers and
falls back to opaque surfaces for reduce-transparency and high contrast.

## Contents
1. What Liquid Glass is
2. Variants: regular vs clear
3. Tinting and colour
4. Adaptive behaviour
5. Shapes and concentricity
6. Scroll edge effects
7. When NOT to use glass
8. Apple APIs (for vocabulary)
9. Recreating it in GNOME Shell
10. Performance tiers
11. Fallbacks, reduce transparency, high contrast
12. Sources

---

## 1. What Liquid Glass is

- It is a **functional layer** that floats above content and holds controls and
  navigation: toolbars, sidebars, tab bars, popovers, menus and Control Center.
  Content can scroll and peek through underneath. (HIG Materials)
- **Lensing:** the material bends and concentrates light instead of only
  scattering it the way a frosted blur does. Elements *materialize* by changing
  the lensing, not by a plain fade. (WWDC25 "Meet Liquid Glass")
- **Highlights:** specular light travels along the shape's edge and responds
  to geometry and interaction. (WWDC25 "Meet Liquid Glass")
- **Shadows:** opacity adapts. Shadows get stronger over text for separation
  and weaker over plain light backgrounds. (WWDC25 "Meet Liquid Glass")
- **Two families of material:** Liquid Glass sits on the control layer, and the
  classic *standard materials* (ultra-thin to thick blur) separate things within
  the content layer. (HIG Materials)

## 2. Variants: regular vs clear

| | Regular (default) | Clear |
|---|---|---|
| Look | Blurs and adjusts luminosity of what's behind | Highly translucent, little blur |
| Adaptive | Yes. Flips light/dark and adapts to size. | No |
| Use for | Most UI, and anything with lots of text: alerts, sidebars, popovers | Small floating controls over photos, video or maps |
| Legibility aid | Built in, plus scroll edge effects | Needs a **dim layer of 35 % black** if the content behind is bright. Skip the dim if it is already dark. |

Use the **clear** variant only when all three of these hold (WWDC25): the element
sits over media-rich content, the content isn't harmed by a dim layer, and the
foreground symbols and text are bold and bright. **Never mix the two variants**
in one group.

## 3. Tinting and colour

- By default, glass has **no colour of its own**. It picks up the colour of
  what's behind it. (HIG Color, "Liquid Glass color")
- Tinting works like stained glass: the tint maps to the brightness of the
  content underneath, so it isn't a flat overlay.
- Use tint only for **primary actions and status**. To emphasize a primary
  action, colour its *background*, not its glyph. Prominent buttons work this
  way, using the accent colour as the fill.
- Over colourful content, keep toolbar glyphs **monochrome**.
- AppKit's `tintProminence` has four levels: automatic, none, secondary and
  primary. Default buttons get primary, and destructive buttons get a
  restrained red. (WWDC25 session 310)

Guava rule: tint means `-st-accent-color` at 0.85 alpha, used only for active
toggles in Control Center, the primary button in dialogs, and the island's live
progress ring.

## 4. Adaptive behaviour

- **Small elements** (toolbar and tab-bar pills, glyphs) flip between light and
  dark appearance based on what's behind them.
- **Large elements** (menus, sidebars) adapt but **don't flip**, because a big
  surface flipping is distracting. They become more opaque to protect
  legibility. (WWDC25 "Meet Liquid Glass"; HIG Color)
- **Size:** bigger glass reads as thicker material, with deeper shadow, more
  refraction and softer scattering.
- **Interaction:** on touch it is elastic and gives a highlight on press. With a
  trackpad or pointer the effect is more subdued (HIG Motion). On macOS,
  pointer-driven feedback should stay subtle.

Guava mapping:
- Panel pills and the island are *small*. They may switch glyph colour
  (`guava-on-light` / `guava-on-dark` class) from sampled wallpaper luminance.
  `(Kiwi: apps/dockColors.js; Guava equivalent not verified)` already does this for the dock.
- Popovers and Control Center are *large*. They keep the theme's scheme, and
  their tint opacity rises by +0.10 compared with the panel.

## 5. Shapes and concentricity

- There are three shape types: **fixed** (a constant radius), **capsule**
  (radius = height / 2) and **concentric** (radius = parent radius − padding).
  (WWDC25 "Get to know the new design system")
- On Mac, controls near a window edge use concentric shapes. Mini, small and
  medium controls stay rounded rectangles. Large and extra-large controls are
  capsules. (WWDC25 sessions 310 and 356)
- Window corners got larger in Tahoe. Windows with toolbars use an even larger
  radius that wraps around the toolbar glass.
- Watch for **pinched** corners (inner radius too large) and **flared** corners
  (inner radius too small).

Guava formula (write it in CSS comments when you use it):
`inner_radius = max(outer_radius - padding, 4px)`.
Examples: a Control Center radius of 26 with padding 12 gives tiles of 14.
A popover radius of 18 with padding 6 gives menu items of 12.

## 6. Scroll edge effects

- Scroll edge effects replace hard dividers where floating controls overlap
  scrolling content. They provide legibility, not decoration.
- **Soft** progressively fades and blurs content (the iOS default). **Hard**
  is a more opaque backing and is the usual choice on macOS for text, pinned
  headers and controls without a background.
- Use **one effect per view**, and don't stack effects. (WWDC25 sessions 356 and
  310)

Guava mapping:
- St has no backdrop mask gradient. Approximate a *soft* edge by placing a
  16–24px `St.Widget` at the top and bottom of an `St.ScrollView`. Give it a
  `background-gradient-direction: vertical` from the surface colour at α 0.9 to
  α 0.
- A *hard* edge is a solid surface-colour strip with a 1px separator at α 0.08.
- Show either edge only when `vadjustment.value > 0` or when content continues
  below.

## 7. When NOT to use glass

- Don't use it on the content layer: window content, document lists or the
  wallpaper. Sliders and toggles can briefly *become* glass while being dragged.
  (HIG Materials)
- Don't use it on non-interactive elements such as titles and status text. In
  AppKit these get `isBordered = false`. (WWDC25 session 310)
- Don't put glass inside glass, or behind content as a sibling. Glass can't
  sample glass, so neighbouring elements share one container.
- Don't use it everywhere. The HIG says to use it **sparingly**.
- Don't use it for alerts or warnings that need certainty. Use an opaque dialog.

## 8. Apple APIs (for vocabulary only)

| API | Idea Guava can borrow |
|---|---|
| SwiftUI `.glassEffect(.regular / .clear / .identity, in: shape)` with `.tint()` and `.interactive()` | A `GlassSurface` widget with `variant`, `shape` and `tint` props |
| `GlassEffectContainer(spacing:)` | One blur actor behind a *group* of pills. Pills closer than `spacing` merge. |
| `glassEffectID` / `glassEffectUnion` | Morph between the pill and the expanded island using the same backing actor |
| `NSGlassEffectView.contentView / cornerRadius / tintColor` | Content is a *child* of the glass, never a sibling |
| `NSGlassEffectContainerView.spacing` | As above |
| `.buttonStyle(.glass / .glassProminent)` | CSS classes `.guava-glass-button` and `.guava-glass-button.prominent` |
| `NSBackgroundExtensionView` / `backgroundExtensionEffect()` | Not needed in the Shell |
| `.rect(cornerRadius: .containerConcentric)` | The concentric formula in section 5 |

## 9. Recreating it in GNOME Shell

### 9.1 Layer stack (back to front)

```
Meta.BackgroundGroup (0×0, out of layout)   ← pattern already in panelTransparency.js
 └─ St.Widget  .guava-glass-blur            ← Shell.BlurEffect BACKGROUND mode
St.Widget/BoxLayout .guava-glass            ← tint bg + rim border + inset highlight + shadow
 └─ content (labels, icons; NO further blur)
```

- **Blur:** `new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius: 30,
  brightness: 0.95})`. Use BACKGROUND mode for anything over windows. Use ACTOR
  mode only on a static texture, such as the wallpaper clone in
  `(Kiwi: apps/overviewWallpaper.js; Guava equivalent not verified)`.
- **Repaint hack:** BACKGROUND blur doesn't repaint when actors above it
  change (GNOME Shell issue #2857). Always attach `connectPaintSignal()` from
  `(Kiwi: apps/blurPaintSignal.js; Guava equivalent not verified)`, and coalesce repaints in an idle callback.
- **Clip to the radius:** BlurEffect paints a rectangle. To round it, give the
  blur widget the same `border-radius` and set `clip_to_allocation`. If corners
  still bleed, use a corner-mask `Clutter.ShaderEffect` (see 9.3).

### 9.2 St CSS recipe

```css
.guava-glass {
  background-color: rgba(28, 28, 30, 0.38);      /* tint layer (dark)      */
  border: 1px solid rgba(255, 255, 255, 0.14);   /* rim                    */
  border-radius: 18px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22),  /* top highlight   */
              0 8px 28px rgba(0, 0, 0, 0.22);           /* elevation       */
}
.guava-glass.guava-light  { background-color: rgba(246, 246, 248, 0.42);
                          border-color: rgba(255, 255, 255, 0.55); }
.guava-glass.guava-clear  { background-color: rgba(0, 0, 0, 0.10); }
.guava-glass.guava-clear.guava-dim { background-color: rgba(0, 0, 0, 0.35); }
.guava-glass .guava-glass-fill    { background-color: rgba(255,255,255,0.08);
                                  border-radius: 12px; } /* items on glass */
```

St limits:
- There is no `backdrop-filter` and no `mix-blend-mode`.
- Only one `box-shadow` is reliably rendered on most shell versions.
- `inset` box-shadow is parsed and painted (via the cairo path) in St on
  GNOME 48–51 (`st-theme-node-drawing.c`). As a cheaper alternative, use a
  1px child `St.Widget` with `background-gradient-direction: horizontal`
  from α 0 → 0.3 → 0 along the top edge.
- Verify on GNOME 48–51 before you depend on any of these.

### 9.3 Optional GLSL refraction (the "high" tier only)

- Subclass `Shell.GLSLEffect` (or `Clutter.ShaderEffect`) on the blur widget.
  In the fragment shader, take a signed distance field (SDF) for the rounded
  rect and displace the UV lookup by
  `normal * k * smoothstep(edge, 0, d)`, with k ≈ 6–10px at the rim and 0 in
  the centre. This gives an edge lens.
- Add a chromatic offset of ≤ 1px only at the rim. Clamp it so text inside
  never moves.
- Keep the shader branch-free. Pass `radius`, `size` and `k` as uniforms. Only
  re-upload them on allocation changes.
- This is entirely Guava's own code. Do not port Apple shaders or sample assets.

### 9.4 Adaptive glyph colour

Sample the average luminance of the wallpaper region under small pills once per
wallpaper or monitor change, not per frame. If L > 0.6, add `.guava-on-light`
(dark glyphs) and otherwise use light glyphs. Use hysteresis of ±0.05. This
reuses the idea in `(Kiwi: apps/dockColors.js; Guava equivalent not verified)`.

## 10. Performance tiers

| Tier | What renders | When |
|---|---|---|
| **High** | Blur 30 + tint + rim + highlight + GLSL lens + adaptive glyphs | Opt-in only. Dedicated GPU. |
| **Balanced** (default) | Blur 30 + tint + rim + highlight | Most iGPUs |
| **Light** | Tint at +0.15 alpha + rim, **no blur** | Battery saver, VMs, software rendering (llvmpipe), or `enable-animations` false |
| **Opaque** | Solid surface colour + 1px rim | Reduce transparency or high contrast |

Rules:
- Use one blur actor per surface, and share it across grouped pills, as
  `GlassEffectContainer` does.
- Never blur a full-screen region continuously.
- Pause blur repaints while the actor is hidden (`notify::visible`) and while
  the overview animates.
- Auto-drop to **Light** when GNOME's power profile is `power-saver`. Read
  `net.hadess.PowerProfiles` over D-Bus.
- To measure, run the Shell with `MUTTER_DEBUG` / `CLUTTER_SHOW_FPS=1` (still read by
  Mutter's `clutter-context.c`, 48 to main). Target 60 fps while hovering panel buttons.

## 11. Fallbacks, reduce transparency, high contrast

| Condition | Result |
|---|---|
| Guava "Reduce transparency" on | Opaque tier. Surface colour is the theme's popover bg at α 1. |
| `high_contrast` true | Opaque tier, rim `1px solid` at fg α 0.6, focus ring 3px, no clear variant |
| Clear variant over a bright background | Force the dim layer at 35 % |
| Blur unavailable (an `xvfb`/nested session, or effect creation threw) | Light tier |
| The user's shell theme isn't Adwaita | Read colours via `-st-accent-color` and the theme's popover colour. Never assume Adwaita hex values. |

Reduce transparency in Apple's system makes glass "frostier", and increased
contrast makes it mostly black or white with a contrasting border (WWDC25).
Guava mirrors this with the Opaque tier.

## 12. Sources

- HIG Materials: https://developer.apple.com/design/human-interface-guidelines/materials (35 % dim, regular vs clear, sparing use)
- HIG Color, Liquid Glass color: https://developer.apple.com/design/human-interface-guidelines/color
- HIG Layout (scroll edge, background extension): https://developer.apple.com/design/human-interface-guidelines/layout
- WWDC25 219 "Meet Liquid Glass": https://developer.apple.com/videos/play/wwdc2025/219/
- WWDC25 356 "Get to know the new design system": https://developer.apple.com/videos/play/wwdc2025/356/
- WWDC25 310 "Build an AppKit app with the new design": https://developer.apple.com/videos/play/wwdc2025/310/
- Community API digest (secondary, not Apple): https://github.com/conorluddy/LiquidGlassReference
- GNOME Shell blur repaint issue #2857 (referenced in Guava code), and the blur-my-shell approach
- St inset shadows: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/st/st-theme-node-drawing.c (same in tags 48.0–50.0); CLUTTER_SHOW_FPS: https://gitlab.gnome.org/GNOME/mutter/-/blob/main/clutter/clutter/clutter-context.c
