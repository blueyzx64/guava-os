# Menu bar

## What it does
Turns GNOME's top bar into the macOS menu bar: logo menu, the focused app's name and menus, status items, privacy dots, Control Center and clock. Registry id `menu-bar`; status icons and pinned controls are `menu-bar-items`.

## Use
- **Logo menu:** About This PC, System Settings, Force Quit, Sleep, Restart, Shut Down, Lock Screen, Log Out. Force Quit also opens with Super+Alt+Esc.
- **App menus:** the bold app name, then its menus. Where they come from: [app-menus.md](app-menus.md).
- **Ctrl+F2** moves the keyboard focus into the menus.
- **Clock:** a click opens the Notification Center ([notification-center-focus.md](notification-center-focus.md)); Alt-click toggles Do Not Disturb.
- **Full screen:** the bar hides and slides in when the pointer touches the top edge.
- **Privacy dots:** orange microphone, green camera, purple screen sharing; click to see which app.
- **Status items:** tray icons of apps (StatusNotifierItem) with their menus, controls pinned from the Control Center ("Show in Menu Bar"), battery percentage, an item order and an overflow chevron for items that do not fit.

## Settings (Menu Bar page; default)
| Key | Default |
|---|---|
| `menubar-logo` (`fedora`, `guava`, `none`) | `fedora` |
| `menubar-app-menu` | on |
| `menubar-native-menus` | on |
| `menubar-atspi-menus`, `menubar-atspi-popovers` (experimental) | off |
| `menubar-transparent` | on |
| `menubar-solid-on-window` | off |
| `menubar-fullscreen-visible` | off |
| `menubar-privacy-dots` | on |
| `menubar-command-glyphs` (write shortcuts as ⌘ ⌥ ⌃ ⇧) | on |
| `menubar-clock-option-dnd` | on |
| `menubar-focus-shortcut` | Ctrl+F2 |
| `menubar-force-quit-shortcut` | Super+Alt+Escape |
| `menubar-show-activities` (GNOME's Activities button) | off |
| `move-calendar-right` (clock and calendar at the right) | on |
| `menubar-status-items`, `menubar-overflow` | on |
| `menubar-pinned`, `menubar-item-order`, `menubar-item-hidden` | empty |

## Limits
- The bar is the Shell's panel, so GNOME's own panel items stay where the Shell puts them; Guava claims slots through `core/panelLayout.js`.
- While the notch is on, the clock stays at the right whatever `move-calendar-right` says.
- If the AppIndicator extension is enabled it owns the tray; Guava then only orders and hides its icons.

## Code
`features/menuBar/` (index, `appMenuBar.js`, `adaptiveBar.js`, `logoMenu.js`, `privacyDots.js`, `fullscreenReveal.js`, `forceQuit.js`, `aboutDialog.js`), `features/menuBarItems/`, `features/calendar/`, `core/appMenus/`, `core/panelLayout.js`.
