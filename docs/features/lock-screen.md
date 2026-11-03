# Lock screen like macOS

macOS Tahoe's lock screen on GNOME's own: a large clock, your wallpaper, and your photo, name and a glass "Enter Password" capsule at the bottom centre. Registry id `lock-screen` (key `lockscreen-style`, on). Preferences: General > Lock Screen. Code: `features/lockScreen/`. Decision: D-022 (amends D-018).

**Sign-in is GNOME's.** The password prompt, GDM, PAM, fprintd, polkit, the swipe, the 2 minute idle return and the unlock animation are the Shell's own code and run unchanged. The feature only styles and arranges GNOME's lock dialog (`ui/unlockDialog.js`); it never replaces or wraps the authentication path.

## What you see
- **Clock.** The date above, a large light time below, in the upper part of the screen. No AM / PM in the large time (as macOS). The date and time come from the Shell's own clock, so the 12 / 24 hour setting and the language apply.
- **Wallpaper.** Your desktop wallpaper, sharp (macOS), under a dark scrim so the text stays readable on any picture. Option `Blurred`: GNOME's blurred, dimmed wallpaper with a lighter scrim.
- **Bottom centre.** Your photo and name, and the capsule. Click it, press Enter or press any key: the capsule crossfades into GNOME's real password field in the same place (the field does not jump). The password field is created only then, exactly as on stock GNOME. A wrong password returns to the capsule: it flashes its border red and, if reduced motion is off, shakes.
- **Notifications and Now Playing.** On glass rows under the clock: the apps with unread notifications and how many, never a title or body (GNOME shows bodies of system sources and of apps that opted in; this feature forbids it). Media controls for what is playing.
- **Sleep, Restart, Shut Down** (off). Three glass buttons under the capsule, shown only when logind answers "yes" without a password. Sleep acts at once; Restart and Shut Down need a second press within 4 s (the caption becomes "Click Again"). This is macOS's confirm without a second surface on the lock screen. The call goes to logind (`org.freedesktop.login1.Manager`), the service GDM's greeter uses.

## Settings (all in General > Lock Screen)
| Key | Default | Meaning |
|---|---|---|
| `lockscreen-style` | on | The whole feature. Off: GNOME's lock screen, untouched. |
| `lockscreen-large-clock` | `lock-screen` | `lock-screen` or `never`. |
| `lockscreen-wallpaper` | `sharp` | `sharp` or `blurred`. |
| `lockscreen-show-user` | on | Photo and name above the password field. |
| `lockscreen-message-on`, `lockscreen-message` | off, empty | A text (up to 140 characters) shown above the capsule. Anyone can read it. |
| `lockscreen-power-buttons` | off | Sleep, Restart, Shut Down. |
| `lockscreen-now-playing` | on | Media controls only, no other app data. |
| `lockscreen-notifications` | `count` | `count` (apps and counts) or `never`. |
| `lockscreen-password-hint` | off | After three wrong attempts, the account's password hint (AccountsService), if it has one. |

macOS also offers "previews: when unlocked". GNOME cannot reveal content after a separate authentication, so there are two choices (counts, never) and no bodies at any time.

Changing a setting while the screen is locked restyles the open dialog at once.

## Privacy and safety
While locked, only the lock dialog's own actors are visible or reactive. Every other Guava feature is suspended (`docs/features/system-ui.md`): no notch banners, Spotlight, clipboard, widgets, dock or menu bar. This feature adds no keybinding and no input surface of its own. The message and the hint are the only user text it shows, and only if you turn them on.

Accessibility: every control is keyboard-focusable (Tab / Shift+Tab, Enter, Space) with an accessible name; the unlocked capsule, power buttons and hint have visible focus rings. Contrast, measured by `tests/lockScreenModel.test.js` over the worst wallpaper (pure white): small text sits on the glass fill at 7.3:1 (needs 4.5:1); the large clock, date and name sit on the scrim at 3.4:1 (large text needs 3:1). Reduced motion: no shake, no scaling; the page change is a crossfade.

## How it works
- `features/lockScreen/index.js`: a `lockScreen: true` feature (`features.js`, `later`). A wrapper around `ScreenShield._ensureUnlockDialog` lets the Shell create its dialog, then styles it. A dialog that exists already (Guava enabled while locked) is styled from `lock()`. A failure leaves the dialog stock and logs one error. No screen shield (no GDM) means nothing to do.
- `dialog.js`: `StyledDialog` dresses one dialog and undoes it on `dispose()`: scrim, own clock labels fed from the stock clock, the capsule "teaser" inside the stock page stack, its own layout manager (`model.js` `layout()`), notification and media rules (`_shouldShowDetails` returns false; source and media rows kept hidden), instance overrides of `_setTransitionProgress` (crossfade, no scaling), `_ensureAuthPrompt` (styles the real prompt) and `_updateBackgroundEffects` (sharp wallpaper: the blur effect removed). Private Shell API is listed in the file header (GNOME Shell 50.6).
- `model.js`: options, `bigTime`, `layout`, power confirm, notification and hint rules, contrast tokens. `power.js`: logind. `style.css`: every rule scoped by `guava-lock-dialog` or a `guava-lock-*` class.
- Enable and disable are exact mirrors: turning the feature off while locked gives the stock dialog back.

## Tests and limits
- Unit: `tests/lockScreenModel.test.js` (options, layout on 1280x720 to 4K and scales, power confirm, rules, contrast, tokens match the CSS).
- Real Shell: `tools/scenarios/lock-screen-style.sh` with `lock-screen-style-pre.sh`. The headless harness Shell has no screen shield, so the pre script fakes the two things `LoginManager.canLock()` asks for (systemd's seats directory and GDM's `org.gnome.DisplayManager` version on the system bus). The real `ScreenShield` and `UnlockDialog` then run: the scenario locks with `Main.screenShield.lock(false)`, lifts the black fade with `_wakeUpScreen()`, checks geometry, every option, privacy (a notification with a secret body), the 4-cycle leak check and turning the feature off while locked, and unlocks with `deactivate(false)`.
- **Not testable in the harness:** a real password check (no GDM greeter, PAM or fprintd): the prompt shows "Authentication error" and the unlock is driven by `deactivate()`; a wrong password typed by a user (the failure path is driven by emitting the dialog's `failed` signal; the shake and the hint after three failures are unit-tested only); logind actions (a spy replaces them); a real wallpaper (the root has none, so sharp and blurred look alike in screenshots; the blur effect's presence is asserted); multi-monitor and HiDPI layouts (unit-tested layouts only); the user's real photo and name (AccountsService is absent).
