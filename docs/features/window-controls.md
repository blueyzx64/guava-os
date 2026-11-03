# Window buttons

## What it does
Close, minimize and maximize stay on each app's own titlebar, always. Guava draws no window buttons in the top bar (the top-bar controls and the green-button menu were removed in round 3). Registry ids `app-buttons` and `gtk-theme`. Code: `features/appButtons/`.

## Use
- **Side (`window-controls-side`, default `right`):** the GNOME side. `left` is the macOS side. Guava sets the GNOME `button-layout`, so GTK 3, GTK 4/libadwaita, Chromium/Electron and server-side frames follow it. Other entries of the layout (app menu, icon) stay, mirrored to the opposite side when the buttons move.
- **Buttons (`app-buttons-set`, default `all`):** close, minimize and maximize, or close only (the stock Fedora layout).
- **Look (`app-buttons-style`, default `macos`):** macOS traffic lights, in GTK CSS, or the stock GNOME look. Size `small`/`normal` (`button-size`). Open apps pick up a new look when restarted.
- **Green button (`windows-green-button-fullscreen`, default on):** as on macOS, the maximize button enters full screen (in its own Space when `move-window-to-new-workspace` is on); clicking it on a zoomed (maximized) window also enters full screen, and leaving full screen returns it to zoomed. A maximize request while full screen leaves full screen. Double-clicking the titlebar away from the buttons, Super+Up, the Zoom menu items, tiling and drags still maximize. In full screen GTK apps hide their titlebar: leave with F11, the menu bar's Window menu (move the pointer to the top), or Esc in apps that offer it.
- **Tiling and Split View** do not need a button: use the drag-to-top layout picker and the shortcuts ([windows.md](windows.md)). Guava cannot add a hover menu to GTK apps' own buttons.

## Settings (default)
`windows-green-button-fullscreen` `true` · `window-controls-side` `right` · `app-buttons-set` `all` · `app-buttons-style` `macos` · `button-size` `small`.

## How it works
Guava owns GNOME's `button-layout` while it runs. The user's original is saved by `core/originals.js` and restored exactly on disable, also after a crash and after an upgrade from a build that had the top-bar controls (those stripped the buttons from the layout). GTK CSS in `~/.config/gtk-{3,4}.0/gtk.css`, between Guava's marker comments, gives the traffic-light look; the rest of that file is never touched.

## Limits
- The green button is recognised, not intercepted: Mutter reports only that the app asked to maximize. Guava treats the request as the green button when no key or Shell click is being handled (the request came from the app), no window drag is running, the window has been open for a second, and the pointer is on the button side of the titlebar (`greenButtonModel.js`). A double-click on the titlebar right next to the buttons therefore also goes full screen.
- Apps that hard-code their own layout keep their buttons (Electron and KDE apps with client-side decorations).
- Flatpak GTK apps need the `flatpak override` lines in the README to see the CSS.
- Without top-bar controls, an app that hides its own titlebar when maximized has no buttons: use its own shortcuts.

## Code
`features/appButtons/` (`index.js`, `model.js`, `buttonLayout.js`, `gtkTheme.js`, `greenButton.js`, `greenButtonModel.js`, `prefs.js`, `gtk/`). Registry ids `app-buttons`, `gtk-theme`, `green-button`.
