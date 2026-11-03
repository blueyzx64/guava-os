# Accessibility

Summary: Apple's accessibility rules (contrast, control size, reduce
transparency, motion and contrast settings, keyboard) mapped to GNOME
settings and St and Clutter APIs. Guava's translucency and animation features
must degrade gracefully. Opaque surfaces, fades and full keyboard access are
the requirement, not an extra.

## Contents
1. Apple's numbers
2. Apple's display settings and what they do
3. GNOME settings map
4. Detecting settings in GJS
5. Contrast on glass
6. Keyboard navigation and focus
7. Screen readers (Orca)
8. Pointer, hit targets and timing
9. Test matrix
10. Sources

---

## 1. Apple's numbers (HIG Accessibility)

| Item | Value |
|---|---|
| Text contrast, up to 17 pt | **4.5:1** |
| Text contrast, 18 pt and up, or bold | **3:1** |
| Non-text UI (icons, focus rings, borders that carry meaning) | 3:1 (WCAG 2.x, which Apple's checker follows) |
| macOS default / minimum text size | 13 pt / **10 pt** |
| macOS default / minimum control size | 28×28 pt / **20×20 pt** |
| Padding around bezeled elements | about 12 pt (about 24 pt around elements without a bezel) |
| Text enlargement | Support at least 200 % where feasible |

Further HIG rules:
- Don't use colour alone. Add shape or icon cues.
- Prefer dismissing with an explicit action over timed auto-dismiss.
- Don't override system shortcuts.
- Support Full Keyboard Access.

## 2. Apple's display settings and what they do

| macOS setting | Effect on Liquid Glass and UI (WWDC25 219, HIG) |
|---|---|
| Reduce Transparency | Glass becomes frostier or opaque and hides more of the content behind it |
| Increase Contrast | Elements become mostly black or white with contrasting borders. System colours switch to their high-contrast variants. |
| Reduce Motion | Effects are less intense, elastic behaviour is off, and transitions become fades |
| Liquid Glass look preference (Tahoe 26.1+: Clear default / Tinted; Apple Support 122868) | The user chooses a more opaque "tinted" glass |

Guava offers the same three as user-facing toggles, auto-linked to GNOME
settings where they exist.

## 3. GNOME settings map

| Purpose | GSettings | St / runtime |
|---|---|---|
| Animations (performance switch) | `org.gnome.desktop.interface enable-animations` | `St.Settings.get().enable_animations` |
| Reduced motion (a11y) | `org.gnome.desktop.a11y.interface reduced-motion`, enum `'no-preference'` / `'reduce'` (gsettings-desktop-schemas 50+; absent in 48/49). gnome-control-center MR 3253 (merged, GNOME 50) replaced the "Animations" a11y switch with it; the portal exposes it as `org.freedesktop.appearance reduced-motion`. | `St.Settings.get().reduced_motion === St.ReducedMotion.REDUCE` (gnome-shell 51+ only); probe the schema on 48–50 (section 4) |
| High contrast | `org.gnome.desktop.a11y.interface high-contrast` | `St.Settings.get().high_contrast` |
| Colour scheme | `org.gnome.desktop.interface color-scheme` (`default`, `prefer-dark`, `prefer-light`) | `St.Settings.get().color_scheme` (GNOME 47+) **[verify]** |
| Accent | `org.gnome.desktop.interface accent-color` (GNOME 47+) | CSS `-st-accent-color` |
| Text size | `org.gnome.desktop.interface text-scaling-factor` | Affects pt/em font sizes |
| Status shapes (on/off glyphs on switches) | `org.gnome.desktop.a11y.interface show-status-shapes` **[verify]** | Add an I/O glyph to Guava toggles when it is true |
| Screen reader | `org.gnome.desktop.a11y.applications screen-reader-enabled` | Orca running |
| Magnifier | `org.gnome.desktop.a11y.applications screen-magnifier-enabled` | Avoid heavy blur while magnified, because the magnifier re-renders the stage |
| Reduce transparency | **No GNOME key.** | Guava key `glass-reduce-transparency` (proposed). Forced on by high contrast. |

## 4. Detecting settings in GJS

```js
import Gio from 'gi://Gio';
import St from 'gi://St';

function lookupKey(schemaId, key) {
    const src = Gio.SettingsSchemaSource.get_default();
    const schema = src?.lookup(schemaId, true);
    return schema && schema.has_key(key) ? new Gio.Settings({schema_id: schemaId}) : null;
}

// Reduced motion: St property on Shell 51+, else the a11y schema key (schemas 50+),
// else Guava's own key. The GSettings key is an enum: 'no-preference' | 'reduce'.
const st = St.Settings.get();
const rmSettings = lookupKey('org.gnome.desktop.a11y.interface', 'reduced-motion');
export const reducedMotion = () =>
    guava.get_boolean('reduce-motion') ||
    ('reduced_motion' in st
        ? st.reduced_motion === St.ReducedMotion.REDUCE
        : rmSettings?.get_string('reduced-motion') === 'reduce');

export const highContrast = () => St.Settings.get().high_contrast;
export const reduceTransparency = () => guava.get_boolean('glass-reduce-transparency') || highContrast();
```

How to use these:
- Connect `notify::high-contrast`, `notify::enable-animations` (and
  `notify::reduced-motion` on 51+) on `St.Settings` and `changed::<key>` on the GSettings objects. Re-render
  tokens through the central store (apple-architecture-lessons.md), not in
  each feature separately.
- `has_key` avoids crashes on shells where the key doesn't exist. Never call
  `new Gio.Settings` on a schema that might be missing.

## 5. Contrast on glass

Glass makes contrast depend on the wallpaper. So:

1. **Worst-case testing:** check text over a pure white and a pure black
   wallpaper, and over a busy photo, in both schemes.
2. Ensure **≥ 4.5:1 for body text** against the *composited* background.
   Estimate it as `tint ⊕ blurred(wallpaper)`:
   - `L_bg ≈ α·L_tint + (1−α)·L_wall`.
   - With dark tint α 0.38 over white (L = 1) and white text, contrast is
     about 1.6:1, which **fails**. That's why the tint alone isn't enough over
     bright wallpaper.
   - Guava remedies:
     - **Raise the tint α adaptively** to ≥ 0.62 when the sampled
       wallpaper L > 0.7.
     - Or flip to the light scheme with dark text (small elements only).
     - Or add the 35 % dim layer for the clear variant.
3. The transparent top bar is the riskiest surface. Over a bright wallpaper,
   always add a glyph and text shadow (typography §8), or auto-enable the
   panel background (existing Guava "opaque on window" logic).
4. Focus rings and toggle-on states must reach 3:1 against their surroundings.

```js
// WCAG relative luminance and contrast, for tests and adaptive tint.
const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05); };
```

## 6. Keyboard navigation and focus

Apple's model is Full Keyboard Access: Tab and arrow keys move between
controls, Space or Return activates, and Esc closes. The Guava rules:

| Surface | Open | Inside | Close |
|---|---|---|---|
| Control Center | Super+S (GNOME quick settings) plus a Guava shortcut | Arrows move across the grid in reading order. Space toggles. Return or → expands a module. ← or Esc collapses. | Esc |
| Guava Search / Quick Paste | Configurable (default Super+Space is **often taken** by input sources, so check conflicts). Quick Paste: Super+Shift+V. **[proposal]** | Typing filters. ↑/↓ select. Return activates. Ctrl+1…9 quick-pick. Tab cycles scopes. | Esc. Clicking outside also closes. |
| Island | A shortcut focuses it | ←/→ between activities. Return expands. Action buttons are Tab-reachable. | Esc |
| Traffic lights in panel | Reachable through panel keynav (Ctrl+Alt+Tab → Top Bar) | ←/→ | — |
| Stage strip | Shortcut | ↑/↓ through stages. Return switches. | Esc |

Implementation:
- Set `can_focus: true` and `reactive: true` on every actionable St widget.
- Use `St.Button` where possible, since it gives keyboard activation for free.
- In grid containers, implement `vfunc_navigate_focus` or call
  `this.navigate_focus(from, direction, false)`.
- Grab with `Main.pushModal(actor, {actionMode: Shell.ActionMode.POPUP})`.
  Always `Main.popModal(grab)` on close and in `disable()`.
- **Focus ring:**
  `:focus { box-shadow: inset 0 0 0 2px -st-accent-color; }`. Use 3px in high
  contrast. It must show instantly and never animate.
- Return focus to the previously focused actor or window when closing.

## 7. Screen readers (Orca)

- Set `accessible_name` on icon-only buttons: traffic lights, CC tiles, island.
  Use `accessible_role` (`Atk.Role.TOGGLE_BUTTON`, `PUSH_BUTTON`, `LIST_ITEM`)
  and update `add_accessible_state(Atk.StateType.CHECKED)` for toggles.
- For live activities, announce only **significant** changes, mirroring Apple's
  "alert only for essential updates". Don't announce every timer tick.
- Use clipboard previews in Quick Paste with care: a screen reader may speak
  copied passwords. Mark entries from password managers as sensitive (section
  8) and don't expose their text.

## 8. Pointer, hit targets and timing

- Hit targets are ≥ 28×28px by default, never under 20×20px. The traffic-light
  circles are 12–14px, so **pad the reactive area to ≥ 20px**.
- Edge-reveal (auto-hide bar, Stage strip):
  - Use a dwell of ≥ 150 ms and a pressure barrier so the reveal isn't
    accidental. GNOME has `Meta.Barrier` and `Layout.PressureBarrier`.
  - Offer a keyboard alternative.
- Timeouts:
  - Banners stay ≥ 5 s and pause on hover or focus.
  - Nothing important auto-dismisses.
  - Honour GNOME Do Not Disturb.
- Privacy:
  - Hide clipboard content and live-activity details on the lock screen and
    during screen sharing. Check `Main.sessionMode.isLocked` and screencast
    state.
  - Exclude entries flagged as sensitive (MIME
    `x-kde-passwordManagerHint` = `secret` **[verify]**) from clipboard history.

## 9. Test matrix (run for every UI change)

| | Dark | Light |
|---|---|---|
| Default | ✓ | ✓ |
| High contrast | ✓ | ✓ |
| Guava reduce transparency | ✓ | ✓ |
| Animations off | ✓ | |
| Reduced motion | ✓ | |
| Text scaling 1.5 | ✓ | ✓ |
| Fractional scale 125 % / 200 % | ✓ | |
| Keyboard only (no mouse) | ✓ | |
| Orca on | ✓ | |

## 10. Sources

- HIG Accessibility (contrast table, sizes, reduce-motion list, keyboard): https://developer.apple.com/design/human-interface-guidelines/accessibility
- WWDC25 219 "Meet Liquid Glass" (accessibility adaptations): https://developer.apple.com/videos/play/wwdc2025/219/
- Apple Support, Mac display accessibility settings: https://support.apple.com/guide/mac-help/change-display-settings-for-accessibility-unac089/mac **[verify path]**
- Apple Support, macOS Tahoe 26 updates (26.1 Clear/Tinted Liquid Glass): https://support.apple.com/en-us/122868
- WCAG 2.2 contrast: https://www.w3.org/TR/WCAG22/#contrast-minimum
- GNOME reduced-motion key: https://gitlab.gnome.org/GNOME/gsettings-desktop-schemas/-/blob/main/schemas/org.gnome.desktop.a11y.interface.gschema.xml.in (tag 50.0+) ; St property: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/st/st-settings.c (tag 51.0+) ; https://gitlab.gnome.org/GNOME/gnome-control-center/-/merge_requests/3253 ; https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/6224 ; TWIG #224 https://thisweek.gnome.org/posts/2025/11/twig-224/
- GTK `gtk-interface-reduced-motion` (GTK 4.22): https://docs.gtk.org/gtk4/property.Settings.gtk-interface-reduced-motion.html
- MDN prefers-reduced-motion (GNOME mapping note): https://developer.mozilla.org/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
