---
name: fedora-gnome-platform
description: Fedora 44 + GNOME 50 platform facts for Guava OS. Use when a feature reads or writes GNOME GSettings keys (button-layout, edge-tiling, dynamic-workspaces, num-workspaces, color-scheme, accent-color, fonts, reduced-motion, enabled-extensions), talks D-Bus (UPower, power-profiles / tuned-ppd HoldProfile, switcheroo, BlueZ, MPRIS, StatusNotifierItem/Watcher, DBusMenu, Unity LauncherEntry, FileManager1, PackageKit, logind/SessionManager, hostname1), uses portals or Flatpak app ids, packages the shelf helper RPM, or hits Wayland-only constraints (no drag start from the Shell, no X11 session, Xwayland ids).
---

# Fedora 44 / GNOME 50 platform for Guava

Fedora 44 (released April 2026) ships GNOME 50; Workstation is Wayland-only (no X11 session in
GNOME 50; X11 apps via Xwayland on demand). Harness root: `/tmp/claude-0/x2/f44` (real F44 RPMs).

## 1. GNOME keys Guava owns (only through `core/originals.js`)

| Schema · key | Owner (file) | Note |
|---|---|---|
| `org.gnome.desktop.wm.preferences button-layout` | `features/appButtons/buttonLayout.js:15` | Apps read it via the **Settings portal** (`org.freedesktop.portal.Settings.Read`), so a sandboxed app updates only if the portal runs with the session env (`inner-real.sh` restarts it) |
| `org.gnome.mutter edge-tiling` (`b`) | `features/windows/index.js:64-65` | false while Guava tiling runs |
| `org.gnome.mutter dynamic-workspaces`, `org.gnome.desktop.wm.preferences num-workspaces` | `features/missionControl/index.js:360-366` | static Spaces |
| `org.gnome.shell.app-switcher current-workspace-only` | `missionControl/index.js:393` | |
| `org.gnome.desktop.wm.keybindings minimize` (`as`) | `features/windows/hide.js:74-76` | Super+H for Hide |
| `org.gnome.desktop.interface color-scheme`, `accent-color` | `features/appearance/scheme.js:113,257` | Auto Light/Dark |
| `org.gnome.desktop.interface font-name`, `document-font-name`, `monospace-font-name`, `font-hinting`, `font-antialiasing` | `features/typography/index.js:80` | |
| `org.gnome.shell.keybindings toggle-application-view` | `features/launchpad/index.js:52` | Super+A / F4 |
| `org.gnome.shell enabled-extensions` (members only) | `features/dock/dashToDock.js:55` | removing Dash to Dock triggers an extension rebase (`gnome-shell-extension` skill §2) |

Read-only (watched): `org.gnome.desktop.a11y.interface reduced-motion` (enum
`'no-preference'|'reduce'`, verified in the F44 schema), `org.gnome.desktop.interface
enable-animations`, `org.gnome.desktop.background picture-uri(-dark)`, `org.gnome.desktop.notifications`,
`org.gnome.desktop.input-sources`, `org.gnome.desktop.peripherals.touchpad`, `org.gnome.settings-daemon.plugins.media-keys`.
Always look a schema up first (`Gio.SettingsSchemaSource.get_default().lookup(id, true)`,
`extension.js:44-46`): a missing schema in `new Gio.Settings` aborts the Shell process.

## 2. D-Bus services (system bus unless noted)

| Service | Used by | Facts |
|---|---|---|
| `org.freedesktop.UPower` (+ `.Device`, DisplayDevice) | battery, notch charging, `lib/batteryModel.js` | `upower.service` present in F44 root |
| `org.freedesktop.UPower.PowerProfiles` / legacy `net.hadess.PowerProfiles` | `features/lowPower/` (HoldProfile) | ⚠ Fedora ≥41 Workstation ships **tuned-ppd**, which provides this API in place of power-profiles-daemon; verify `HoldProfile` support on a real F44 install. The harness root has neither (mocked by dbusmock in `pre-lib.sh`). Call both names, prefer the UPower one |
| `net.hadess.SwitcherooControl` | GPU choice for launches | `switcheroo-control.service` in F44 |
| `org.bluez` (`Device1`, `Battery1`) | notch headphones, widgets | ObjectManager |
| `org.freedesktop.hostname1` | About This PC | |
| `org.gnome.SessionManager` (session bus) | logout/inhibit | |
| `org.mpris.MediaPlayer2.*` (session) | `lib/mpris.js`, `core/mprisWatcher.js` | one watcher for the whole extension |
| `org.kde.StatusNotifierWatcher` / `Item` (session) | `features/menuBarItems/host.js` | AppIndicator extension owns the watcher with `BusNameOwnerFlags.NONE` (`refs/gnome-shell-extension-appindicator/statusNotifierWatcher.js:58`); Guava defers to it when present |
| `com.canonical.dbusmenu`, `com.canonical.AppMenu.Registrar` | app menus (`core/appMenus/dbusMenu.js`) | Xwayland apps keyed by X11 id (`lib/compat.js:40`) |
| `com.canonical.Unity.LauncherEntry` (session, signal `Update`) | dock badges (`lib/launcherEntry.js`) | entries die with their sender |
| `org.freedesktop.FileManager1` (session) | Show in Files | Nautilus |
| `org.freedesktop.PackageKit` (`.Modify`) | install Inter font | asks the user |
| `org.freedesktop.background.Monitor` (session, portal) | dock grey dots, `lib/backgroundApps.js` | Background portal's list of sandboxed apps |
| `org.freedesktop.LocalSearch3` (session) | Spotlight files | GNOME 50 name of Tracker |

Rules: async proxies only (`Gio.DBusProxy.new_for_bus` with a `Gio.Cancellable` cancelled
from `cleanup`); never `*_sync` on the Shell main loop; treat a missing service as "feature
degrades", not an error log loop.

## 3. Apps, Flatpak, portals

- App ids: `Shell.WindowTracker.get_window_app(win)`; Flatpak windows also have
  `win.get_sandboxed_app_id()`; web apps need `core/desktopModel.js` `appIdCandidates`.
- Portals: `/usr/share/xdg-desktop-portal/gnome-portals.conf` prefers `gnome;gtk`; Secret →
  gnome-keyring. Portal backends are D-Bus activated: they need `WAYLAND_DISPLAY` in the
  activation env.
- Launchpad uninstall is Flatpak-only, through GNOME Software (`features/launchpad/uninstall.js`).

## 4. Wayland constraints that shape features

- The Shell cannot start a Wayland drag-and-drop to clients: the notch shelf's drag-out uses a
  GTK4 helper process (`packaging/shelf-helper/guava-shelf-helper.js`) whose window
  Guava places over the shelf.
- Clients cannot know global positions; only the compositor moves windows (`move_frame`).
- Global hotkeys: only through the Shell (`lib/keybindings.js`, `Main.wm.addKeybinding`).
- Clipboard: `St.Clipboard` in the Shell; apps on Wayland only see it while focused.
- No `xprop`/`xdotool` for Wayland windows; tests drive the Shell through the probe.

## 5. Packaging

- Extension zip: `make pack` (`gnome-extensions pack` + `EXTRA` dirs), `make pack-check`.
  Zip must not contain binaries (EGO rule).
- Shelf helper RPM: `make helper-rpm` → `dist/helper/RPMS/noarch/guava-shelf-helper-*.rpm`
  (`packaging/shelf-helper/guava-shelf-helper.spec`: noarch, `Requires: gjs gtk4 gnome-shell`,
  installs `/usr/bin/guava-shelf-helper` and a `.desktop`). `Recommends:
  gnome-shell-extension-guava` names no existing package (⚠ harmless but misleading).
  Shebang `#!/usr/bin/gjs -m` is fine for Fedora; `desktop-file-validate` runs in `%check`.
- SELinux: a user-installed extension and helper run as `unconfined_t` in a normal session;
  ⚠ no Guava-specific AVC denials known. Files Guava writes stay under `~/.local/share/guava`
  and `~/.config` (async, `lib/fileOps.js`).

## 6. Platform facts that change behaviour

- Software rendering or an active remote-desktop session ⇒ Shell inhibits animations
  (`ui/main.js:1027-1056`); Guava's motion follows `St.Settings.enable_animations`.
- GNOME 50 removed the X11 session; `global.display.get_x11_display()` can still be non-null
  when Xwayland runs.
- `GLib.idle_add_once`/`timeout_add_once` exist (GLib in F44), but use `cleanup.idle/timeout`.
