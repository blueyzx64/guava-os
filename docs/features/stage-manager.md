# Stage Manager

Registry ids `stage-manager` (key `stage-manager`, **off by default**) and `stage-manager-shortcut`.
This page is the behavioural spec. Every rule has a number (SM-n); unit tests, the fuzz test and
the harness scenarios (`tools/scenarios/stage-manager-*.sh`) cite them. A rule marked (guess) is
our adaptation or a guess about macOS Sonoma/Sequoia; the rest follows macOS.

## Vocabulary
- **Set**: the windows shown and hidden together. With `stage-manager-group-by-app` (default) a set
  is all the windows of one app; otherwise one window. A set the user built (Shift-click) holds
  several apps.
- **Stage**: the set in the centre, visible. At most one per workspace.
- **Strip**: the recent sets, as thumbnails on the left (or right, `stage-manager-side`) edge of the
  primary monitor. Most recent first, at most 6 shown.
- **Hidden set**: a set that is not the stage. Its windows are invisible and click-through but
  keep running, so the thumbnails stay live (SM-30).

## Sets and the stage
- **SM-1** Windows of the focused set are visible; every other managed window is hidden. The stage
  never holds two sets unless the user joined them (SM-5).
- **SM-2** Focusing a window of another set by any means (dock, switcher, Mission Control, a click
  on its thumbnail, a keyboard shortcut) makes that set the stage. The old stage goes to the front
  of the strip. Nothing else changes order.
- **SM-3** A new window of the app on the stage joins that set. A new window of another app takes
  the stage alone and the old set goes to the strip (setting `stage-manager-new-windows`: `join`
  adds it to the stage set instead). Dialogs and other transient windows follow their parent.
- **SM-4** Closing a window of the stage set removes it; the set stays while it has windows. When
  the last window of the stage closes, the most recent strip set takes the stage **at once**: no
  grace period (D-017). A window that opens right after takes the stage in its turn, the old
  set going back to the strip. (guess: macOS leaves the stage empty.) Closing a window of a hidden set removes it from its thumbnail;
  an empty set disappears.
- **SM-5** Shift-click on a thumbnail adds that set to the stage as one set. Dropping a thumbnail
  on the stage is the same (SM-34).
- **SM-6** The strip shows the most recent sets, at most 6. Older sets stay hidden and come back
  into the strip as it frees; they are reachable from the dock, switcher and Mission Control.
- **SM-7** A window that is not managed is never hidden: sticky (on all workspaces), always-on-top,
  skip-taskbar, picture-in-picture, Quick Look, windows on other monitors, windows another feature
  set aside (`hidden`, `splitView` flags) and orphan dialogs.

## Minimize
- **SM-8** Minimize (panel button, window button, Super+H, the app's own request, the menu) is
  Mutter's normal minimize. The window goes to the Dock (Genie), **not** to the strip. It leaves
  its set. Stage Manager never prevents or reverses a minimize.
- **SM-9** If the minimized window was the last of the stage set, SM-4 applies (the most recent
  strip set takes the stage at once). A minimized window of a hidden set leaves that thumbnail.
- **SM-10** Restoring a window from the Dock makes it the stage (SM-2): it becomes a set of its
  app (joining the app's other windows).
- **SM-11** Windows the user minimized before Stage Manager started, and after it stops, stay
  minimized. Stage Manager itself never minimizes a window.

## Maximize, zoom, full screen
- **SM-12** Maximize (green button, Super+Up, title double-click) is Mutter's normal maximize. The
  window stays in its set on the stage and covers the whole work area, including the strip area.
  Unmaximize restores the old frame. A maximize never splits the set (guess).
- **SM-13** A stage window that overlaps the strip area hides the strip (SM-16). Hidden sets stay
  hidden.
- **SM-14** A full-screen window covers the monitor: the strip is hidden and cannot be revealed,
  and the sets behind it stay hidden. Leaving full screen returns the strip.
  (The separate "full screen in its own Space" feature is paused while Stage Manager runs.)

## The strip
- **SM-15** The strip is visible when `stage-manager-show-recent` is on and no stage window
  overlaps its area (SM-13). With show-recent off it appears only on reveal (SM-17).
- **SM-16** `stage-manager-autohide` on: a stage window overlapping the strip area slides the strip
  off the edge (220 ms, `ctx.motion`); when the overlap ends it slides back. Off: the strip stays.
- **SM-17** Reveal by pointer: the pointer rests on the 2 px hover strip at the screen edge (within
  the strip's vertical band) for 150 ms, or pushes the edge (a pressure barrier: 40 px within
  600 ms, not while a button is held, so window drags still tile). The strip slides in over the
  windows. It never reveals while a window is full screen (the chrome is hidden then).
- **SM-18** It slides out again when the pointer has been out of the strip (strip width + 24 px)
  for 500 ms and SM-13 still holds. Reveal and hide reverse mid-slide from the current position
  (interruptible); no jump, no flicker.
- **SM-19** Keyboard reveal: the cycle and slot shortcuts (Super+Alt+PageUp/PageDown/1..6) reveal
  the strip for 1.5 s. Thumbnails are focusable; Enter activates (accessibility).
- **SM-20** Thumbnails are live clones of the window actors drawn from the full buffer (never a
  cached low-resolution texture), tilted by `stage-manager-tilt` degrees, stacked for sets of
  several windows, with the app icon badge. Rounded corners follow `rounded-corners`.

## Switching
- **SM-21** Click on a thumbnail swaps: the thumbnail's windows fly from their slot to their stage
  place, the old stage windows fly to the thumbnail slot, 360 ms (scaled by
  `stage-manager-animation-speed`), one motion per actor, no jump, no reversal, no flicker.
  The focus goes to the lead window of the set.
- **SM-22** A swap is interruptible: a second click mid-swap retargets every flight from its current
  pose to the new destination; nothing snaps and the end state is the same as if the clicks had
  come one after the other.
- **SM-23** With animations off or reduced motion the swap is instant (`core/motionModel.js`).
- **SM-24** Super+Alt+PageDown / PageUp cycle to the next / previous set; Super+Alt+1..6 pick a
  strip slot. The remove shortcut takes the focused window out of its set into its own set.
- **SM-25** Dragging a stage window by its title and dropping it on the strip, between thumbnails,
  sends it to the strip as its own set. Dropping it on a thumbnail moves it to that set (SM-34).
  The window goes back to where it was picked up. A resize or a drop elsewhere does nothing here.
- **SM-26** Wallpaper click (`stage-manager-wallpaper-click`) = Show Desktop (SM-31).

## Workspaces and monitors
- **SM-27** Each workspace has its own stage and strip; the sets are per workspace. A window moved
  to another workspace joins that workspace's sets, in its strip when the workspace has a stage.
  Switching workspace redraws the strip for that workspace and the strip **slides** in from its
  edge, 220 ms, like the workspace does (D-017); a hidden strip stays hidden. The windows of the
  workspaces change without a Stage Manager animation: the workspace switch itself moves them.
- **SM-28** Only the primary monitor has a strip. Windows on other monitors are never hidden (guess:
  macOS has a strip per display).

## Drag and drop
- **SM-34** Pointer drag, as macOS. Every drag is interruptible and shows its response at once.
  - *Thumbnail onto the stage*: press a thumbnail and move 8 px; a copy of its lead window follows the
    pointer (the thumbnail dims) and the stage area lights up while the pointer is over it. Release
    there: the thumbnail's windows join the current stage set (same as Shift-click, SM-5) and fly in
    from the thumbnail. Release over the strip, or Esc: the copy flies back, nothing changes. A press
    that moves less than 8 px is a click (SM-21).
  - *Window onto a thumbnail*: while a stage window is dragged by its title the thumbnail under the
    pointer lights up (the strip slides in when the pointer is near its edge). Release on it: the window
    moves to that set and is hidden with it; the window goes back to where it was picked up. If it was the
    last window of the stage, the most recent strip set takes the stage (SM-4). Release between
    thumbnails is SM-25. Esc during the drag puts the window back and drops nothing.

## Public API (kept)
- **SM-29** `toggleDesktop()` / `isDesktopShown`, `openIntoStage(appId)` (the next window of that
  app joins the stage set within 10 s), and the `'staged'` window flag (a window hidden by Stage
  Manager) read by Mission Control and the adaptive menu bar. `WindowState.stageActive` is true
  while it runs.
- **SM-30** Hidden windows keep their frame, workspace, stacking and run normally. Mission Control
  decides what it lists from the `'staged'` flag; hidden sets show as thumbnails.
- **SM-31** Show Desktop moves the stage set into the strip (all windows hidden, no stage); calling
  it again or activating any window brings the previous stage back.

## Disable and teardown
- **SM-32** Turning Stage Manager off, disabling Guava, or an error in the adapter leaves **every**
  window as it would be without Stage Manager: visible (opacity 255), reactive and mapped, not
  minimized (unless the user minimized it, SM-11), stacking and frame unchanged. No actor, signal,
  timer, binding or WindowState flag survives. Enable after disable starts from the focused window
  as the stage.
- **SM-33** The adapter reconciles the real windows against the model on every event: a missed or
  reordered signal heals on the next event instead of leaving a window hidden or stuck.

## How windows are hidden (design)
A hidden window gets opacity 0 and is hidden from picking (`Shell.util_set_hidden_from_pick`). It is
not minimized, unmapped or moved: that is fully reversible (restore = opacity back + pick back, a
single synchronous step that cannot fail midway), the app keeps drawing (live thumbnails) and
Mutter's own minimize bookkeeping stays untouched. A `notify::opacity` guard undoes the Shell's own
fade-in. Keyboard focus never rests on a hidden window: the model moves it to the stage lead.

## Settings (default)
`stage-manager` off · `stage-manager-side` `left` (`right`) · `stage-manager-show-recent` on ·
`stage-manager-autohide` on · `stage-manager-group-by-app` on (restarts the feature) ·
`stage-manager-new-windows` `replace` (`join`) · `stage-manager-wallpaper-click` on ·
`stage-manager-tilt` 22 degrees · `stage-manager-animation-speed` 1.0 · shortcuts
`stage-manager-shortcut` (empty), `-remove-`, `-next-`, `-previous-`, `-slot-1..6-shortcut`.

## Code
`features/stageManager/`: `dragModel.js` (pure drop targets of SM-34), `model.js` (pure `StageModel`: events in, effects out; it owns the sets, the
stage and strip per workspace and whether the strip is slid in), `geometry.js` (pure), `index.js`
(adapter: Mutter signals to events, effects applied by an idempotent reconcile), `view.js` (strip,
edge, pressure barrier), `windows.js` (hider), `flights.js` (clone flights through `ctx.motion`),
`thumbEffect.js`, `shortcut.js`. The strip is claimed through `core/layout.js` (opposite a side dock).

## Tests
`tests/stageManagerModel.test.js` (one scenario per rule, named by SM-n),
`tests/stageManagerFuzz.test.js` (300 seeds of random events; invariants after every event),
`tests/stageManagerGeometry.test.js`, `tests/stageManagerDrag.test.js`. Real Shell: `tools/scenarios/stage-manager-*.sh` (bundle
`stage-manager-lib.sh` first; see its header), plus the `stage-manager-hide-reveal` probe.
