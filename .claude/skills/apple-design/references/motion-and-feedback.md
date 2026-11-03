# Motion and feedback

Summary: Apple's motion is purposeful, brief, interruptible and optional. It
leans on springs; Guava gets the same feel from Clutter `ease()` modes, a small
spring progress function and fixed duration tokens. Every animation needs a
reduced-motion path (fade or instant), and nothing may block input.

## Contents
1. Apple's motion rules
2. Duration tokens
3. Springs: Apple's model
4. Mapping to Clutter
5. A spring progress function for GJS
6. Per-component motion recipes
7. Feedback (non-motion)
8. Reduced motion and animations off
9. Sources

---

## 1. Apple's motion rules (HIG Motion, HIG Accessibility)

- Add motion **purposefully**, never just for show.
- Make motion **optional**, and never the only carrier of information.
- Feedback should be realistic and follow the gesture. A view that slides down
  is dismissed by sliding up.
- Keep feedback **brief and precise**.
- **Avoid adding motion to frequent interactions.** The system already
  animates standard controls.
- **Let people cancel motion.** Don't make them wait for an animation to finish.
- Liquid Glass motion is stronger under touch and **more subdued with a
  pointer**. macOS is pointer-first.
- Reduce Motion means:
  - Tighten springs so they don't bounce.
  - Track gestures directly.
  - Avoid z-depth animation.
  - Replace x/y/z transitions with fades.
  - Avoid animating into or out of blur.
- Avoid sustained oscillation at about 0.2 Hz.
- Live Activity animations are capped at **2 s**.

## 2. Duration tokens (Guava)

| Token | ms | Use |
|---|---|---|
| `instant` | 0 | Animations off, or a state that must not lag (focus ring) |
| `micro` | 120 | Hover tint, press darken, glyph reveal on traffic lights |
| `short` | 180 | Toggle switch, tile on/off colour, menu item highlight |
| `standard` | 250 | Popover and Control Center open, panel reveal, Quick Paste in |
| `exit` | 180 | Every *closing* animation, about 70 % of its opening |
| `large` | 350 | Island expand/collapse, Stage switch, Spotlight result expand |
| `xl` | 450 | Rare: overview-scale transitions. Prefer GNOME's own. |

Notes:
- GNOME Shell's own reference points are about 150 ms for popup menus
  (BoxPointer) and about 250 ms for the overview. **[verify in gnome-shell
  source for 48–51]** Stay close to them so Guava doesn't feel foreign next to
  stock UI.
- Exits are faster than entrances. Dismissals never bounce.

## 3. Springs: Apple's model

SwiftUI and Core Animation describe springs perceptually with
`Spring(duration:, bounce:)`:

| Preset | duration | bounce | Feel |
|---|---|---|---|
| `.smooth` | 0.5 s | 0 | Critically damped, with no overshoot. The default. |
| `.snappy` | 0.5 s | 0.15 | Slight overshoot |
| `.bouncy` | 0.5 s | 0.3 | Visible overshoot. Use rarely. |

The conversion to physical parameters (mass m = 1) is
`stiffness k = (2π / duration)²`, `damping c = 4π(1 − bounce) / duration`,
so the damping ratio is **ζ = 1 − bounce**. This comes from Apple's `Spring`
documentation, recalled rather than re-fetched. **[verify]**

The older `response` / `dampingFraction` form maps across as
`response ≈ duration` and `dampingFraction ≈ ζ`. Apple's API defaults are
`spring(response: 0.5, dampingFraction: 0.825)` and
`spring(duration: 0.5, bounce: 0)` (SwiftUI `Animation` docs).

## 4. Mapping to Clutter

`actor.ease({prop: value, duration, mode, delay, onComplete, onStopped})`
is GNOME Shell's helper (environment.js). It already multiplies durations by
`St.Settings.slow_down_factor` and **drops them to 0 when `enable-animations`
is false**.

| Apple intent | Clutter mode | Notes |
|---|---|---|
| `.smooth` spring / ease-out | `EASE_OUT_CUBIC` (≤ 250 ms) or `EASE_OUT_EXPO` (≥ 300 ms) | Best general substitute |
| `.easeInOut` (cubic-bezier 0.42,0,0.58,1) | `EASE_IN_OUT_CUBIC` | Position swaps (Stage strip reorder) |
| `.snappy` spring | `EASE_OUT_BACK` | Fixed overshoot of about 10 %. Close to bounce 0.15–0.2. |
| `.bouncy` spring | Custom spring (section 5) | Never use `EASE_OUT_ELASTIC`. It oscillates too much. |
| Linear | `LINEAR` | Progress bars and spinners only |
| Exit | `EASE_IN_QUAD` (≤ 180 ms) | Accelerate away |

Rules for animating:
- Animate `opacity`, `scale_x` / `scale_y` (set `pivot_point` first),
  `translation_x` / `translation_y`, and colours through St transitions.
- **Never animate `width` / `height` or allocation every frame on big trees.**
  Instead, animate the scale of a clone, or use `translation_*` with a clip.
- For St CSS transitions, `transition-duration` animates only a few properties,
  mainly background colour and border. Use it for hover and press. Use
  `ease()` for geometry.
- Interrupting: call `actor.remove_all_transitions()` before a new `ease()`
  on the same props. Then the new animation starts from the current value
  rather than snapping. This is how Apple's "cancel motion" behaves.

## 5. A spring progress function for GJS

```js
// Damped spring step response, x(0)=0 → x(∞)=1, ζ = 1 - bounce.
export function springProgress(t, durationS, bounce = 0) {
    const w = 2 * Math.PI / durationS;          // natural frequency
    const z = Math.max(0, Math.min(1, 1 - bounce));
    if (z >= 0.999)                              // critically damped
        return 1 - Math.exp(-w * t) * (1 + w * t);
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) *
        (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}
// Timeline length: about 1.2 × duration (smooth) or 1.6 × duration (bouncy)
// so the tail settles. Snap to 1 at the end.
```

How to wire it up:
- Create a `Clutter.PropertyTransition`, set its duration, and pass a progress
  callback (`timeline.set_progress_func`). **[verify it is introspectable in
  your Mutter version]**
- Alternatively, drive a `Clutter.Timeline` `new-frame` handler that writes
  the property. Keep this to one or two actors at a time, for performance.
- Always check `St.Settings.get().enable_animations` and reduced motion before
  starting. If either is off, set the end value immediately.

## 6. Per-component motion recipes

| Component | Enter | Exit | Reduced motion |
|---|---|---|---|
| Panel popover / Control Center | opacity 0→1, scale 0.96→1 from the button-side pivot, `standard` `EASE_OUT_CUBIC` | opacity →0, scale →0.98, `exit` `EASE_IN_QUAD` | opacity only, 150 ms |
| Control Center module expand | The tile scales to the detail rect (clone), `large`, snappy spring. Siblings fade to 0. | Reverse, smooth spring | Crossfade 150 ms |
| Island pill → expanded | Width/height through a scaled clone or clip, `large`, snappy spring. Content fades in after 40 % of the run. | Smooth spring, `standard` | Crossfade, no resize animation |
| Banner absorbed into island | Banner translates up and scales into the pill, `standard` | — | Banner fades out and the pill fades in |
| Quick Paste / Guava Search open | opacity + translation_y −8→0, `standard` | opacity, `exit` | opacity only |
| Auto-hide top bar reveal | translation_y −h→0, `standard` `EASE_OUT_CUBIC` | translation_y →−h, `exit` | opacity only, or instant |
| Traffic-light hover glyphs | opacity 0→1, `micro` | `micro` | Same (fades are fine) |
| Toggle tile on/off | bg colour transition, `short` | — | Same |
| Stage switch | The outgoing stage scales to its strip thumbnail while the incoming one scales from its thumbnail, `large` `EASE_OUT_EXPO` | — | Crossfade 200 ms |
| Live progress (ring/bar) | Animate value changes over ≤ 1 s `EASE_OUT_QUAD`. Never loop decoratively. | — | Instant value jump |

## 7. Feedback (non-motion)

- **Hover:** fill at fg α 0.08, transition `micro`.
- **Press:** fill at α 0.14, scale 0.97 for large tiles only.
- **Focus:** a 2px accent ring with 2px offset, shown **instantly**.
- **Success:** briefly show a check glyph for about 1.2 s in the island, or tint
  the "Copied" row. Audio is optional. Use GNOME's event sounds through
  `global.display.get_sound_player()`, and only when the user's alert sound
  setting allows it.
- **Errors** use a GNOME `ModalDialog` or a notification with a clear message.
  They never rely on a shake animation alone.
- Respect timing: don't auto-dismiss things people must read. The HIG warns
  against time-boxed UI. Pause banner timeouts while the banner is hovered or
  focused.

## 8. Reduced motion and animations off

```js
const st = St.Settings.get();
const animationsOn = () => st.enable_animations;          // performance switch
const reducedMotion = () => guavaSettings.get_boolean('reduce-motion') ||
    systemReducedMotion();  // probe the GNOME a11y schema if present (see accessibility.md)
```

| State | Behaviour |
|---|---|
| Animations off | Everything instant. `ease()` handles this itself. Custom timelines must check. |
| Reduced motion on, animations on | Fades only, 120–180 ms. No scale, translate, spring, parallax or blur-in. |
| Both on (normal) | Full recipes |

Test with `gsettings set org.gnome.desktop.interface enable-animations false`,
and with Guava's toggle.

## 9. Sources

- HIG Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- HIG Accessibility, reduce-motion list: https://developer.apple.com/design/human-interface-guidelines/accessibility
- HIG Live Activities, 2 s cap: https://developer.apple.com/design/human-interface-guidelines/live-activities
- WWDC23 "Animate with springs": https://developer.apple.com/videos/play/wwdc2023/10158/ (presets and the duration/bounce model)
- Apple `Spring` docs: https://developer.apple.com/documentation/swiftui/spring (conversion formula **[verify]**)
- SwiftUI spring defaults: https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:) and …/spring(duration:bounce:blendduration:)
- Secondary spring tutorial: https://www.createwithswift.com/understanding-spring-animations-in-swiftui/
- GNOME Shell `environment.js` (`ease`, `adjustAnimationTime`) in gnome-shell source **[verify per version]**
- GNOME discussion on reduced motion vs enable-animations: https://gitlab.gnome.org/GNOME/gnome-control-center/-/merge_requests/3253
