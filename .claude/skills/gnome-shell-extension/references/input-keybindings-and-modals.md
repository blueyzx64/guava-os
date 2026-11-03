# Input: keybindings, modals, grabs, key focus, search, pointer, barriers

Summary: how to register a global shortcut (`Main.wm.addKeybinding` with a GSettings `as` key) and how to open a Spotlight-style modal with `Main.pushModal` or `ModalDialog`.
It also covers key focus in `St.Entry`, search providers, cursor tracking without polling, and `Meta.Barrier`/`PressureBarrier`/hot corners.
Verified against gnome-shell main (51): `windowManager.js`, `main.js`, `modalDialog.js`, `runDialog.js`, `layout.js`, `searchController.js`, `remoteSearch.js`, `magnifier.js`, `src/shell-action-modes.h`; and mutter `prefs.h`, `barrier.h`, `meta-cursor-tracker`.

## Contents
1. Global keybindings
2. Modal UI: pushModal/popModal vs ModalDialog
3. Spotlight overlay recipe
4. Key handling and focus
5. Search providers
6. Pointer tracking (events vs polling)
7. Meta.Barrier, PressureBarrier, hot corners
8. Sources

## 1. Global keybindings
Schema (`schemas/org.gnome.shell.extensions.guava-os.gschema.xml`):
```xml
<key name="spotlight-shortcut" type="as">
  <default><![CDATA[['<Super>space']]]></default>
  <summary>Open Guava Spotlight</summary>
</key>
```
Code:
```js
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
// enable()
Main.wm.addKeybinding('spotlight-shortcut', this._settings,
    Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
    () => this._toggleSpotlight());
// disable()
Main.wm.removeKeybinding('spotlight-shortcut');
```
- Implementation: `global.display.add_keybinding(name, settings, flags, handler)`
  plus `allowKeybinding(name, modes)` (windowManager.js). It returns
  `Meta.KeyBindingAction.NONE` on failure, for example when the key name
  already exists.
- `Meta.KeyBindingFlags`: `NONE`, `PER_WINDOW`, `BUILTIN`, `IS_REVERSED`,
  `NON_MASKABLE`, `IGNORE_AUTOREPEAT`, `NO_AUTO_GRAB`, `CUSTOM_TRIGGER`,
  `TRIGGER_RELEASE` (mutter prefs.h main).
- `Shell.ActionMode`: `NONE`, `NORMAL`, `OVERVIEW`, `LOCK_SCREEN`,
  `UNLOCK_SCREEN`, `LOGIN_SCREEN`, `SYSTEM_MODAL`, `LOOKING_GLASS`, `POPUP`,
  `ALL`.
- `<Super>space` collides with GNOME's input-source switch
  (`org.gnome.desktop.wm.keybindings switch-input-source`). Check for the
  conflict and tell the user. The guidelines forbid default shortcuts for
  clipboard actions, so ship clipboard-history shortcuts empty
  (review-guidelines.md).
- Rebinding from prefs: write the `as` key. The Shell picks up the change
  automatically because the binding reads the settings object.

## 2. Modal UI
`Main.pushModal(actor, {actionMode})` → `Clutter.Grab`:
- It calls `global.stage.grab(actor)`, disables unredirect, records the
  previous key focus and sets key focus to `actor`. The default `actionMode`
  is `NONE`, which blocks all global keybindings. Pass `Shell.ActionMode.POPUP`
  or `SYSTEM_MODAL` deliberately.
- `Main.popModal(grab)` restores focus and action mode. It throws
  `'incorrect pop'` for an unknown grab. If the actor is destroyed while modal,
  the Shell pops automatically (`destroy` handler in pushModal).
- Always pop in `disable()` if you are still open. Guava's
  `features/dock/stack.js` uses `Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP})`.

`ModalDialog.ModalDialog` (modalDialog.js):
- Params: `{styleClass, actionMode = SYSTEM_MODAL, shellReactive = false,
  shouldFadeIn, shouldFadeOut, destroyOnClose = true}`.
- It adds itself to `Main.layoutManager.modalDialogGroup`, is bound to stage
  size, and adds a lightbox with a radial vignette unless `shellReactive`.
- API: `contentLayout`, `buttonLayout`, `setButtons([{label, action, key, default}])`,
  `setInitialKeyFocus(actor)`, `open()`, `close()`, signals `opened` and
  `closed`. It emits `Main.layoutManager` `system-modal-opened`, which closes
  open popup menus.
- It is good for a confirmation-style dialog. For a Spotlight look (no dim, a
  floating rounded panel), a custom actor with `pushModal` gives more control.

## 3. Spotlight overlay recipe
```js
const overlay = new St.Widget({reactive: true, x_expand: true, y_expand: true,
    layout_manager: new Clutter.BinLayout()});
overlay.add_constraint(new Clutter.BindConstraint({source: global.stage,
    coordinate: Clutter.BindCoordinate.ALL}));
const panel = new St.BoxLayout({style_class: 'guava-spotlight',
    orientation: Clutter.Orientation.VERTICAL,           // not `vertical` (removed in 51)
    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START});
const entry = new St.Entry({style_class: 'guava-spotlight-entry', can_focus: true,
    hint_text: _('Spotlight Search')});
panel.add_child(entry); overlay.add_child(panel);
Main.layoutManager.addTopChrome(overlay);                // above windows and panel
this._grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
entry.clutter_text.grab_key_focus();
entry.clutter_text.connect('text-changed', () => this._search(entry.get_text()));
entry.clutter_text.connect('activate', () => this._launchSelected());
overlay.connect('button-press-event', (a, ev) =>          // click outside closes it
    global.stage.get_event_actor(ev) === a ? (this._close(), Clutter.EVENT_STOP)
                                           : Clutter.EVENT_PROPAGATE);
// _close(): Main.popModal(this._grab); this._grab = null;
//           Main.layoutManager.removeChrome(overlay); overlay.destroy();
```
- `addTopChrome` keeps the overlay above popups. `addChrome` puts it below
  `global.top_window_group`.
- Blur behind the panel: put a `Shell.BlurEffect({mode: BACKGROUND})` on a
  sibling actor (blur-shaders-and-effects.md).
- Debounce searching with `GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, ...)`
  and keep the id so you can remove it.
- Escape: handle `key-press-event` on the overlay (`event.get_key_symbol() === Clutter.KEY_Escape`).
  On 50+ you can use `Clutter.KeyController` (`key-press` signal,
  `get_key()`) as runDialog.js does. Note: RunDialog uses
  `get_binding_pool().install_closure('close', Clutter.KEY_Escape, ...)` in a
  static block of its own class.

## 4. Key handling and focus
- `actor.grab_key_focus()` and `global.stage.get_key_focus()`. `St.Entry`
  forwards focus to `entry.clutter_text`.
- Arrow-key navigation: `global.focus_manager.add_group(actor)` and
  `actor.navigate_focus(from, St.DirectionType.DOWN, false)`.
- In 51, `St.Entry` supports COPY, CUT and PASTE action keys (NEWS 51.beta).
- Event helpers: `event.get_key_symbol()`, `event.get_state()` (modifier mask),
  `event.get_button()`, `event.get_coords()`, and
  `global.stage.get_event_actor(event)` for the source actor.

## 5. Search providers (overview search and your own Spotlight)
- In-process provider: an object with `id`, `appInfo` (Gio.AppInfo or null),
  `canLaunchSearch`, `isRemoteProvider = false`, and async
  `getInitialResultSet(terms, cancellable)`,
  `getSubsearchResultSet(prev, terms, cancellable)`,
  `getResultMetas(ids, cancellable)` (each meta is `{id, name, description, createIcon(size)}`),
  `filterResults(ids, max)`, `activateResult(id, terms)`, and optionally
  `launchSearch(terms)` and `createResultObject(meta)`. The shape is taken
  from the remoteSearch.js provider methods.
- Register with `Main.overview.searchController.addProvider(provider)` and
  remove in `disable()` with `removeProvider(provider)`
  (searchController.js).
- For Guava's own Spotlight UI you can *query* providers directly:
  `Shell.AppSystem.search(query)` (static; returns groups of desktop IDs.
  `appDisplay.js` `AppSearchProvider` calls `Shell.AppSystem.search(query)` on
  51) for apps, plus your own sources such as the
  clipboard history and settings panels.

## 6. Pointer tracking (events vs polling)
- `global.get_pointer()` returns `[x, y, mods]` synchronously. Polling it on a
  timer (Hide Top Bar uses timeouts plus it) wakes the CPU and drains battery.
  Avoid polling faster than about 10 Hz, and stop when not needed.
- Event-driven, preferred: `const tracker = global.backend.get_cursor_tracker();`
  `tracker.connect('position-invalidated', () => /* queue a later */)`. Coalesce
  with `global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, cb)`
  and read the position inside with `global.get_pointer()`. The signal exists
  in mutter 45 to 51. GNOME 51's magnifier switched to it, and
  `ui/pointerWatcher.js` (the old 10 Hz poller) was removed in 51.
- For edge reveal, a thin reactive chrome actor with `track_hover` and
  `enter-event` is cheapest but steals clicks on that strip. A pressure
  barrier is the macOS-like, non-intrusive option (next section).
  Guava's `(Kiwi: apps/panelHover.js; Guava equivalent not verified)` uses a 1px hover actor.

## 7. Meta.Barrier, PressureBarrier, hot corners
```js
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
const m = Main.layoutManager.primaryMonitor;
this._pressure = new Layout.PressureBarrier(100 /*px threshold*/, 1000 /*ms*/,
    Shell.ActionMode.NORMAL);
this._pressure.connect('trigger', () => this._revealPanel());
this._barrier = new Meta.Barrier({
    backend: global.backend,                  // 46+. 45 used display: global.display
    x1: m.x, x2: m.x + m.width, y1: m.y, y2: m.y,
    directions: Meta.BarrierDirection.POSITIVE_Y,   // blocks upward motion at the top edge
});
this._pressure.addBarrier(this._barrier);
// disable():
this._pressure.removeBarrier(this._barrier); this._barrier.destroy(); this._barrier = null;
this._pressure.destroy(); this._pressure = null;
```
- `PressureBarrier` (layout.js) is a JS `EventEmitter`. It sums the distance
  pushed across the barrier within `timeout` and emits `trigger` once until
  the pointer leaves. `setEventFilter(fn)` lets you ignore events, for example
  while a mouse button is held. Only events in the given action mode count.
- Barrier directions: `POSITIVE_X`, `POSITIVE_Y`, `NEGATIVE_X`, `NEGATIVE_Y`.
  A horizontal barrier has `y1 === y2`. Recreate barriers on
  `Main.layoutManager` `monitors-changed`.
- Hot corners: `Main.layoutManager.hotCorners[]` (`HotCorner`, built on a
  PressureBarrier), rebuilt on `hot-corners-changed`. Toggle with
  `org.gnome.desktop.interface enable-hot-corners`. Don't destroy them.
- On Wayland, barriers constrain pointer motion and tablets in relative
  mapping mode only; touch and absolute tablets pass through (mutter 51.0
  `meta-seat-impl.c` `constrain_coordinates`).

## 8. Sources
- https://gjs.guide/extensions/topics/session-modes.html (action modes context)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/windowManager.js (addKeybinding)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/main.js (pushModal, popModal)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/modalDialog.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/runDialog.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/layout.js (PressureBarrier, HotCorner)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/magnifier.js (position-invalidated)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/searchController.js
- https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/meta/prefs.h , .../barrier.h
- https://github.com/mlutfy/hidetopbar (PressureBarrier usage, Meta.Barrier display/backend switch for 45)
