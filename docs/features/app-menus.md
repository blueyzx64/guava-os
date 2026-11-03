# App menus in the menu bar

## What it does
Shows the focused app's own menus when the app exports them, and Guava's generic menus otherwise. Guava's App menu (bold name), Window and Help always stay. Code: `core/appMenus/` (providers) and `features/menuBar/appMenuBar.js` (the view).

## Providers, in priority order
| App | Provider | How Guava reads it | Activation |
|---|---|---|---|
| Every app | generic | Shell: About, Hide, Quit, New Window, Minimize, Zoom, Fill, Center, Move & Resize, Move to Workspace/Display, Always on Visible Workspace, Always on Top | Shell / Mutter, tiling engine |
| GTK 3/4 (`GtkApplication`) | GTK actions | `org.gtk.Actions` on the window's bus name; well-known actions fill the generic slots | `org.gtk.Actions.Activate` |
| GTK apps with `gtk_application_set_menubar()` | GTK exported menus | `org.gtk.Menus` at the menu bar object path (and the GTK 3 app menu) | `org.gtk.Actions.Activate` |
| Qt 5/6, Chromium/Electron, LibreOffice under Xwayland | DBusMenu | Guava's `com.canonical.AppMenu.Registrar`, then `com.canonical.dbusmenu` | `Event(id, 'clicked')` |
| Apps with a menu bar in the window (experimental) | AT-SPI | the accessibility bus: the window's `MENU_BAR` | `org.a11y.atspi.Action.DoAction` |
| libadwaita apps (experimental, own switch) | AT-SPI popover | opens the main menu with its popup transparent, reads it, closes it; cached per app | reopens it the same way, then `DoAction` |

The first menu bar provider that returns a menu bar wins (GTK exported menus, then DBusMenu, then AT-SPI). A native menu bar replaces Guava's File, Edit and View. A native Window or Help menu adds its items to Guava's. Help > Search searches every item of the menus on screen, submenus included.

Settings (Menu Bar page): `menubar-native-menus` (on), `appmenus-accessibility` (on), `menubar-atspi-menus` (off), `menubar-atspi-popovers` (off).

## Coverage: what works for which toolkit
| App kind | What the menu bar shows | What you must do |
|---|---|---|
| GTK 3/4 with a menu bar (`GtkApplication`) | the app's own menus | nothing |
| GTK 3/4 without one (most GNOME apps) | Guava's menus filled with the app's actions; Edit types the standard shortcuts | nothing |
| GTK 3 plain `GtkMenuBar` (no `GtkApplication`) | Guava's generic menus (the in-window bar stays) | nothing; no export exists on Wayland |
| Qt 5/6 under Xwayland | the app's own menus | run it on X11 (`QT_QPA_PLATFORM=xcb`), start it after Guava |
| Qt 5/6 on native Wayland | generic menus | none helps: spike result below |
| Chromium, Electron, VS Code | the app's own menus on X11; generic menus on Wayland | Settings > Menu Bar > "Chromium and Electron Apps": Use X11 (restart the app) |
| Firefox | generic menus; AT-SPI menu bar read when "Read Menus Through Accessibility" is on | accessibility is on by default (`appmenus-accessibility`) |
| libadwaita apps | generic menus; primary menu via the experimental AT-SPI popover read | optional "Read Primary Menus" |
| LibreOffice | GTK3 VCL: own menus; else generic | `libreoffice-gtk3` package |
| Java (Swing, JetBrains) | generic menus | nothing exports; use the generic ones |
| Flatpak | GTK: as above. Registrar apps (Qt, Electron): generic menus | Settings > Menu Bar > "Flatpak Apps": Allow the menu service |

Generic menus do real things for every app. Edit sends the standard shortcut to the focused window (Undo Ctrl+Z, Redo Ctrl+Shift+Z, Cut, Copy, Paste, Select All, Find Ctrl+F; Ctrl+Shift+C/V in terminals) through a virtual keyboard, after the menu has closed and the window has focus. An app that exports an Edit action keeps that action. Close Window, Quit, Minimize, Zoom, Full Screen and the window list act on the window directly (`tools/scenarios/appmenus-edit.sh` checks each Edit command in Text Editor).

### Qt on native Wayland: spike result (2026-11-03)
Qt Designer (Qt 6.11.2, `QT_QPA_PLATFORM=wayland`) on the harness Shell with Guava owning the registrar, platform theme unset, `gnome`, `gtk3` and `xdgdesktopportal`: no `RegisterWindow` call ever reached the registrar (dbus-monitor, 8 s each; `tools/scenarios/appmenus-qt-spike.sh`). Mutter has no `org_kde_kwin_appmenu`, and Qt's Wayland platform keeps its in-window menu bar without it. Matching by sender PID would have nothing to match, so it was not built. Revisit if a Qt release starts registering.

## What apps need
- **GTK apps:** nothing. Most GNOME apps have no menu bar (they use a hamburger menu); Guava shows generic menus filled with the actions they export.
- **Qt apps:** run on X11 (`QT_QPA_PLATFORM=xcb`) with the GNOME or GTK platform theme. Qt checks for the registrar once at start, so apps started before Guava keep their in-window menu bar until restarted. Native Wayland Qt windows keep their in-window menu bar. Guava never sets these variables for you.
- **Chromium and Electron:** start them on X11 (`--ozone-platform=x11`). Preferences > Menu Bar > Chromium and Electron Apps writes one marked line to the app's `~/.config/<app>-flags.conf` and removes only that line again. Cost: XWayland windows can look softer on fractional scaling.
- **Flatpak:** Preferences > Menu Bar > Flatpak Apps runs `flatpak override --user --talk-name=com.canonical.AppMenu.Registrar <id>` (and `--no-talk-name` to undo).
- **Another registrar** (an appmenu-registrar package): Guava does not take the name; it asks that registrar for each window's menu.
- **AT-SPI:** GTK exposes its tree whenever the accessibility bus runs. Firefox, Chromium and Qt expose theirs only with accessibility on. Guava turns `org.gnome.desktop.interface toolkit-accessibility` on while `appmenus-accessibility` is on (default; D-014) through `core/originals.js`, and gives your own value back when the option or Guava is off. Apps already open may need a restart. The AT-SPI providers themselves stay off by default: the harness read of Text Editor's primary menu found no tree (0 menus, 60 ms), so stability was not shown (`tools/scenarios/appmenus-a11y.sh`).

## Window menu (generic)
Minimize, Zoom, Fill, Center, Move & Resize (Left, Right, Top, Bottom, the four quarters, Return to Previous Size), Enter Full Screen, Move to Workspace (each workspace, or New Workspace: the window moves to a new last workspace and you follow it), Move to Display (two or more monitors), Always on Visible Workspace, Always on Top, Bring All to Front, then the app's windows. Fill, Center and Move & Resize ask the tiling engine (`window-tile-requested`, `core/tileActions.js`); without it the zones are placed directly and Center / Return to Previous Size do nothing. Shortcut labels show Guava's tiling and Hide shortcuts when set, else GNOME's window-manager shortcuts. As in GNOME's window menu, a window on every workspace, or one off the primary monitor with workspaces on the primary only, cannot move workspace.

## Limits
- DBusMenu submenus are told `AboutToShow` only at the top level; apps that build deeper submenus lazily show them as last built.
- The AT-SPI popover read is a real open and close for the app: hidden from the screen, but the app's focus moves into the popover and back for about a second. It runs once per app (then cached) and once per activation. This is why it is off by default.
- AT-SPI reads are async with a timeout and a budget of 1500 nodes, so a huge window may not be read completely. The Shell never waits on them.
- Flatpak apps: the accessibility app is matched by process id, which a sandbox may hide.
