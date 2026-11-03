# Learnings (the compounding log)

> Read this before you start. One entry per lesson that cost someone time. Newest first. Only the
> orchestrator writes here (agents propose entries as `LEARN:` lines in their memory file).
> Format: **Context** · what worked / what failed · **Do instead**.

## Windows (Mutter 50)

- **Tell an app's own maximize request from the Shell's** (B12, green button):
  `Clutter.get_current_event()` is null inside `notify::maximized-*` when a Wayland client asked
  (its titlebar button, a titlebar double-click); Super+Up and Shell menus run inside a key or
  button event. Combine it with the pointer position over the button band. Do instead: never
  guess from timing alone.
- **`global.display.get_grab_op()` does not exist in Mutter 50.** Track `grab-op-begin` /
  `grab-op-end` on `global.display`.
- **Read the user's own setup before assuming the source of a behaviour** (B13): "shake to find
  the cursor" was not GNOME (Mutter 50.6 has none) but a feature of the user's own Kiwi fork.
  Ask which extensions run, then grep their code and history (all branches).

- **Mutter emits `kill-window-effects` synchronously before the next effect** on the same actor
  (B1). Ending the running effect there makes an interrupted Genie jump. Keep its picture and
  resume from the current progress.
- **A `Clutter.OffscreenEffect` texture covers the enlarged paint box** (+2/+1 px), not the
  actor's box (B1). Map through `get_paint_box()`, or the drawing is soft.
- **Stage Manager's exempt rules apply on change too** (B7): a field flipping on a staged window
  (`above`) made it stage and focus another window, which silently retargeted the menu bar.

## Shell chrome

- **`Main.layoutManager.addTopChrome()` after Shell init lands above modal dialogs** and the
  screenshot UI (B4). Stack Guava chrome just above the panel instead.
- **A LauncherEntry progress bar needs sender tracking and expiry** (B8): a browser that crashes
  or closes never sends `progress-visible=false`. Drop entries whose sender leaves the bus and
  entries that stop moving.

## Motion and rendering

- **Clutter skips transitions on unmapped actors:** `ease(opacity)` on a hidden actor jumps to
  its end. Show it first (`core/motionModel.js` `mustShowFirst`).
- **A second spring on a moving property must take over position and velocity** (B2, B4), or
  two timelines fight and the actor jumps (`springState`/`springPlan`).
- **The overview's `stateAdjustment.value` is the one source of truth** for anything that must
  fade with Mission Control (B15: the bar's glass follows it frame by frame).
- **GNOME 50 runs the login overview animation before extensions enable.** An extension cannot
  inject `runStartupAnimation` at login; start input-only features `later` instead (B2).
- **`ClutterPaintContext.get_stage_view()` is not introspected:** track the view from the
  stage's `before-paint`. `StageView.get_layout()` needs an out-arg in GJS: use `view.layout`.
- **`Meta.Window` has no `get_maximized()`** in Mutter 50: use `is_maximized()` (or `lib/compat.js`).

## Stage Manager (B25 rewrite)

- **Reconcile, don't track:** the adapter applies the model's `hiddenIds()` to the real windows
  after every event, so a missed signal heals on the next one. Hiding = opacity 0 + out of pick;
  Stage Manager never minimizes (that left windows minimized and unmapped when it was turned off).
- **Write the spec and failing scenarios before the rewrite.** The baseline (15/69 failing) found
  causes nobody had reported, and the same scenarios proved the rewrite (71/71).

## Dock

- **The Shell re-bases every extension behind a removed one in `_extensionOrder`** (B22): writing
  Dash to Dock out of `enabled-extensions` made GNOME disable and re-enable Guava. Step out of that
  array for the write and return once the dock is gone (`features/dock/dashToDock.js`).
- **Keyfile GSettings (the harness) deliver `changed` asynchronously; dconf (a real session) does
  it synchronously.** Code that writes a key and reacts to it must work both ways.
- **Never `set_scale` a small icon up** (B18): draw St icons at the largest size they will be
  shown (`icon_size` above `set_size`) and scale down; set the texture once, not per frame.

## Test environment

- **Fedora's `/etc/ssl/certs` is an absolute symlink** to `/etc/pki/tls/certs`. Writing through
  it from the host lands outside the root (or fails with "File exists"). `build-f44-root.sh`
  writes the proxy CA to `etc/pki/tls/certs/ccr.pem` and into `ca-trust/source/anchors` (dnf
  ignores `CURL_CA_BUNDLE`; it needs `update-ca-trust`).
- **Cisco's openh264 repo is outside Fedora's mirrors** and blocked behind most proxies. The
  root build disables `fedora-cisco-openh264`; Fedora's `noopenh264` satisfies the dependency.
- **The harness runs inside a Claude Code cloud container** (root, chroot, no Docker daemon
  needed): `X2=/tmp/claude-0/x2`. A baseline `run-f44.sh 3` takes about 3 minutes. Copies of
  the root (`f44b`…) let agents run in parallel; `run-f44.sh` queues when all are busy.
- **The harness screen is 800 px tall:** long menus scroll, so pointer clicks on low items miss
  (activate them directly when the command, not the click, is under test). Its home has no
  `user-dirs.dirs`, so `GLib.get_user_special_dir(DOWNLOAD)` is null until a scenario writes one.
- **A missing PERF/JITTER line means a JS error in the scenario body:** `P` and `perf_stop` pipe
  through grep, which swallows the error. Scenario helpers must not redeclare `st` (perf-lib
  declares it).
- **A harness run copies `GUAVA_SRC` when it starts, after the queue:** don't edit the tree while
  a run waits. The idle baseline must match window and overview state (stock login lands in the
  overview; a focused text view blinks its caret).
- **In the harness, an app's own maximize is now full screen** (the green button, B12): a
  scenario that maximizes from the app asserts `maximized || fullscreen`.
- **FreeType stem darkening is hinting-dependent:** `autofitter:` darkening needs light hinting, so
  TrueType fonts (Inter) stay thin under `font-hinting none`; CFF fonts darken either way. Measure
  text weight as ink (sum of |pixel - background|) over a crop of a harness screenshot. GNOME 50
  `font-rendering automatic` makes GTK4 ignore `font-hinting`: own `manual`.
- **Mutter hides a window with NO `minimize` signal while the compositor switches workspace** (B24):
  minimizing a full-screen window inside features/fullscreenSpace's slowed Space switch (isolation 600 ms +
  3x switch, about 3 s after entering full screen) gets no effect from any extension; later it does. A scenario
  that checks the full-screen Genie waits 4.5 s first.
- **A window actor can fly without stretching a small bitmap:** scale it about its frame corner so the frame
  follows a travelling rect (features/windows/tileMotion.js); grow = resize first, shrink = resize on arrival.
