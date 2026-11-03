---
name: mutter-windows
description: Meta.Window, Meta.Display, WorkspaceManager and Shell.WM on Mutter/GNOME Shell 50 for Guava OS. Use for maximize/unmaximize/fullscreen/tiling/above, frame vs buffer rect, window actors and clones, minimize/unminimize/map/destroy/size-change effects (Genie, Scale), completed_minimize, icon geometry, kill-window-effects, grab ops (drag-to-tile), workspaces (dynamic vs static, num-workspaces), Xwayland vs Wayland windows, edge-tiling, window-created/shown/first-frame timing. Files: features/minimizeEffect, features/windows, features/splitView, features/stageManager, features/missionControl, features/fullscreenSpace, core/desktop.js, lib/compat.js.
---

# Windows on Mutter 50 (libmutter-18)

Verified by introspecting `Meta-18`/`Shell-18` typelibs in the Fedora 44 root (full dump:
`/home/user/.swarm/guava-os/agents/R1/introspect-50.txt`) and reading Shell 50.6 JS
(`/home/user/.swarm/guava-os/refs/gnome-shell-50.6-js/org/gnome/shell/`, paths below relative).

## 1. Meta.Window API that changed (49/50)

| Want | Mutter 50 | Gone |
|---|---|---|
| maximize both | `win.maximize()` (0 args) | `maximize(Meta.MaximizeFlags.BOTH)` |
| maximize one axis | `win.set_maximize_flags(Meta.MaximizeFlags.VERTICAL)`; undo `set_unmaximize_flags(f)` | flags on maximize |
| query | `is_maximized()` (both), `get_maximize_flags()`, props `maximized-horizontally/-vertically` | `get_maximized()` |
| rect | `Mtk.Rectangle` | `Meta.Rectangle` |
| interactive move | `begin_grab_op(Meta.GrabOp.KEYBOARD_MOVING, sprite, time, null)`, sprite from `global.stage.get_context().get_backend().get_sprite(global.stage, event)` (`ui/windowMenu.js:58-67`) | old 9-arg display grab |

Guava wraps these in `lib/compat.js:26-51` (`maximizeWindow`, `unmaximizeWindow`, `isMaximized`).
Tiling Shell still feature-tests `window.get_maximized` to pick the flags form
(`refs/tilingshell/src/utils/gnomesupport.ts:38-48`): on 50 that resolves to the no-arg call.
Note `tools/harness/inner-real.sh` maximize probe also branches on `maximize.length`.

Other useful 50 methods: `move_resize_frame(user_op, x, y, w, h)`, `move_frame`,
`move_to_monitor(i)`, `make_above/unmake_above/is_above`, `make_fullscreen/unmake_fullscreen`,
`is_monitor_sized()`, `get_frame_rect()` (visible frame, no CSD shadow) vs `get_buffer_rect()`
(the client buffer incl. shadow; the actor's x/y follow this), `get_work_area_current_monitor()`,
`get_client_type()` (`Meta.WindowClientType.WAYLAND`=0 / `X11`=1), `get_sandboxed_app_id()`,
`get_icon_geometry()` / `set_icon_geometry(Mtk.Rectangle)`, `add_external_constraint`,
`inhibit_mapped/uninhibit_mapped`, `set_type`, `hide_from_window_list`.

Signals: Window `workspace-changed focus raised unmanaging unmanaged position-changed shown
size-changed highest-scale-monitor-changed configure`. WindowActor `first-frame
effects-completed damaged thawed`. Display `window-created grab-op-begin grab-op-end
restacked workareas-changed in-fullscreen-changed window-entered-monitor focus-window
showing-desktop-changed`. WorkspaceManager `workspace-added/-removed/-switched
workspaces-reordered active-workspace-changed`.

## 2. Window lifetime, in order

`display::window-created` (no actor content yet, size may be 0) → actor exists
(`win.get_compositor_private()`) → `WindowActor::first-frame` → `Window::shown` → Shell.WM `map`.
Hook geometry/effects on `shown` or `first-frame`, not `window-created`
(`features/roundedCorners/index.js:100`). `actor.get_texture()` is null before the first frame;
the Shell skips effects then (`ui/windowManager.js:1150`).

## 3. Shell.WM effects protocol (minimize, map, destroy, size-change)

`global.window_manager` signals: `minimize unminimize map destroy size-change size-changed
switch-workspace kill-window-effects kill-switch-workspace show-tile-preview ...`.
Rules (from `ui/windowManager.js`):
- Every `minimize`/`unminimize`/`map`/`destroy`/`size-change` **must** end in exactly one
  `shellwm.completed_<x>(actor)`, or Mutter's accounting stalls (window stays half-minimized).
- `kill-window-effects` (`:517-522`) means "finish now": jump to the end state and complete.
- Stock minimize (`:1156-1222`): scale + opacity to `get_icon_geometry()` (falls back to the
  monitor corner), `is_monitor_sized()` windows only fade. Restore uses `get_buffer_rect()` as
  the destination (`:1265-1266`). On done it resets scale 1, opacity 255, pivot (0,0).
- `_shouldAnimateActor` (`:1142`) refuses when the overview is open, during a workspace gesture,
  for actors in `_skippedActors` (`Main.wm.skipNextEffect(actor)`, `:1097`), or without texture.
- `_prepareAnimationInfo(shellwm, actor, oldFrameRect, change)` (`:1306`) gives the stock
  size-change crossfade; Tiling Shell calls it before `move_resize_frame` to animate snaps
  (`refs/tilingshell/src/components/tilingsystem/tilingManager.ts:1074-1093`). Private.

Guava (`features/minimizeEffect/index.js`): blocks only the oldest (stock) `minimize`/
`unminimize` handler (`:61-73`), plays Genie/Scale/fade, hands other windows to
`Main.wm._minimizeWindow/_unminimizeWindow` (`:136-142`), one `finish()` per actor
(`_track`, `:161-176`) also run by `kill-window-effects` and disable (`:76-81`).
Genie draws a `Clutter.Clone` of the window inside a container sized to window+target, with an
OffscreenEffect on the container (`genie.js:8-11`, `index.js:215-257`), because a deform on the
window actor gets culled at its paint volume.
Compiz Magic Lamp instead puts a `Clutter.DeformEffect` on the window actor and returns `false`
from `vfunc_modify_paint_volume` (no paint volume → whole-stage redraw, no culling) plus
`actor.get_parent().queue_redraw()` per frame (`refs/compiz-alike-magic-lamp-effect/extension.js:440-447`).
It also no-ops `Main.wm._shellwm.completed_minimize` (`:59-67`): with it installed, Guava's
completion calls go nowhere — Genie must be off (README says so).

## 4. Icon geometry (where minimize goes)

Docks publish `win.set_icon_geometry(rect)` per window from the icon's
`get_transformed_position/size`, updated on `notify::position/size` of the icon
(`refs/dash-to-dock/appIcons.js:418-437`, `dash.js:593-594`). Guava's dock does it in a
`BEFORE_REDRAW` later (`features/dock/index.js:373-386`) and also answers
`minimizeTarget(win)` directly. A target read during magnification is wrong: read it before the
icon scales or from the layout, not the transformed actor.

## 5. Drag, grab ops, tiling

- `display::grab-op-begin (display, window, op)` / `grab-op-end`; moves are `Meta.GrabOp.MOVING`
  or `MOVING_UNCONSTRAINED`, keyboard `KEYBOARD_MOVING`; resizes `RESIZING_*`.
- During a move, `window::position-changed` fires per motion; keep the handler allocation-free.
- Mutter's own snapping is `org.gnome.mutter edge-tiling`; Guava owns it through `SettingOwner`
  while window-tiling runs (`features/windows/index.js:64-65`). The tile preview is the WM
  signal `show-tile-preview` (`ui/windowManager.js:525`).
- Snapping a maximized window: unmaximize first, then `move_resize_frame(true, ...)`; the
  size arrives asynchronously (watch `size-changed`), Wayland clients may refuse sizes.
  Tiling Shell restores the pre-tile size on drag-out using the pointer offset ratio
  (`tilingManager.ts:725-735`).

## 6. Workspaces

- Dynamic: `org.gnome.mutter dynamic-workspaces` (Shell keeps one empty at the end). Static:
  that key false + `org.gnome.desktop.wm.preferences num-workspaces`. Guava's Mission Control
  owns both through `SettingOwner` (`features/missionControl/index.js:360-366`).
- API: `global.workspace_manager.get_n_workspaces/get_active_workspace/append_new_workspace(false, t)
  /remove_workspace(ws, t)/reorder_workspace(ws, i)`; `win.change_workspace(ws)`,
  `ws.activate_with_focus(win, t)`. `workspace_manager.override_workspace_layout(...)`.
- Removing a workspace with windows moves them; do it after moving them yourself.

## 7. Wayland vs Xwayland

- GNOME 50 has no X11 session. X11 apps run via Xwayland (started on demand); the harness runs
  `--no-x11` (no Xwayland, `x11:false` in the 2026-11-03 spike).
- X11 id only for X11 clients: `lib/compat.js:40-46` `x11WindowId`. DBusMenu app menus need it.
- Wayland clients position themselves only through the compositor: `move_frame` works for
  both; clients can't read global coordinates.
- `get_buffer_rect()` ≠ `get_frame_rect()` for CSD (GTK4/libadwaita shadows ~ 20–60 px each
  side) — use frame rect for layout, buffer rect for actor/clone placement.

## 8. Pitfalls

- `win.get_monitor()` is -1 while unmanaging; `Main.layoutManager.monitors[-1]` is undefined.
- `actor.meta_window` is null after `unmanaged`; hold the Meta.Window, not the actor.
- `is_monitor_sized()` windows (full screen games) take the fade path in stock and Guava.
- Opacity 0 on a window actor keeps it pickable; also call `Shell.util_set_hidden_from_pick(actor, true)`
  (`features/stageManager/windows.js:47`).
- A `Clutter.Clone` of a window actor paints with the clone's opacity (source opacity is
  overridden during clone paint), so `actor.opacity = 0` + clone works (Genie relies on it).
- Window-type filter: animate `NORMAL`, `DIALOG`, `MODAL_DIALOG`; Wayland transients have no
  DIALOG type, the Shell treats `get_transient_for() != null` as dialogs (`:1130-1135`).
