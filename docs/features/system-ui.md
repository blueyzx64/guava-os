# Volume pill, glass dialogs and colour filters

## Volume and brightness (`osd`)
`osd-location` chooses where changes show: `notch` (default, while the notch runs; otherwise the pill), `menu-bar` (a compact glass pill that drops under the Control Center button, as in macOS 26) or `system` (GNOME's centred pop-up). Volume, brightness and keyboard backlight are routed to one place; other OSDs and other monitors stay stock. The pill shows the output name and mute state and does not take clicks. Code: `core/osd.js`, `features/osd/`.

## Glass dialogs (`dialogs`, key `dialogs-glass`, on)
The Shell's modal dialogs (authentication, log out, restart, shut down, Run a Command, other extensions' dialogs) open as glass alerts: icon on top, buttons at the right, the default one in the accent colour. Theme only: the dialogs' logic is untouched. Each dialog is dressed when it opens and undressed when it closes or on disable. There is no preferences row; turn it off with `gsettings set org.gnome.shell.extensions.guava-os dialogs-glass false`. Code: `features/dialogs/`.

## Colour filters (`color-filters`, key `color-filter`, off)
Accessibility filters on the whole screen: greyscale, red/green (protanopia), green/red (deuteranopia) and blue/yellow (tritanopia) corrections, and a colour tint. Settings: `color-filter-kind` (`greyscale` default), `color-filter-intensity` 100, `color-filter-hue` 40 (for the tint). Found on the Appearance page. One shader effect on the Shell's UI group does the work, so changing the type or intensity only updates uniforms. Code: `features/colorFilters/`.


## Lock screen (session mode `unlock-dialog`, D-018, D-022)
Guava declares `"session-modes": ["user", "unlock-dialog"]` in `metadata.json`. The Shell therefore keeps it enabled while the screen is locked: a lock costs no teardown and an unlock restores everything at once (before, every lock disabled and rebuilt about 40 features).

While locked:
- Every feature is **suspended**. `FeatureRegistry.setLocked(true)` (called from `extension.js` when `Main.sessionMode` updates) calls `CleanupRegistry.suspend(true)` on each running feature: the actors the feature registered with `cleanup.actor()` or `cleanup.surface()` (chrome added by `core/layout.js`, the notch island, the menu-bar reveal edge, the widget gallery) are hidden and not reactive (`lib/lockModel.js`, `SurfaceLedger`). Unlock restores exactly what was visible and reactive before.
- No input: Guava's keybindings use the `NORMAL | OVERVIEW` (or `POPUP`) action modes, which the Shell does not match while locked; open Guava modals (`lib/modalSurface.js`) close on lock; hidden actors take no pointer or key events.
- A feature that starts while locked (a setting flips) starts suspended.
- Guava's changes to stock chrome (a restyled panel, moved items) are not undone: the Shell rebuilds the panel for the lock mode itself.
- Nothing is shown from Guava's side: the notch and its banners are hidden; stock notifications use the lock screen's own list.

### Hook for features that run on the lock screen
A feature entry in `features.js` opts in with `lockScreen: true`. The registry keeps it active and never hides its surfaces. It receives:
- `ctx.session.locked` (boolean, live);
- `instance.lock()` and `instance.unlock()` (both optional) on each change, and again at `enable()` time if the screen is already locked (`lock()` is called right after `enable()`);
- the core events `session-locked` and `session-unlocked` on `ctx.events`.

A `lockScreen` feature owns what it shows: it must stay inert for everything but its own UI, add its actors to the lock dialog group (`Main.screenShield`, `Main.layoutManager.screenShieldGroup`) rather than `addChrome`, and follow EGO rules for `unlock-dialog` (no keyboard handling outside its own UI, no selective disabling). The one feature that uses it is `lock-screen` (`docs/features/lock-screen.md`): it styles GNOME's own lock dialog and adds nothing else.

Test: `tools/scenarios/lock-screen.sh` pushes and pops the `unlock-dialog` mode on `Main.sessionMode` (the harness has no real lock screen), checks that Guava stays enabled, its surfaces hide and return, and prints the lock and unlock cost. Unit: `tests/lockModel.test.js`.
