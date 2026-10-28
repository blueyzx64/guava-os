# App menus in the menu bar

## What it does
Shows the focused app's own menus when the app exports them, and Guava's generic menus otherwise. Guava's App menu (bold name), Window and Help always stay. Code: `core/appMenus/` (providers) and `features/menuBar/appMenuBar.js` (the view).

## Providers, in priority order
| App | Provider | How Guava reads it | Activation |
|---|---|---|---|
| Every app | generic | Shell: About, Hide, Quit, New Window, Minimize, Zoom, Tile, Move to Workspace | Shell / Mutter |
| GTK 3/4 (`GtkApplication`) | GTK actions | `org.gtk.Actions` on the window's bus name; well-known actions fill the generic slots | `org.gtk.Actions.Activate` |
| GTK apps with `gtk_application_set_menubar()` | GTK exported menus | `org.gtk.Menus` at the menu bar object path (and the GTK 3 app menu) | `org.gtk.Actions.Activate` |
| Qt 5/6, Chromium/Electron, LibreOffice under Xwayland | DBusMenu | Guava's `com.canonical.AppMenu.Registrar`, then `com.canonical.dbusmenu` | `Event(id, 'clicked')` |
| Apps with a menu bar in the window (experimental) | AT-SPI | the accessibility bus: the window's `MENU_BAR` | `org.a11y.atspi.Action.DoAction` |
| libadwaita apps (experimental, own switch) | AT-SPI popover | opens the main menu with its popup transparent, reads it, closes it; cached per app | reopens it the same way, then `DoAction` |

The first menu bar provider that returns a menu bar wins (GTK exported menus, then DBusMenu, then AT-SPI). A native menu bar replaces Guava's File, Edit and View. A native Window or Help menu adds its items to Guava's. Help > Search searches every item of the menus on screen, submenus included.

Settings (Menu Bar page): `menubar-native-menus` (on), `menubar-atspi-menus` (off), `menubar-atspi-popovers` (off).

## What apps need
- **GTK apps:** nothing. Most GNOME apps have no menu bar (they use a hamburger menu); Guava shows generic menus filled with the actions they export.
- **Qt apps:** run on X11 (`QT_QPA_PLATFORM=xcb`) with the GNOME or GTK platform theme. Qt checks for the registrar once at start, so apps started before Guava keep their in-window menu bar until restarted. Native Wayland Qt windows keep their in-window menu bar. Guava never sets these variables for you.
- **Chromium and Electron:** start them on X11 (`--ozone-platform=x11`).
- **Another registrar** (an appmenu-registrar package): Guava does not take the name; it asks that registrar for each window's menu.
- **AT-SPI:** GTK exposes its tree whenever the accessibility bus runs. Firefox, Chromium and Qt expose theirs only with accessibility on (`org.gnome.desktop.interface toolkit-accessibility`, or a screen reader). Guava does not change that setting.

## Limits
- DBusMenu submenus are told `AboutToShow` only at the top level; apps that build deeper submenus lazily show them as last built.
- The AT-SPI popover read is a real open and close for the app: hidden from the screen, but the app's focus moves into the popover and back for about a second. It runs once per app (then cached) and once per activation. This is why it is off by default.
- AT-SPI reads are async with a timeout and a budget of 1500 nodes, so a huge window may not be read completely. The Shell never waits on them.
- Flatpak apps: the accessibility app is matched by process id, which a sandbox may hide.
