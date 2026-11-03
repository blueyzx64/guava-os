# Windows, workspaces, window actors and clones (Stage Manager, window controls)

Summary: the Meta.Display, Meta.Window, Meta.Workspace and Meta.WindowActor objects, and the Shell.WindowTracker/App helpers for app names and icons.
It also covers live thumbnails with `Clutter.Clone`, animation with `ease()`, focus and activation, and minimize/maximize per version (49 changed them).
It ends with recipes for Stage Manager, window controls in the panel and titlebar button removal. Verified against mutter `src/meta/window.h` (48.0, 49.0, 50.0, main) and gnome-shell main (`windowPreview.js`, `windowManager.js`, `main.js`).

## Contents
1. Object map and globals
2. Enumerating and tracking windows
3. Window state: minimize, maximize, fullscreen, close, focus
4. Workspaces
5. Window actors, clones, thumbnails
6. Animations (ease, easeAsync, WM effects)
7. Stage Manager recipe
8. Window controls in the panel; removing titlebar buttons
9. Pitfalls
10. Sources

## 1. Object map and globals
| Global | What |
|---|---|
| `global.display` | `Meta.Display`: focus, windows, monitors, keybindings, selection. Signals: `window-created`, `notify::focus-window`, `restacked`, `in-fullscreen-changed`, `workareas-changed`, `window-entered-monitor`, `window-left-monitor`, `grab-op-begin`, `grab-op-end`. |
| `global.workspace_manager` | `Meta.WorkspaceManager`: `get_active_workspace()`, `get_workspace_by_index(i)`, `n_workspaces`. Signals: `active-workspace-changed`, `workspace-added`, `workspace-removed`. |
| `global.window_manager` | `Shell.WM`: effect signals `minimize`, `unminimize`, `map`, `destroy`, `size-change`, `switch-workspace` (consumed by `Main.wm`). |
| `global.get_window_actors()` | All `Meta.WindowActor`s in stacking order. |
| `global.window_group` / `global.top_window_group` | Parent actors of window actors. |
| `global.backend`, `global.compositor` | Cursor tracker, monitor manager, `get_laters()`, `disable_unredirect()`. |
| `Shell.WindowTracker.get_default()` | `get_window_app(win)` returns a `Shell.App` (`get_name()`, `get_id()`, `create_icon_texture(size)`, `get_windows()`, `activate()`). |
| `Shell.AppSystem.get_default()` | `lookup_app(id)`, `get_running()`. |

## 2. Enumerating and tracking windows
```js
const ws = global.workspace_manager.get_active_workspace();
const wins = global.display.sort_windows_by_stacking(ws.list_windows())   // bottom → top
    .filter(w => w.get_window_type() === Meta.WindowType.NORMAL && !w.skip_taskbar);
// Alternative: global.display.get_tab_list(Meta.TabList.NORMAL, ws) (MRU order)
global.display.connectObject('window-created', (_d, win) => this._track(win), this);
// _track(win):
win.connectObject(
    'notify::minimized', () => this._sync(),
    'notify::maximized-horizontally', () => this._sync(),
    'notify::fullscreen', () => this._sync(),
    'workspace-changed', () => this._sync(),
    'position-changed', () => this._sync(),   // fires per frame while moving: throttle
    'size-changed', () => this._sync(),
    'unmanaging', () => this._untrack(win),
    this);
```
- `window-created` fires before the actor is ready. To get the actor, wait for
  `win.get_compositor_private()`, using the actor's `first-frame` signal or
  `Meta.LaterType.BEFORE_REDRAW` via `global.compositor.get_laters().add(...)`.
- Useful properties: `title`, `wm_class` (`get_wm_class()`),
  `get_gtk_application_id()`, `get_pid()`, `get_frame_rect()` (visible frame),
  `get_buffer_rect()` (includes client-side shadows),
  `get_client_type()` (`Meta.WindowClientType.WAYLAND` or `X11` for Xwayland),
  `is_on_all_workspaces()`, `get_monitor()`, `showing_on_its_workspace()`.

## 3. Window state
| Action | 48 | 49, 50, 51 |
|---|---|---|
| maximize | `win.maximize(Meta.MaximizeFlags.BOTH)` | `win.maximize()` |
| unmaximize | `win.unmaximize(Meta.MaximizeFlags.BOTH)` | `win.unmaximize()` |
| is maximized | `win.get_maximized() === Meta.MaximizeFlags.BOTH` | `win.is_maximized()` |
| one axis | flags argument | `win.set_maximize_flags(Meta.MaximizeFlags.VERTICAL)`, `set_unmaximize_flags()`, `get_maximize_flags()` |
| any version | `win.maximized_horizontally && win.maximized_vertically` (properties exist on 48 to 51; Guava's `isMaximized()` uses them) | |

The table is verified by diffing window.h between 48.0 and 49.0. Passing flags
on 49+ or calling `get_maximized()` is an EGO error (EGO-C49-003, EGO-C49-004).
Reuse `maximizeWindow()`, `unmaximizeWindow()` and `isMaximized()` from
`(Kiwi: apps/windowTiling.js; Guava equivalent not verified)`.

Other operations (unchanged from 48 to 51):
- `win.minimize()`, `win.unminimize()`
- `win.make_fullscreen()`, `win.unmake_fullscreen()`
- `win.delete(global.get_current_time())` asks the window to close, which is
  what the close button does
- `win.kill()`
- `win.activate(time)` or `Main.activateWindow(win)`, which also switches
  workspace and hides the overview
- `win.raise()`, `win.move_frame(userOp, x, y)`,
  `win.move_resize_frame(userOp, x, y, w, h)`
- `win.change_workspace(ws)` or `change_workspace_by_index(i, false)`
- `win.can_maximize()`, `can_minimize()`, `can_close()`, `allows_resize()`
  (false while maximized or fullscreen; see `canTile` in windowTiling.js)

New in 50: `get_min_size()`, `get_max_size()`, `inhibit_mapped()` and
`uninhibit_mapped()` (hide a window from mapping without minimizing it),
`add_external_constraint()`. Removed in 51: `get_gtk_theme_variant()`.

Focus: `global.display.focus_window` and `notify::focus-window`;
`global.display.focus_default_window(time)`.

## 4. Workspaces
- `ws.index()`, `ws.list_windows()`, `ws.activate(time)`,
  `ws.activate_with_focus(win, time)`, `ws.get_work_area_for_monitor(i)`.
- Guava's `(Kiwi: apps/moveFullscreenWindow.js; Guava equivalent not verified)` already creates and removes workspaces
  for fullscreen apps. Reuse its helpers.
- Dynamic workspaces: setting `org.gnome.mutter dynamic-workspaces`. The Shell
  keeps an empty last workspace.

## 5. Window actors, clones, thumbnails
```js
const actor = win.get_compositor_private();           // Meta.WindowActor
const clone = new Clutter.Clone({source: actor, reactive: false});
const [w, h] = actor.get_size();
const scale = Math.min(THUMB_W / w, THUMB_H / h);
clone.set_size(w * scale, h * scale);   // a clone scales its source's paint to its own size
container.add_child(clone);
// on source destroy the clone's source becomes null. Listen to actor 'destroy' and drop the clone.
```
- A clone is live (it repaints with the source) and costs one extra paint of
  the source texture. Fine for about 10 thumbnails. For heavy cases, freeze
  with `actor.paint_to_content(clip)` (it exists in mutter main
  `meta-window-actor.h`) or lower the update
  frequency.

  Other WindowActor API: `get_meta_window()`, `get_texture()`, `freeze()`/`thaw()`,
  and the signals `first-frame`, `effects-completed`, `damaged` and `thawed`.
- The window actor's size includes client-side shadows (the buffer rect). Crop
  to the frame rect for clean thumbnails. Compute the offsets from
  `win.get_frame_rect()` minus `win.get_buffer_rect()`.
- To hide a real window but keep its clone painting, set `actor.opacity = 0`
  rather than hiding the actor. A hidden source may stop painting, which makes
  the clone blank. Restore the opacity in `disable()`.
- The Shell's own previews (`windowPreview.js`) use
  `layout_manager.add_window(metaWindow)` (WindowPreviewLayout), which builds
  clones for attached dialogs too, and `Shell.util_set_hidden_from_pick(clone, true)`.
- **49+ input:** use `Clutter.ClickGesture` and `Clutter.LongPressGesture`
  (`recognize` signal) through `actor.add_action(gesture)`. `Clutter.ClickAction`
  and `TapAction` were removed in 49.

## 6. Animations
- `actor.ease({x, y, scale_x, opacity, duration: 250,
  mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete, onStopped})` is a
  Shell override in environment.js. It respects the animation settings and the
  slow-down factor.
- `await actor.easeAsync({...})` (50+) resolves at completion and rejects if
  the animation is stopped. On 48 and 49, wrap `ease` in a Promise via
  `onComplete`/`onStopped`.
- Remove transitions on disable with `actor.remove_all_transitions()`.
- Respect user settings: `St.Settings.get().enable_animations`. On 51, also
  check `St.Settings.get().reduced_motion`, which is an enum and not a
  boolean (`st-settings.c` main: `g_param_spec_enum ("reduced-motion")`).
- To customize the minimize animation, override
  `Main.wm._minimizeWindow`/`_unminimizeWindow` with InjectionManager. Guava's
  `(Kiwi: apps/minimizedToDock.js; Guava equivalent not verified)` does this, so study it first.

## 7. Stage Manager recipe (outline)
1. Track the active workspace's normal windows (section 2) and an MRU set of
   "stages", grouped by `Shell.App`.
2. Left strip: chrome actor (`Main.layoutManager.addChrome(strip)`. Do not pass
   `affectsInputRegion`: it throws on 50+, see layout-chrome-and-panel-hiding.md),
   one `Clutter.Clone` per inactive group, scaled into cards with a small
   perspective (`rotation_angle_y`, `pivot_point`).
3. Clicking a card unminimizes or raises the group's windows with
   `Main.activateWindow`, then minimizes (or `inhibit_mapped()` on 50+) the
   previous group. Animate the clone from card to the window rect with
   `ease()`, then swap in the real actor.
4. Keep the work area honest. Either reserve a strut (`affectsStruts: true`,
   so maximized windows avoid the strip), or move and resize windows
   yourself. Pick one.
5. `disable()`: unminimize everything you minimized, restore opacity and
   positions, destroy clones before the strip, disconnect window and display
   signals.

## 8. Window controls in the panel; removing titlebar buttons
- Panel controls: a `PanelMenu.Button` with `dontCreateMenu = true` holding
  three `St.Button`s that act on `global.display.focus_window`. Show them only
  when that window `is_maximized()` (or the 48 equivalent). Guava already has
  `features/appButtons/index.js`, which parses `org.gnome.desktop.wm.preferences button-layout`.
- Titlebar buttons (server- and client-side): the button order and set come
  from `gsettings set org.gnome.desktop.wm.preferences button-layout 'appmenu:'`.
  An empty side means no buttons. GTK 3/4 and libadwaita honour it. Changing
  user gsettings from an extension needs a pref the user opts into, and the
  original value must be restored on disable.
- GTK CSS override: write `@import` lines into `~/.config/gtk-{3,4}.0/gtk.css`
  (Guava: `features/appButtons/gtkTheme.js` keeps a managed block, and
  `css/hide-titlebar4.css` targets `windowcontrols`). This affects apps only
  after they restart. It has no effect on Qt or Electron apps that draw their
  own titlebars (unverified for each toolkit: no upstream doc covers
  Chromium's GTK-theme frame mode).

## 9. Pitfalls
- Never keep a `Meta.Window` after `unmanaged`. Calling methods on it logs
  criticals.
- `position-changed` and `size-changed` can fire per frame. Coalesce with
  `GLib.idle_add` or laters.
- Don't animate real window actors during `grab-op` (user drag/resize). Guava's
  `transparentMove.js` shows how to detect it.
- Xwayland windows still exist on 50+ even though the X11 *session* is gone.
  Don't assume `get_client_type() === WAYLAND`.

## 10. Sources
- https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/meta/window.h (diffed against tags 48.0, 49.0, 50.0)
- https://gjs.guide/extensions/upgrading/gnome-shell-49.html#meta-window
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/windowPreview.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/windowManager.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/main.js (activateWindow)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/environment.js (ease, easeAsync)
- https://gjs-docs.gnome.org/meta17~17/ (API reference; suffix = mutter API version, 17 = GNOME 49, the newest on gjs-docs per its docs.json; 50 = 18, 51 = 51)
