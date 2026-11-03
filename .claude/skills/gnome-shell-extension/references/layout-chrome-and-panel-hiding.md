# Layout, chrome, struts, fullscreen and auto-hiding the top bar

Summary: how `Main.layoutManager` places Shell UI ("chrome") above or below windows, how struts reserve work area, and how `trackFullscreen` hides chrome over fullscreen windows.
It then gives a safe design for a macOS-style auto-hide top bar that reveals on cursor proximity, based on the Shell source and the "Hide Top Bar" extension.
Verified against `js/ui/layout.js` and `js/misc/params.js` on gnome-shell 48.0, 49.0, 50.0 and main (51), and mlutfy/hidetopbar `panelVisibilityManager.js` (master).

## Contents
1. LayoutManager essentials
2. addChrome / addTopChrome / trackChrome parameters (version note!)
3. Struts and work areas
4. Fullscreen behaviour
5. Auto-hide top bar: design
6. Reference implementation sketch
7. Interactions with other features
8. Sources

## 1. LayoutManager essentials
- `Main.layoutManager.uiGroup` is the root of all Shell UI.
  `global.window_group` (windows) and `global.top_window_group` (override-redirect
  popups) live inside it.
- Named containers: `panelBox` (holds `Main.panel`), `modalDialogGroup`,
  `keyboardBox`, `screenShieldGroup`, `overviewGroup`.
- Monitors: `monitors`, `primaryMonitor` (`{index, x, y, width, height, geometryScale, inFullscreen}`),
  `primaryIndex`, `getWorkAreaForMonitor(i)`, `findMonitorForActor(actor)`,
  `findIndexForActor(actor)`.
- Signals: `monitors-changed`, `hot-corners-changed`, `startup-prepared`,
  `startup-complete`, `system-modal-opened`.
- `Main.layoutManager._startingUp` is true until startup completes. Do
  geometry work after `startup-complete` if you enable during login.

## 2. Chrome parameters (version note)
| Call | Effect |
|---|---|
| `addChrome(actor, params)` | Adds to `uiGroup` **below** `global.top_window_group` (so above normal windows, below popups) and tracks it. |
| `addTopChrome(actor, params)` | Adds to `uiGroup` above everything, including popups. |
| `trackChrome(actor, params)` | Tracks an actor that is already a descendant of chrome (inherits the ancestor's params). Example: MessageTray tracks `_bannerBin`. |
| `untrackChrome(actor)`, `removeChrome(actor)` | Undo. `removeChrome` also removes the actor from `uiGroup`. |

Params:
- `trackFullscreen` (default false): the actor is hidden while its monitor has
  a fullscreen window.
- `affectsStruts` (default false): its rect reserves a strut on the edge it
  touches.
- `affectsInputRegion` (default true) **exists only up to 49**. It was
  removed in 50 with the X11 code. Because `Params.parse()` throws
  `Unrecognized parameter`, passing it on 50+ throws. Guava targets 48 to 51,
  so never pass it. On 48 and 49 the default (true) is what you want anyway.

Tracking is keyed by actor identity: `_trackActor` throws
`'trying to re-track existing chrome actor'` if you track the same actor twice.

## 3. Struts and work areas
- `_updateRegions()` turns every `affectsStruts` actor's transformed rect into
  a `Meta.Strut` on the edge it touches, applies it to every workspace with
  `set_builtin_struts`, and recomputes it on `notify::allocation` and
  `notify::visible`.
- Consequence: **moving the panel (y or translation) can change or remove the
  strut**, which makes maximized windows jump. That's why auto-hide must first
  turn the panel's `affectsStruts` off, or else keep the strut deliberately so
  windows never move under the panel.
- `panelBox` itself is added with `{affectsStruts: true, trackFullscreen: true}`.
  Changing that means `removeChrome(panelBox)` then `addChrome(panelBox, {...})`.
  Hide Top Bar does exactly this. The actor is re-added at the
  below-top-window-group position, which is where it was before.
- Work area change signal: `global.display` `workareas-changed`.

## 4. Fullscreen behaviour
- `trackFullscreen` hides the actor (`visible = false`) while
  `monitor.inFullscreen` is set. `global.display` emits `in-fullscreen-changed`.
- The stock panel disappears over fullscreen apps for this reason. Guava's
  `(Kiwi: apps/panelHover.js; Guava equivalent not verified)` overrides this to reveal on hover. Read it before
  touching panelBox visibility, because both features must agree.
- MessageTray suppresses non-critical banners on a fullscreen primary monitor.

## 5. Auto-hide top bar: design (macOS-like)
Requirements: the panel slides up when not needed and slides in when the
pointer reaches the top edge, or when the overview, a panel menu or a modal is
open. Windows should not resize when it hides.

Decisions:
1. **Strut.** Re-add `panelBox` with `{affectsStruts: false, trackFullscreen: true}`
   so maximized windows use the full height ("Hide Top Bar" default), and
   restore `{affectsStruts: true, trackFullscreen: true}` in `disable()`.
   Hide Top Bar sets `affectsStruts: Main.sessionMode.currentMode !== 'unlock-dialog'`
   when it restores.
2. **Motion.** Animate `panelBox.translation_y` (or `y`) with `ease()`, using
   `-panelBox.height` to hide. Call `panelBox.remove_all_transitions()` before
   each new ease. After the hide completes you can `panelBox.hide()` to save
   paints (Hide Top Bar does this unless rounded corners must stay).
3. **Reveal trigger.** Choose one:
   - **Pressure barrier** at `y = monitor.y` (`Layout.PressureBarrier` +
     `Meta.Barrier({backend: global.backend, directions: POSITIVE_Y})`). This
     needs a deliberate push, so there are no accidental reveals, and it does
     not steal clicks. Hide Top Bar does this.
   - **Hover strip**: a 1 to 2 px reactive `St.Widget` added with `addTopChrome`
     and `track_hover`, using `notify::hover`. It is simple, but it eats clicks
     at the very top (Guava `panelHover.js` uses `TRIGGER_EDGE_PX = 1`).
   - **Polling `global.get_pointer()`** only while revealed, to detect leaving.
     Better: rely on `panelBox` `notify::hover` (set `track_hover: true`) plus
     a hide delay timeout. Prefer events: cursor tracker `position-invalidated`
     (see input-keybindings-and-modals.md §6).
4. **Keep revealed while:**
   - `Main.overview` is visible (`showing`/`hiding` signals)
   - any panel menu is open (`Main.panel.menuManager.activeMenu`, or iterate
     `Main.panel.statusArea[*].menu.isOpen` as panelHover.js does)
   - a modal is open (`Main.modalCount > 0`)
   - the keyboard focus is in the panel
5. **Banner offset.** The MessageTray banner is positioned relative to the
   panel, so with struts off it may overlap. Hide Top Bar wraps
   `Main.messageTray._bannerBin.ease` to add `PanelBox.height` to `y` when
   the panel is shown.
6. **Fullscreen.** Decide whether the barrier reveals over fullscreen windows.
   Hide Top Bar checks `primaryMonitor.inFullscreen` against a setting. While
   revealed over fullscreen, call `global.compositor.disable_unredirect()` and
   re-enable it when hidden (pair them exactly).
7. **Multi-monitor and geometry.** Rebuild the barrier on `monitors-changed`
   and on panelBox `notify::allocation` (the height changes with scale).
8. **Intellihide (optional).** Hide only when a window overlaps the panel
   rect. Recompute on `global.display` `restacked`, the focus window's
   `position-changed` and `size-changed` (throttled), and
   `workspace_manager` `active-workspace-changed`.

## 6. Reference implementation sketch
```js
export function enable(settings) {
    const box = Main.layoutManager.panelBox;
    Main.layoutManager.removeChrome(box);
    Main.layoutManager.addChrome(box, {affectsStruts: false, trackFullscreen: true});
    box.track_hover = true; box.reactive = true;
    box.connectObject('notify::hover', _queueHideIfAway, OWNER);
    Main.overview.connectObject('showing', _reveal, 'hidden', _queueHideIfAway, OWNER);
    Main.layoutManager.connectObject('monitors-changed', _rebuildBarrier, OWNER);
    _rebuildBarrier();
    _hide(false);
}
export function disable() {
    _destroyBarrier(); _cancelHideTimeout();
    const box = Main.layoutManager.panelBox;
    box.remove_all_transitions(); box.translation_y = 0; box.show();
    box.disconnectObject(OWNER); Main.overview.disconnectObject(OWNER);
    Main.layoutManager.disconnectObject(OWNER);
    Main.layoutManager.removeChrome(box);
    Main.layoutManager.addChrome(box, {affectsStruts: true, trackFullscreen: true});
}
```
`OWNER` is a module-level `{}`. Set `track_hover`/`reactive` back to their
previous values in `disable()` if you changed them.

## 7. Interactions with other Guava features
- `(Kiwi: apps/panelHover.js; Guava equivalent not verified)` (fullscreen reveal), `(Kiwi: apps/panelTransparency.js; Guava equivalent not verified)` (inserts
  a blur group at index 0 of panelBox) and `(Kiwi: apps/hideActivitiesButton.js; Guava equivalent not verified)` all
  touch the panel. Auto-hide must compose with them. One owner per panelBox
  property is a good rule (see the clean-architecture skill).
- The notification "notch" lives in the panel centre. If the panel is hidden,
  either reveal it when a notification arrives, or put the notch in its own
  `addTopChrome` actor.

## 8. Sources
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/layout.js (compare tags 49.0 and 50.0 for `defaultParams`)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/misc/params.js
- https://github.com/mlutfy/hidetopbar/blob/master/panelVisibilityManager.js
- https://gjs.guide/extensions/upgrading/gnome-shell-50.html (X11 removal)
