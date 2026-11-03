---
name: apple-design
description: Use when designing, implementing or reviewing any Guava OS UI (features/*, core/motion.js, lib/glass.js) that imitates macOS (Liquid Glass translucency, top bar / menu bar, traffic-light window controls, Control Center, Spotlight, clipboard Quick Paste, notification notch / live activities, Stage Manager, auto-hide panel). Gives Apple's design principles, Guava design tokens in GNOME Shell St CSS terms, accessibility toggles Guava must honour, and pointers to detailed references.
---

# Apple design for Guava (GNOME Shell)

Guava borrows the *feel* of macOS 26 (Tahoe, Liquid Glass) and rebuilds it with
GNOME Shell primitives (St widgets, St CSS, Clutter, `Shell.BlurEffect`).
Read this file first; open a reference only when the task needs it.

## Legal guard-rail (read every time)

- Apple is **inspiration only**. Never ship Apple assets: no SF Pro / SF Mono /
  New York fonts, no SF Symbols, no Apple wallpapers, logos, sounds or
  screenshots. The SF fonts and SF Symbols licences restrict use to Apple
  platforms.
- Use open substitutes: **Adwaita Sans** (GNOME 48+ default, derived from Inter)
  or **Inter** (OFL); **Adwaita Mono**; **Adwaita symbolic icons** or Guava's own
  SVGs in `icons/`.
- Don't use Apple's product names as Guava feature names in the UI. Prefer
  "Quick Paste", "Glass", "Island" and "Stages" over "Spotlight™" or
  "Dynamic Island™". Internal docs may name the macOS feature they reference.
- Guava's current UI uses macOS feature names (Spotlight, Mission Control, Launchpad); this is flagged to the maintainer, do not rename on your own.

## Core principles

From WWDC25 *Get to know the new design system*, plus Apple's classic trio:

| Principle | What it means in Guava |
|---|---|
| **Hierarchy** | Controls float on a functional glass layer above content. Show emphasis with grouping and layout, not extra borders. |
| **Harmony** | Shapes are concentric with their container: inner radius = outer radius − padding. Glass takes its colour from what is behind it. |
| **Consistency** | One token set (below) for panel, popovers, Control Center and Quick Paste. Same icons and words everywhere. |
| **Deference** | The UI gets out of the way of windows and wallpaper. Glass is used sparingly and never on content. |
| **Clarity** | Legibility beats translucency. Contrast must stay ≥ 4.5:1 over any wallpaper (see accessibility). |
| **Depth** | Layering, soft shadows and motion explain where things came from. Popovers grow from their button; the island expands from the pill. |

Hard rules:

1. **No glass on glass.** Items inside a glass surface use fills or opacity,
   not a second blur.
2. **Glass for the navigation/control layer only** (panel, popovers, Control
   Center, Quick Paste, island). Never for window content or lists of
   documents.
3. **Tint sparingly.** Use accent colour only for the primary action or an
   active state. When everything is tinted, nothing stands out.
4. **Regular glass by default.** Use the *clear* variant only over media, with
   a 35 % dark dim layer behind bright content (HIG Materials).
5. **Motion is optional.** Every animation needs a no-motion path, and none may
   block input.

## Quick tokens (St CSS)

Apple pt ≈ logical px at scale 1. Use **px for geometry**. Use **pt or em for
text**, because those follow `text-scaling-factor`.

| Token | Value | Notes |
|---|---|---|
| Spacing scale | 4 · 8 · 12 · 16 · 20 · 24 px | 4-px grid. 12 px padding around bezeled elements (HIG a11y). |
| Radius: pill | 999px | Panel buttons, island, Quick Paste search, toggles |
| Radius: popover / menu | 18px outer, 6px padding → 12px items | Concentric |
| Radius: Control Center | 26px outer, 12px padding → 14px modules | Concentric |
| Radius: notification banner | 22px outer, 12px padding → 10px inner | Concentric |
| Radius: small control | 8px (mini–medium), capsule for large | WWDC25 AppKit |
| Top bar height | 28px target; never < 24px | macOS menu bar = 24 pt (HIG) |
| Min hit target | 28×28px default, 20×20px minimum | HIG macOS |
| Type: body | 13px-equivalent (≈ 10pt at 96 dpi, or `1em` of shell font) | macOS Body 13/16 |
| Type: headline | body size, weight 700 | macOS Headline 13/16 bold |
| Type: title 3 / 2 | 15 / 17px-equivalent, weight 600 | Control Center headers, Quick Paste |
| Type: caption | 10–11px-equivalent, never smaller | macOS minimum 10 pt |
| Weights | 400 body · 500 panel · 600 titles · 700 headline | Panel already uses 500 |
| Glass tint (dark) | `rgba(28,28,30,0.38)` + blur radius 30 | Adjust 0.30–0.55 by tier |
| Glass tint (light) | `rgba(246,246,248,0.42)` + blur radius 30 | |
| Glass rim | `border: 1px solid rgba(255,255,255,0.14)` | Increase to 0.35 in high contrast |
| Glass highlight | `box-shadow: inset 0 1px 0 rgba(255,255,255,0.22)` | Top specular edge |
| Elevation | `box-shadow: 0 8px 28px rgba(0,0,0,0.22)` | Popovers/CC. Panel: `0 5px 16px rgba(0,0,0,0.05)` (existing) |
| Dim layer (clear glass) | `rgba(0,0,0,0.35)` | HIG Materials |
| Motion: micro | 120–150 ms `EASE_OUT_QUAD` | Hover, press |
| Motion: standard | 200–250 ms `EASE_OUT_CUBIC` | Popovers, panel reveal |
| Motion: large | 300–400 ms `EASE_OUT_EXPO`, or spring "smooth" | Island expand, Stage switch |
| Spring presets | smooth (bounce 0), snappy (0.15), bouncy (0.3); duration 0.5 s | SwiftUI presets. Clutter recipe in motion ref. |
| Live activity anim cap | ≤ 2 s per update | HIG Live Activities |
| Accent | `-st-accent-color` / `-st-accent-fg-color` | Follow GNOME's accent (GNOME 47+). Never hard-code Apple blue. |

## Accessibility toggles we must honour

| Signal | Source | Guava behaviour |
|---|---|---|
| Animations off | `St.Settings.get().enable_animations` (`org.gnome.desktop.interface enable-animations`) | `actor.ease()` already becomes instant. Custom timelines must check it too. |
| Reduced motion | `org.gnome.desktop.a11y.interface reduced-motion` (`'reduce'`; schemas 50+), `St.Settings.reduced_motion` on Shell 51+. Probe at runtime, plus a Guava toggle. | Replace slides and scales with fades. No spring bounce. No parallax. |
| High contrast | `St.Settings.get().high_contrast` (`org.gnome.desktop.a11y.interface high-contrast`) | Opaque surfaces, 1px solid rims, no clear glass |
| Reduce transparency | GNOME has no system key. Use Guava's `glass-reduce-transparency` toggle (proposed), set automatically when high contrast is on. | Replace blur and tint with an opaque `-st-…` bg colour |
| Colour scheme | `org.gnome.desktop.interface color-scheme` | Light/dark token sets |
| Text size | `org.gnome.desktop.interface text-scaling-factor` | Sizes in pt/em. Layouts grow; never clip. |
| Keyboard | `can_focus`, `:focus` style | Every control reachable. Visible 2px accent focus ring. |

## Decision table → references

| If you are… | Read |
|---|---|
| Adding or tuning blur, glass, tint, highlights or performance tiers | `references/liquid-glass.md` |
| Building panel items, Control Center, notifications, Spotlight, Stage Manager, Dock or traffic lights | `references/macos-shell-patterns.md` |
| Choosing durations, easing or springs, or handling reduced motion | `references/motion-and-feedback.md` |
| Picking font sizes, weights, colours or icons | `references/typography-color-icons.md` |
| Checking contrast, focus, keyboard nav or a11y settings | `references/accessibility.md` |
| Structuring state, modules, tokens or actions in GJS | `references/apple-architecture-lessons.md` |
| Implementing a specific planned feature | `references/feature-design-specs.md` |

## Review checklist (run before merging UI)

- [ ] No Apple fonts, symbols or assets. Strings say "Guava" or a generic term.
- [ ] Radii are concentric. No pinched or flared corners.
- [ ] No nested blur. Glass only on the control layer.
- [ ] Contrast ≥ 4.5:1 for text on the lightest and darkest wallpaper.
- [ ] Works with animations off, reduced motion and high contrast.
- [ ] Keyboard: open, navigate, activate and Esc-close all work.
- [ ] Layout follows `text-scaling-factor` 1.25 and 1.5 without clipping.
- [ ] Multi-monitor and fractional scaling checked. Blur repaint hack attached
      (`(Kiwi: apps/blurPaintSignal.js; Guava equivalent not verified)`).
- [ ] `disable()` removes every actor, effect, signal and timeout.
