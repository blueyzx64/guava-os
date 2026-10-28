# Headless smoke test

`tools/smoke/run-headless.sh [toggles]` (or `make smoke`) starts a headless
GNOME Shell (`--headless --wayland --virtual-monitor 1280x800`) with Guava enabled,
disables and re-enables it `toggles` times (default 10) over D-Bus, then prints a summary.

## Safety
Everything runs in a temp dir (`/tmp/guava-smoke.XXXXXX`): its own HOME, XDG dirs,
`GSETTINGS_BACKEND=keyfile`, private session bus. Your real profile, dconf and
installed extensions are not read or written. Guava is copied (not linked) from the repo.

## Needs
`gnome-shell`, `dbus-run-session`, `gsettings`, `glib-compile-schemas`, `gdbus`, `python3`.
If `org.freedesktop.login1` is missing from the system bus (containers) it starts
`fake-logind.js` (needs `gjs`) and a system `dbus-daemon`. On a normal desktop this is skipped.

## Reading results
Output: `Guava JS errors: N   Guava CRITICALs: M`, then one line per `file:line` and
message with a count. Exit 0 = none, 1 = Guava-related errors, 2 = setup failure / Shell did not start.
Counts include errors in teardown (disable). Full log: `<workdir>/shell.log`
(kept on failure; `GUAVA_SMOKE_KEEP=1` always keeps it, `GUAVA_SMOKE_DIR=path` picks the dir).
Noise from missing services (GDM, calendar, polkit, colord, ibus) is ignored.

## Env flags
- `GUAVA_SMOKE_SHELL_VERSION=46`: add that version to the temp copy's `metadata.json` only.
  Default: use the installed Shell as is.
- `GUAVA_SMOKE_SHIM=1`: container-only. Patches the temp copy for Shell 46 API gaps
  (`MessageView`, `orientation`). Never needed on 48-51.

Not exercised: windows, fullscreen, media players, clipboard. Enable/disable only.
Not run in CI (needs gnome-shell and D-Bus).
