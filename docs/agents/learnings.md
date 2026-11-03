# Learnings (the compounding log)

> Read this before you start. One entry per lesson that cost someone time. Newest first. Only the
> orchestrator writes here (agents propose entries as `LEARN:` lines in their memory file).
> Format: **Context** · what worked / what failed · **Do instead**.

## Hand-over audit (what "0 errors" was hiding)

- **A green check is only as good as the check.** Three of ours failed open: `check-pack.sh`
  checked nothing without git (a failure inside `< <(...)` does not stop a bash script); the
  harness error counter stopped at the blank line GLib puts before a CRITICAL's JS stack, so
  errors with a Guava frame were not counted; and the prefs process's log was never read.
  Do instead: plant one example of each failure (a mutation) and see the check go red before
  trusting it green.
- **Warnings hide real bugs.** `[Guava] pointer: big cursor not loaded: … Image is not a
  constructor` was a console.warn in every run: the crisp pointer never worked. Triage every
  `[Guava]` warning in shell.log; a feature that silently degrades is a bug.
- **Adw rows and group titles are Pango markup by default:** a title with `&` or `<` renders
  blank. Prefs text is plain text (`prefs/plainText.js`; row helpers set `use_markup: false`).
- **Harness roots are chroots sharing the host's PID namespace.** `pkill -f` in a scenario kills
  matching processes in every root and on the host (it killed the orchestrator's own shell).
  Kill exactly your window's client (`meta_window.kill()`) or the PID owning a name on your bus.
- **`pgrep -f <text>` matches the shell command that contains `<text>`,** so a wait loop on it
  never ends. Wait on a PID or a file, not a pattern.
- **A harness run copies `GUAVA_SRC` when its turn comes:** edit in a separate worktree while
  runs are queued.

- **Mutter 50 ignores the position of `move_resize_frame(true, …)` on X11 windows** (it applies
  the size): use `lib/compat.js` `moveResizeFrame()`. Found only by running a real X11 client
  (`tools/scenarios/x11-windows.sh`, xterm with Xwayland's `XAUTHORITY`); Wayland test apps hid it.
- **Without systemd, xdg-desktop-portal waits 25 s for RealtimeKit,** stalling every GTK service
  start (the prefs window looked slow). The harness disables the rtkit service file.
- **Reading outside a paint's redraw clip gives last frame's pixels:** a backdrop capture must
  keep a persistent texture and blit only the clip, or glass blurs itself and drifts.
- **`ease()` on a hidden actor calls `show()`:** a one-shot hide at lock is not enough; guard
  `notify::visible` for as long as the lock lasts (`lib/lockModel.js` SurfaceLedger).
- **A PopupMenu closes when its source actor hides,** and key focus moves into a menu before
  `activeMenu` is set: defer "is a menu open?" checks to an idle.
- **Mutter emits no `workspace-changed` on windows behind a removed middle workspace;** they just
  report index − 1. Never cache window → workspace index.
- **A `Meta.Barrier` on an edge shared with another monitor blocks the pointer** from crossing.
- **GTK `destroy` handlers in the prefs process run at shutdown:** undo on the window's
  `close-request` instead.
- **gdbus prints `(uint32 N,)`:** `grep -o '[0-9]\+' | head -1` yields 32. Take the last number.

## Windows (Mutter 50)

- **Tell an app's own maximize request from the Shell's** (B12, green button):
  `Clutter.get_current_event()` is null inside `notify::maximized-*` when a Wayland client asked
  (its titlebar button, a titlebar double-click); Super+Up and Shell menus run inside a key or
  button event. Combine it with the pointer position over the button band. Do instead: never
  guess from timing alone.
- **`global.display.get_grab_op()` does not exist in Mutter 50.** Track `grab-op-begin` /
  `grab-op-end` on `global.display`.
- **Read the user's own setup before assuming the source of a behaviour** (B13): "shake to find
  the cursor" was not GNOME (Mutter 50.6 has none) but a feature of the user's own earlier extension.
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
- **A pointer drag on chrome loses its events after ~250 ms without a grab:** hold
  `Main.pushModal` for the drag (B31). Esc during a Mutter window grab puts the window back and
  still fires `grab-op-end`: compare frames to tell a cancel from a drop.
- **Hover signals fire during teardown:** null the model first in cleanup order, or a late hover
  re-hides windows after they were restored.
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

## Lock screen and login

- **The Shell disables every extension without the `unlock-dialog` session mode on lock** (the
  harness probe extension too). Guava stays loaded and suspends its surfaces instead (B21): lock
  costs ~40 ms, unlock ~45-70 ms, against ~250 ms of blocking for a full disable.
- **Sub-registries are not reached by the registry's per-feature suspend:** a feature's own child
  cleanup registries (67 of them) need the extension-level sweep that hides `guava-` actors.
- **The headless harness Shell has no screen shield** (`Main.screenShield` is null): `canLock()`
  needs `/run/systemd/seats` and `org.gnome.DisplayManager` on the system bus
  (`tools/scenarios/lock-screen-style-pre.sh` fakes both). `lock(false)` fades to black at once:
  call `Main.screenShield._wakeUpScreen()` before screenshots.
- **Instance overrides (`obj._method = …`) only catch calls made as `this._method()`**, not methods
  the Shell bound with `.bind(this)` at construction: patch the prototype through the cleanup instead.
- **`ctx.motion.ease` calls `onDone(false)` when the actor is destroyed:** never chain the next
  step without checking `finished`.
- **Login readiness is NOT bound by parsing** (L18 disproved the earlier guess): the whole extension
  parses in ~50 ms; Shell imports cost ~0.17 ms/KB (~250 ms for the 1.5 MB login path) and
  `enable()` ~290 ms. The desktop counts as ready at the first frame of the notch and desktop icons
  after startup-complete, behind a ~285 ms stall from their first render: spread first builds out.
- **Re-importing a GObject module with a `?query` URL segfaults the Shell.** Don't use cache-busting
  imports to time module loads.

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
