# Version matrix: GNOME Shell 45 to 51 for extension authors

Summary: what changed in each release from GNOME 45 to GNOME 51 that can break or affect extension code, and which Fedora release ships which GNOME.
Guava supports 48 to 51, so the 48 to 51 rows matter most. Use the 45 to 47 rows to understand old snippets you find online.
Facts were checked against gnome-shell, mutter and gjs sources and NEWS at release tags, and against gjs.guide porting guides. Anything not checked is marked (unverified).

## Contents
1. Fedora ↔ GNOME mapping
2. Per-version changes (45, 46, 47, 48, 49, 50, 51)
3. Quick compatibility shims for 48 to 51
4. Library versions (gjs, SpiderMonkey, libadwaita)
5. Sources

## 1. Fedora ↔ GNOME mapping

| Fedora | GNOME | Released | Notes |
|---|---|---|---|
| 41 | 47 | 2024-10-29 | Workstation media is Wayland-only. X11 session packages are still in the repos. |
| 42 | 48 | 2025-04-15 | |
| 43 | 49 | 2025-10-28 | GNOME X11 session removed from the repos (Change "WaylandOnlyGNOME"). Users are migrated to Wayland. |
| 44 | 50 | 2026-04-28 | |
| 45 | 51 | Beta 2026-09-15. Current Final target 2026-11-03 (target #3 2026-11-10); Final Freeze since 10-20 | GNOME 51 is in F45 (Bodhi: gnome-shell + mutter 51.0 stable 2026-09-30, 51.1 in testing). Not released as of 2026-10-25: docs.fedoraproject.org lists F44 and F43 as the supported releases. |

Sources: release dates from the "Current Final Target date" rows of https://fedorapeople.org/groups/schedule/f-41/f-41-key-tasks.html (and f-42 … f-45); GNOME versions from Bodhi/mdapi gnome-shell and libadwaita builds per release; Changes "WaylandOnlyGNOMEWorkstationMedia" (F41) and "WaylandOnlyGNOME" (F43) from https://fedoraproject.org/wiki/Releases/41/ChangeSet and /43/ChangeSet; supported list from https://docs.fedoraproject.org/en-US/releases/lifecycle/ (checked 2026-10-25).

## 2. Per-version changes

### GNOME 45 (Sept 2023): the ESM break
- Extensions are ES modules. `extension.js` and `prefs.js` must `export default`
  a subclass of `Extension` or `ExtensionPreferences`. Import Shell modules from
  `resource:///org/gnome/shell/ui/*.js`. In prefs, use
  `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js` (note the
  capital S). gnome-shell NEWS 45.beta: "Load extensions as modules",
  "Port to EcmaScript modules".
- `ExtensionUtils` is replaced by methods on the class: `this.getSettings()`,
  `this.path`, `this.dir`, `this.metadata`, `this.uuid`, `this.gettext()`,
  `Extension.lookupByURL(import.meta.url)` and `lookupByUUID()`. NEWS 45.beta:
  "Overhaul ExtensionUtils API for modules".
- New `InjectionManager` in `resource:///org/gnome/shell/extensions/extension.js`
  (NEWS 45.beta). It supports `vfunc_` overrides.
- `QuickSettings.addExternalIndicator(indicator, colSpan)` was added (NEWS 45.rc
  "Add extension hook to add quick settings items").
- `gettext-domain` falls back to the UUID (NEWS 45.rc).
- Notification source classes are exported (NEWS 45.beta.1). The 45
  Notification API is still the old one: `new Notification(source, title, banner, params)`
  and `source.showNotification(n)` (`js/ui/messageTray.js` at tag 45.0).
- `Meta.Barrier` takes `display: global.display` (layout.js 45.0).
- `Shell.BlurEffect` has a `sigma` property (shell-blur-effect.c 45.0).

### GNOME 46 (March 2024)
- **Clutter.Container removed** (mutter NEWS 46.alpha "Drop ClutterContainer").
  `add_actor`/`remove_actor` become `add_child`/`remove_child`, and the
  `actor-added`/`actor-removed` signals become `child-added`/`child-removed`.
  `ClutterCanvas` was also removed (mutter 46.beta). Use `St.DrawingArea`.
- **Notifications rewritten.** `Notification` is now a plain `GObject.Object`
  built from a property bag: `new MessageTray.Notification({source, title, body, ...})`.
  Post with `source.addNotification(n)`. `Source` takes `{title, iconName, policy}`.
  `MessageTray.getSystemSource()` replaces `SystemNotificationSource`
  (messageTray.js 46.0; NEWS 46.beta "Use a single source for all system notifications").
- `Shell.BlurEffect`: `sigma` replaced by `radius`, with radius = 2 × sigma.
  unlockDialog went from `BLUR_SIGMA = 45` to `BLUR_RADIUS = 90`. See
  shell-blur-effect.c 46.0 and gjs.guide/extensions/upgrading/gnome-shell-46.html.
- `Meta.Barrier` takes `backend: global.backend` (layout.js 46.0).
- `version-name` is supported in metadata (NEWS 46.alpha). The prefs dialog
  is shown only after the extension has loaded.
- gjs 1.80: GLib/Gio Unix APIs moved to `GLibUnix`/`GioUnix`. The old names
  still work but log a deprecation warning (gjs NEWS 1.80).

### GNOME 47 (Sept 2024)
- **Clutter.Color removed. Use Cogl.Color** (mutter 47 NEWS "Merge ClutterColor
  and CoglColor"; `clutter-color.h` is gone at 47.0).
- **Accent color.** The setting is `org.gnome.desktop.interface accent-color`.
  St CSS gained `-st-accent-color`, `-st-accent-fg-color`, and the functions
  `st-mix()`, `st-lighten()`, `st-darken()` and `st-transparentize()`
  (st-theme-node.c 47.0; gjs.guide 47 porting guide).
- `fillPreferencesWindow()` and `getPreferencesWidget()` are awaited, so they
  may be `async` (gjs.guide 47; extensionPrefsDialog.js `await prefsObj.fillPreferencesWindow(this)`).
- gjs 1.82 (SpiderMonkey 128): `new GObject.Class(args)` accepts only one
  property-bag argument. `get_data`/`set_data`/`ref`/`unref` throw.
- Shell can be built without X11 (NEWS 47.alpha). (Fedora 41 ships Wayland-only media.)

### GNOME 48 (March 2025): Guava's floor
- `ExtensionBase.getLogger()` returns a console that prefixes `[Extension name]`
  (NEWS 48.alpha "Add convenience logging API for extensions";
  sharedInternals.js `class Console`).
- **St.BoxLayout `orientation`** (a `Clutter.Orientation`) was added. `vertical`
  is deprecated and `pack-start` removed (st-box-layout.c 48.0; NEWS 48.beta
  "Transition to new BoxLayout.orientation property").
- `Clutter.Image` removed (mutter 48.alpha). Use `St.ImageContent`.
- `Shell.SnippetHook` → `Cogl.SnippetHook` (gjs.guide 48).
- `WindowManager` `_startSwitcher()`, `_startA11ySwitcher()`,
  `_switchToApplication()`, `_openNewApplicationWindow()` and
  `_showWorkspaceSwitcher()` take `event` as their third argument, and
  `InputSourceManager._switchInputSource(display, window, event, binding)`
  gained `event` too (gjs.guide 48).
- Notifications are grouped by app in the message list (NEWS 48.rc).

### GNOME 49 (Sept 2025)
- **Meta.Window maximize API.** `maximize()` and `unmaximize()` take no
  `Meta.MaximizeFlags`. `get_maximized()` is removed: use `is_maximized()`, or
  `get_maximize_flags()`, `set_maximize_flags(flags)`, `set_unmaximize_flags(flags)`
  for one axis. Verified by diffing mutter `src/meta/window.h` 48.0 against 49.0.
  The flag setters were made public again in mutter 49.rc (!4573).
  shexli rules: EGO-C49-003, EGO-C49-004.
- **Clutter actions removed.** `ClickAction`, `TapAction`, `PanAction`,
  `SwipeAction`, `ZoomAction`, `RotateAction` and `GestureAction` are replaced
  by `Clutter.ClickGesture`, `LongPressGesture`, `PanGesture` and `Clutter.Gesture`
  (mutter clutter headers 48.0 vs 49.0; EGO-C49-002).
- `Meta.CursorTracker.set_pointer_visible()` removed. Use
  `inhibit_cursor_visibility()` and `uninhibit_cursor_visibility()`
  (meta-cursor-tracker.h 49.0; EGO-C49-005).
- **Do Not Disturb moved into Quick Settings** (`js/ui/status/doNotDisturb.js`).
  `DoNotDisturbSwitch` is gone from calendar.js (EGO-C49-001; NEWS 49.alpha.1).
- `AppMenuButton` removed from panel.js. `Meta.Rectangle` (a deprecated alias
  returning `Mtk.Rectangle` since 45) is removed: use `Mtk.Rectangle` (gjs.guide 49, 45).
- **X11 backend disabled by default** in mutter (49.alpha.0). The old nested
  mode depended on it. **`gnome-shell --devkit`** was added (NEWS 49.alpha.0).
  The nested window comes from the `mutter-devkit` package.
- New `gnome-extensions upload` command (NEWS 49.alpha.1).
- gjs 1.86 (SpiderMonkey 140): iterator helpers, `Float16Array`.

### GNOME 50 (March 2026)
- **X11 backend dropped** from mutter (50.alpha "Drop the X11 backend"). Shell
  adapted in NEWS 50.alpha. Xwayland clients remain (`Meta.WindowClientType.X11`).
  The `restart` and `show-restart-message` signals on `global.display` are gone,
  and so is `RunDialog._restart()` (gjs.guide 50; EGO-C50-001, EGO-C50-002).
- **`affectsInputRegion` chrome param removed.** `layout.js` `defaultParams`
  is now only `{trackFullscreen, affectsStruts}`, and `Params.parse` throws
  `Unrecognized parameter "affectsInputRegion"` if you pass it to
  `addChrome`, `addTopChrome` or `trackChrome` (layout.js 49.0 vs 50.0). The
  X11 stage input region code is gone too.
- `gnome-shell --nested` removed (mutter 50.0 `meta-context-main.c` has only
  `--devkit`, `--devkit-args`, `--virtual-monitor`).
- `Clutter.Actor.prototype.easeAsync()`, `ease_property_async()` and
  `St.Adjustment.easeAsync()` were added (NEWS 50.alpha "Add async ease variants";
  environment.js).
- `Meta.Window.get_min_size()`/`get_max_size()`, `inhibit_mapped()` and external
  constraints were added (window.h 50.0).
- `Clutter.KeyController` and `Clutter.ScrollController` were added (mutter
  50.0 "Add simple 'controller' API" !4943; headers exist at 50.0 but not 49.0).
  Shell code is moving from raw `key-press-event` and `button-press-event`
  handlers to gestures and controllers (NEWS 50.alpha, 51.beta, 51.rc). The
  raw signals still work.
- `Meta.Display.set_cursor()` removed (display.h 49.0 vs 50.0).
- gjs 1.88: `GLib.idle_add_once`, `timeout_add_once` and `timeout_add_seconds_once`
  are introspectable.

### GNOME 51 (Sept 2026)
- **`disable()` must not be async.** extensionSystem.js throws
  `'disable() must not be async'` (NEWS 51.beta !4276).
- **St `vertical` property removed.** Use `orientation: Clutter.Orientation.VERTICAL`
  (st-box-layout.c 51.0; gjs.guide 51).
- **`Shell.GLSLEffect` removed.** It was replaced by `Clutter.ShaderEffect`
  (NEWS 51.alpha !4241; `src/shell-glsl-effect.c` exists at 50.0, missing at 51.0).
  `Clutter.ShaderEffect` itself switched from GLSL source to Cogl snippets:
  `set_shader_source()`, `get_static_shader_source` and `new(shaderType)` were
  removed, and `new_with_snippet(snippet)` and `vfunc_get_static_snippet()`
  were added (mutter 51.alpha "Remove CoglProgram/Shader API" !5094;
  clutter-shader-effect.h 50.0 vs main). See `blur-shaders-and-effects.md`.
- **PopupMenu `open()`/`close()` take a params object** such as `{animate: false}`,
  not a `BoxPointer.PopupAnimation` value (NEWS 51.alpha !4240; popupMenu.js).
- `js/ui/pointerWatcher.js` removed (exists at 50.0, 404 at 51.0). The magnifier
  now uses the cursor tracker's `position-invalidated` signal plus laters.
- `St.ButtonMask` names now match Clutter and GTK. The old names are deprecated
  but still work (gjs.guide 51; NEWS 51.alpha !4224).
- `St.Settings` has `reduced-motion` (st-settings.c; NEWS 51.beta).
  `NoGrabPopup` is in keyboard.js (gjs.guide 51).
- `Meta.Window.get_gtk_theme_variant()` removed (window.h 50.0 vs main).
- Extensions app split into its own repository (NEWS 51.alpha). Extension zips
  are extracted with gnome-autoar (51.1).
- mutter 51: `ext-background-effect-v1` blur protocol for Wayland clients
  (51.beta !5071). Background blur fixed in offscreen and clone paints (51.0 !5220).
- gjs 1.90: `Gio.DBus.makeProxyWrapper()` should be called with `new`. It still
  works without, but warns. `GObject.Interface` methods are no longer static on
  the constructor (gjs NEWS 1.89.x).

## 3. Quick compatibility shims for 48 to 51

```js
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);

// maximize: 48 needs flags, 49+ takes none
const maxArgs = SHELL_MAJOR >= 49 ? [] : [Meta.MaximizeFlags.BOTH];
win.maximize(...maxArgs);
const isMax = win.is_maximized?.() ?? (win.get_maximized() === Meta.MaximizeFlags.BOTH);

// BoxLayout orientation exists in 48+, so it is always safe for Guava
new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});

// menu close: 51 takes params, 48 to 50 take a PopupAnimation
menu.close(SHELL_MAJOR >= 51 ? {animate: false} : BoxPointer.PopupAnimation.NONE);

// chrome: never pass affectsInputRegion (it throws on 50+)
Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: true});

// shader: feature-detect, as in (Kiwi: apps/minimizedToDock.js; Guava equivalent not verified)
const legacyShader = !!Clutter.ShaderEffect.prototype.set_shader_source;
```

## 4. Library versions

| GNOME | gjs | SpiderMonkey | libadwaita (prefs) |
|---|---|---|---|
| 45 | 1.78 | 115 | 1.4 (SwitchRow, SpinRow added) |
| 46 | 1.80 | 115 | 1.5 (Adw.Dialog, AlertDialog, PreferencesDialog) |
| 47 | 1.82 | 128 | 1.6 (ButtonRow) |
| 48 | 1.84 | 128 | 1.7 (ToggleGroup, WrapBox) |
| 49 | 1.86 | 140 | 1.8 (ShortcutsDialog) |
| 50 | 1.88 | 140 | 1.9 (Sidebar) |
| 51 | 1.90 | 140 | 1.10 |

The gjs ↔ GNOME pairing comes from gjs NEWS ("First release in the GNOME 51
series" for 1.90.0, and so on). The libadwaita ↔ GNOME pairing for 48–51
matches Fedora 42–45 builds (Bodhi/mdapi: 1.7.x, 1.8.x, 1.9.x, 1.10.0). The
widgets listed for each libadwaita version come from libadwaita NEWS.

## 5. Sources
- gnome-shell NEWS and sources: https://gitlab.gnome.org/GNOME/gnome-shell (tags 45.0, 46.0, 47.0, 48.0, 49.0, 50.0, 51.0, main = 51.1). Originally read through the GitHub mirror; key items re-checked on gitlab.gnome.org on 2026-10-25.
- mutter NEWS and headers: https://gitlab.gnome.org/GNOME/mutter (window.h, display.h, meta-cursor-tracker.h, clutter-shader-effect.h, meta-context-main.c)
- gjs NEWS: https://gitlab.gnome.org/GNOME/gjs/-/blob/master/NEWS
- libadwaita NEWS: https://gitlab.gnome.org/GNOME/libadwaita/-/blob/main/NEWS
- Porting guides: https://gjs.guide/extensions/upgrading/gnome-shell-45.html … https://gjs.guide/extensions/upgrading/gnome-shell-51.html (full pages re-read 2026-10-25)
- shexli rule spec (rule IDs EGO-*): https://pypi.org/project/shexli/ (spec.py, SPEC_VERSION 2026-04-02)
- Fedora: https://fedorapeople.org/groups/schedule/f-45/f-45-key-tasks.html , https://bodhi.fedoraproject.org/updates/?packages=gnome-shell , https://docs.fedoraproject.org/en-US/releases/lifecycle/ , https://fedoraproject.org/wiki/Releases/43/ChangeSet
