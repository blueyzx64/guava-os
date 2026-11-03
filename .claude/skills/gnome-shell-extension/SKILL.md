---
name: gnome-shell-extension
description: GNOME Shell 50 extension anatomy and lifecycle for Guava OS. Use when touching extension.js, features.js, lib/featureRegistry.js, lib/disposables.js (cleanup, inject), session modes / lock screen / unlock, enable()/disable() order, extension "rebase" (Dash to Dock hand-off), monkey-patching Shell prototypes (InjectionManager vs cleanup.inject), private Shell API (Main.wm._*, Main.panel._*), EGO review guidelines, metadata.json, or when a feature leaks signals/actors after disable.
---

# GNOME Shell 50 extensions, mapped onto Guava

Running code: GNOME Shell **50.6** JS is extracted at
`/home/user/.swarm/guava-os/refs/gnome-shell-50.6-js/org/gnome/shell/` (paths below are relative
to it). C sources (50.6 tag, `src/` only): `/home/user/.swarm/guava-os/refs/gnome-shell-src/src/`.

## 1. Anatomy (what GNOME gives you)

- `metadata.json`: `uuid`, `shell-version` (Guava: `["50"]`), `settings-schema`, `gettext-domain`,
  optional `session-modes` (default `['user']`, `ui/extensionSystem.js:392`).
- `extension.js` default-exports a class extending `Extension`
  (`extensions/extension.js:7`); GNOME constructs it once, then calls `enable()`/`disable()` many
  times. **The constructor must not create objects, connect signals or add sources** (review rule).
- ESM only: `import X from 'gi://X'`, `import * as Main from 'resource:///org/gnome/shell/ui/main.js'`.
  Shell process must never import `Gtk/Gdk/Adw`; prefs process never `Clutter/Meta/St/Shell`
  (Guava's eslint enforces both, `docs/architecture/code-map.md` §8).

## 2. Lifecycle facts that bite (verified in 50.6)

| Fact | Where |
|---|---|
| `enable()` is **awaited**: `await extension.stateObj.enable()`. An async enable delays every extension after it. | `ui/extensionSystem.js:262` |
| Disabling extension X first disables **every extension enabled after X** (reverse order), then re-enables them ("rebase"). | `ui/extensionSystem.js:191-237` |
| An extension without `unlock-dialog` in `session-modes` is **disabled on lock and re-enabled on unlock** (full teardown + rebuild). | `_extensionSupportsSessionMode` `:168`, `ui/sessionMode.js:67` (`unlock-dialog` has `isLocked: true`) |
| An exception in `enable()` puts the extension in ERROR state and unloads its stylesheet; one in `disable()` is only logged. | `:183-189`, `:266-269` |
| `Main.sessionMode.isLocked` is already `true` when `disable()` runs for a lock. | Guava uses it: `extension.js:141` |
| `Main.layoutManager._startingUp` is true until `startup-complete`; extensions enabled at login run before it. | `ui/layout.js` |

Consequences for Guava:
- **Lock/unlock costs a full Guava teardown and start** (~40 features; harness: `disable()`
  blocks the main loop 233–270 ms, all features settled after 274–556 ms, llvmpipe). `extension.js:56-60,141`
  keeps owned GNOME keys across the lock so nothing flashes, but the CPU cost and every actor
  rebuild remain. Measure it (`guava-harness` skill, `GUAVA_TIMING` probe) before arguing for
  `unlock-dialog` mode; if adopted, review rules require a comment in `disable()` explaining why,
  disconnecting all keyboard handlers while locked, and no selective disabling.
- **The Dash to Dock hand-off triggers a rebase.** `features/dock/dashToDock.js` removes
  `dash-to-dock@micxgx.gmail.com` from `org.gnome.shell enabled-extensions` from an idle.
  If Dash to Dock sits *before* Guava in `Main.extensionManager._extensionOrder`, GNOME disables
  Guava, disables Dash to Dock, then enables Guava again: a second full start at login.
  ⚠ Not measured at a real login; check `_extensionOrder` and the log for a double enable.
- `features.js` modules load lazily (`load: async () => import(...)`); the registry starts each
  feature in the pass after its class arrives (`lib/featureRegistry.js:1-23`), so a cold
  start spans several main-loop iterations. `ext.stateObj._features.settled()` resolves when all
  are in.

## 3. Guava's lifecycle mapping

- `extension.js enable()`: CleanupRegistry, `restoreStale`, core services (events, desktop,
  layout, motion, timers, appMenus, osd), `FeatureRegistry.start(ctx)`; `disable()` mirrors it.
  Per feature: `new Cls(ctx, cleanup)`, `enable()`, … `disable()`, `cleanup.dispose()`.

- One `CleanupRegistry` per feature (`lib/disposables.js:14`), disposed newest-first right
  after `disable()`. Register at creation time: `cleanup.connect(obj, sig, fn)` (`:54`),
  `timeout(ms, fn)` (`:127`), `idle(fn)` (`:152`), `inject(proto, name, fn)` (`:178`),
  `actor(a)` (`:206`), `file(path)` (`:226`), `add(fn)` (`:42`).
- `connect` watches the target's `destroy` and drops registrations for a dead object, so
  disposing never touches a finalized GObject (`:73-105`).
- A feature reaches another only through `ctx.features.instance(id)` at use time plus the
  `feature-changed` event. Never import another feature (tests/architecture.test.js).
- GNOME keys only through `core/originals.js` `SettingOwner` / `ListMembersOwner`; a crash leaves
  the user's value in `saved-originals`, restored at next enable (`extension.js:76-82`).

## 4. Patching the Shell (injections)

Two equivalent tools:

| Tool | Use |
|---|---|
| `cleanup.inject(obj, name, function (orig, ...args) {...})` | Guava's standard. Restores the exact property descriptor (or deletes an own property it added) on dispose (`lib/disposables.js:178-197`). |
| `InjectionManager` (`extensions/extension.js`, class at ~:35) `overrideMethod(proto, name, orig => function (...args) {...})`, `restoreMethod`, `clear()` | GNOME's official helper; same idea. Not used in Guava; don't mix both on one method. |

Rules:
- Patch **prototypes**, not instances, when the Shell may create new ones (50 made `MessageTray`
  native: patch `MessageTray.prototype`, `lib/compat.js:210-214`).
- Bound handlers can't be patched: the Shell connects `this._minimizeWindow.bind(this)` to
  `Shell.WM` (`ui/windowManager.js:528-533`). Guava blocks the **oldest** handler with
  `GObject.signal_handler_find(wm, {signalId})` + `signal_handler_block`, never `*_matched`
  (that would block other extensions' handlers too) — `features/minimizeEffect/index.js:61-73`.
- Two extensions patching the same method stack in enable order; disabling the earlier one
  rebases the later one (§2), so a restore must put back *what it saw*, which `inject` does.
- Stack-sniffing (`new Error().stack.includes('_minimizeWindow')`) is what Compiz Magic Lamp
  and Burn My Windows do (`refs/compiz-alike-magic-lamp-effect/extension.js:47-57`,
  `refs/burn-my-windows/extension.js:223`). Fragile across minifier/rename; don't copy it.

## 5. Private API checklist (every use)

1. Only in an adapter (`index.js`, `view.js`), never in a `model.js`.
2. Guard with `?.` / `typeof fn === 'function'` and fall back to stock behaviour.
3. Comment: Shell file + versions checked (`// ui/windowManager.js _minimizeWindow; checked 50`).
4. Version differences live only in `lib/compat.js` (`SHELL_MAJOR`, `atLeast(n)`).
5. Private names Guava relies on today (re-check on every Shell bump): `Main.wm._minimizeWindow`,
   `_unminimizeWindow`, `_skippedActors`, `Main.panel._leftBox/_centerBox/_rightBox`,
   `Main.layoutManager._startingUp`, `Main.messageTray._notificationQueue/_showNotification/_updateState`,
   `Main.osdWindowManager._showOsdWindow`, `Main.extensionManager._extensionOrder` (tests only).

## 6. What changed for extensions in 49 and 50 (gjs.guide porting guides + typelibs)

GNOME 49 (verified against Meta-18 typelib in the f44 root):
- `Meta.Window.maximize()` / `unmaximize()` take **no flags**; `get_maximized()` is gone, use
  `is_maximized()`. Partial maximize: `set_maximize_flags(Meta.MaximizeFlags.VERTICAL)` /
  `set_unmaximize_flags()`; read with `get_maximize_flags()`.
- `Meta.Rectangle` removed: use `Mtk.Rectangle`.
- `Clutter.ClickAction`/`TapAction` removed: `Clutter.ClickGesture`, `Clutter.LongPressGesture`.
- `Meta.CursorTracker.set_pointer_visible()` removed (`inhibit_cursor_visibility()`).
- New `Meta.Window.set_type`, `hide_from_window_list`, `show_in_window_list`.
- OSD: `OsdWindowManager.show(icon, label, levels)`, `showOne(monitor, ...)`, `showAll`.
GNOME 50:
- **X11 session removed**; Xwayland still runs X11 apps. `global.display.get_x11_display()` is
  null in the harness (no Xwayland). `restart` / `show-restart-message` signals gone.
- `actor.easeAsync(props)`: promise resolves on completion, **rejects with CANCELLED when
  interrupted**. Plain `actor.ease()` swallows the rejection (`ui/environment.js:342-344`).
- `misc/errorUtils.js` `logErrorUnlessCancelled(e)` (`:79`); `GLib.idle_add_once`,
  `timeout_add_once`, `timeout_add_seconds_once`.
- `misc/keyboardManager.js` `holdKeyboard`/`releaseKeyboard` removed.
- `begin_grab_op(op, sprite, time, pos)` takes a `Clutter.Sprite`:
  `global.stage.get_context().get_backend().get_sprite(global.stage, event)` (`ui/windowMenu.js:58-67`).
GNOME 51 (⚠ from third-party ports, Guava has paths in `lib/compat.js`): `Shell.GLSLEffect`
removed (Burn My Windows `src/Shader.js:30`), `Clutter.get_default_backend()` removed (Tiling
Shell `src/utils/gnomesupport.ts:50`), `PopupMenu.close()` takes `{animate}`.

## 7. Review guidelines (extensions.gnome.org) that touch Guava

From gjs.guide/extensions/review-guidelines:
- Everything created in `enable()` destroyed/disconnected/removed in `disable()`, including
  main-loop sources that would return `SOURCE_REMOVE` anyway. (CleanupRegistry does this.)
- No binaries or libraries in the zip; scripts must be GJS. The shelf helper ships as a
  separate RPM (`helpers/guava-shelf-helper/*.spec`), not in the zip: keep it that way.
- No sync IO is a Guava rule, not a review rule, but excessive logging is a review rule:
  `console.error('[Guava] …')` only for real failures.
- Clipboard access must be declared in the description (Guava does) and **no default
  keyboard shortcuts for clipboard actions** (check `schemas/` defaults for Quick Paste).
- Modifying or reloading other extensions is "discouraged, reviewed case by case": the
  Dash to Dock hand-off (§2) needs a justification in the review notes.
- `session-modes` must be omitted when only `user`; `unlock-dialog` needs the comment.
- AI-assisted code is allowed, but imaginary APIs / prompt comments get rejected: never ship a
  call you have not seen work in the harness.

## 8. Pitfalls

- Shell objects given `connectObject(..., owner)` (`misc/signalTracker.js:209`) need
  `disconnectObject(owner)` (e.g. `features/roundedCorners/index.js:120,131`).
- Register GObject classes lazily, once per module (`features/roundedCorners/effect.js:94`);
  a duplicate `GTypeName` throws on the next enable.
- Never keep `Meta.Window`/actors in module variables across disable.
- "Before the next frame": `global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, fn)`
  (`features/dock/index.js:373`); remove on dispose.
- Remote desktop and software rendering **inhibit animations** (`ui/main.js:1027-1056`).

## References (from Kiwi)

- `references/extension-anatomy.md`: file layout, enable/disable lifecycle, schemas and metadata; open when adding or moving extension files.
- `references/version-matrix.md`: Shell API differences per GNOME version; open before using an API that may have changed.
- `references/windows-workspaces-and-actors.md`: window, workspace and actor APIs; open for window state or actor work.
- `references/layout-chrome-and-panel-hiding.md`: hiding or moving Shell chrome (panel, Activities, layout); open before touching Main.layoutManager or panel visibility.
- `references/panel-and-quick-settings.md`: top-bar items and Quick Settings modules; open when adding or changing panel or Control Center items.
- `references/notifications-and-message-tray.md`: message tray, notifications and Do Not Disturb; open for banner or notification work.
- `references/input-keybindings-and-modals.md`: keybindings, modal grabs and keyboard focus; open for shortcuts or modal surfaces.
- `references/clipboard.md`: clipboard selections, MIME types and history; open for copy/paste or Quick Paste code.
- `references/blur-shaders-and-effects.md`: Shell.BlurEffect, shader effects and their cost; open for blur or GLSL work.
- `references/styling-st-css.md`: St theme CSS and stylesheet variants; open when changing stylesheets or theme-dependent styling.
- `references/prefs-adwaita.md`: prefs.js preferences UI in libadwaita; open when building or changing the prefs window.
- `references/testing-and-debugging.md`: running tests, Looking Glass and log inspection; open when debugging a live Shell.
- `references/review-guidelines-and-pitfalls.md`: EGO review rules and common rejection causes; open before submitting a release.
- `references/anti-patterns-in-gnome-extensions.md`: patterns to avoid in extension code, with examples; open during code review.
- `references/testing-strategy.md`: which logic to test at which level (unit, model, shell); open when planning tests.
