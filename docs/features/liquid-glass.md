# Liquid Glass

## What it does
One glass for Guava's surfaces: what lies behind is blurred and its colour boosted, a tint with a soft sheen lies over it, with a thin rim and a shadow. Registry id `liquid-glass` (key `liquid-glass`, on). Code: `lib/glass.js` (the service), `lib/glassBlur.js` (the blur effect), `lib/glassParams.js` (the numbers), `features/liquidGlass/`, CSS in `styles/base.css`.

## How it draws
- One effect on the surface actor copies the backdrop from the screen at device pixels (sharp at any scale, fractional included), blurs it at a reduced size, boosts saturation, darkens it (dark glass) or lifts it (light glass), lays the tint over it and cuts the rounded corners. Text keeps 4.5:1 over a white or black backdrop.
- **Menu bar and dock:** one static blur while only the wallpaper is behind them; they blur live while a window overlaps them, once more when the last window leaves, and for 1.5 s after the wallpaper, a Light/Dark flip, a day/night background swap, the monitors or the overview change. A window moving elsewhere costs nothing.
- **No self-blur:** the framebuffer outside a paint's redraw clip still holds the previous frame, glass included. The effect keeps the backdrop in a persistent texture and copies only the pixels inside the redraw clip into it; a capture with no trustworthy cache waits for a paint whose clip covers the whole surface (it queues one). Textures are rounded up to 64 px so a magnifying dock reuses them, and they are rebuilt after `gl-video-memory-purged`. Proof: `tools/scenarios/glass-drift.sh` (50 partial redraws change no pixel; a window leaving leaves no ghost). The GNOME 50 default wallpapers (JPEG XL, through glycin) are read: `tools/scenarios/glass-wallpaper.sh`.
- **Menus, Control Center, overlays:** live blur, recomputed only when they repaint.
- **Under load** live blur freezes on its last image (decorative work goes first) and comes back after 3 s of fast frames.
- **Mission Control:** the menu bar's glass fades with the overview's own progress, frame for frame, also when interrupted. Clear to solid (with "solid when a window touches it") is one interruptible fade.

## Use
- **Surfaces (`liquid-glass-surfaces`, default `panel`, `menus`, `dock`, `overlays`):** menu bar; menus, Control Center and calendar; dock; Spotlight, clipboard and the Stage Manager floor.
- **Clear to Tinted (`glass-tint`, 0):** Clear is more see-through, Tinted more opaque and easier to read.
- **`glass-wallpaper-tint` (on):** a little of the wallpaper's average colour shows through. **`glass-noise` (off):** a faint grain instead of the top-to-bottom sheen.
- **Accessibility:** `glass-reduce-transparency` (opaque, no wallpaper tint), `glass-increase-contrast` (opaque, flat, strong borders), `glass-show-borders` (all off). GNOME's High Contrast also makes Guava surfaces solid.
- Off gives every surface its solid theme colour.

## Limits
- The glass lives on the surface actor itself (an effect plus `guava-glass-*` classes), so it follows rounded corners. App windows stay opaque.
- Screenshots and screencasts show the last blur of a surface.
- Another extension that blurs the same surfaces overlaps with it; use one of them per surface. Guava never changes that extension.
