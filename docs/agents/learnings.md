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
