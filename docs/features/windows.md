# Windows: tiling, Hide, full screen, Split View, Show Desktop

## Tiling (`window-tiling`, key `windows-tiling`, on)
macOS Sequoia tiling. One engine for every way in.
- **Drag a window by its title bar:** to the left or right edge for a half, a corner for a quarter (`windows-tile-drag-edges`), to the menu bar to fill the screen (`windows-tile-drag-menubar`). A glass outline shows the result; the edge waits a beat first. Hold Alt for the outline anywhere near a side (`windows-tile-drag-modifier`). Dragging a tiled window away gives it back its old size.
- **Snap layouts (`windows-tile-drag-picker`, Windows 11 Snap Layouts):** drag to the top centre of the screen and a small rounded handle slides down under the top bar. Move onto it and it expands (size and corners morph) into a bar of layout thumbnails: two halves, two thirds and one third, one third and two thirds, three columns, a large left with two stacked, four quarters (`SNAP_LAYOUTS` in `core/tileActions.js`; every zone is also a tile action). The zone under the pointer lights up in the accent colour and the window-sized preview springs to its rect; drop on a zone to tile. Dropping elsewhere on the bar does nothing; leaving the bar collapses it to the handle, then hides it. Esc cancels. Dragging to the top edge away from the centre still fills at once. All motion is core/motion springs (crossfades under reduced motion).
- **The menu bar's Window menu:** same actions. (The green-button menu is gone with the top-bar window controls: window buttons stay on the app's own titlebar, [window-controls.md](window-controls.md).)
- **Shortcuts (Ctrl+Super; macOS uses Fn-Ctrl):** arrows for left, right, top, bottom; `F` fill; `C` center; `R` return to previous size; add Shift for arrangements (Left & Right, Right & Left, Top & Bottom, Bottom & Top); add Alt+Shift for Left/Right/Top/Bottom & Quarters. An arrangement gives the focused window the first place and the windows used before it the others.
- `windows-tile-margins` (off) adds a small gap around tiles.
- **Tiles fly:** every tile (drag drop, shortcuts, Fill, halves, Center, Return to Previous Size, a work-area change) moves the window to its frame in a medium `emphasized` flight instead of jumping. The real window actor is scaled about its frame's corner so its frame sits on a rect that travels old to new (`tileMotion.js`, pure part `tileMotionModel.js`): a window that grows is resized at once and its larger buffer flies in; one that shrinks shrinks its old buffer first and is resized on arrival, so only a larger bitmap is ever scaled down. A new tile mid-flight starts from where the window is; a grab ends it. No flight with animations off, Reduce Motion, a hidden or full-screen window, or a move under 2 px. The last frame is the app's own, drawn 1:1.
- GNOME's own edge tiling is off while this runs (`core/originals.js`). A shortcut GNOME or Stage Manager already uses is left unbound (Stage Manager's Ctrl+Super+Down wins while it runs).

## Hide and Hide Others (`app-hide`, key `windows-app-hide`, on)
Super+H hides the front app, Alt+Super+H hides the others. Wayland has no hidden apps, so the windows are minimized without an animation and flagged `hidden`; the dock leaves them out of its minimized area, and activating the app brings them all back. Guava borrows Super+H from GNOME's minimize binding while Hide is on and gives it back after. The app menu and the app switcher use the same action.

## Full screen in its own Space (`move-window-to-new-workspace`, on)
A full-screen window moves to a new workspace at the right and returns when it leaves full screen. The maximize (green) button of an app's titlebar enters full screen ([window-controls.md](window-controls.md)). Paused while Stage Manager runs. A new window that opens while you look at a full-screen Space (from Spotlight, the dock, a shortcut) goes to the first workspace and you follow it there, as macOS switches to the app's Space. With the GNOME option "Workspaces span displays" (`workspaces-only-on-primary` off) a full-screen window on any monitor takes the whole workspace, so every monitor switches; with the default only the primary monitor's windows count.

## Split View (`split-view`, on)
With a full-screen window focused, press Ctrl+Super+Alt+Left or Right (`split-view-left-shortcut`, `split-view-right-shortcut`; also in Settings, Windows) to tile it to that side of the screen. A full-screen window cannot be dragged, so the snap bar does not offer Split View. The other half shows thumbnails of your other windows; click one to pair it. Esc or a click on the tiled half cancels. A window that was zoomed (maximized) before it went full screen is unzoomed first, so it takes the half. The pair ends when a window closes, minimizes, goes full screen or maximizes; the remaining window is full screen again.

## Show Desktop (`show-desktop`)
A top-bar button (`show-desktop-button`, on), Super+D (`show-desktop-shortcut`) or a click on empty wallpaper (`click-wallpaper-reveals-desktop`: `always` default, `stage-manager`, `never`) slides the windows of the workspace to the screen edges. Windows are never moved or minimized, only their actors are shifted. A second press, a click on a window, a workspace switch or the overview brings them back. With Stage Manager on, the stage moves into the strip instead. GNOME's own show-desktop shortcut, if you set one, plays the same animation.

## Limits
- Mutter has no public tiling API, so tiles are plain window frames that Guava tracks itself; they follow the work area (menu bar and dock excluded).
- A window with a minimum size larger than its tile keeps that size.

## Code
`features/windows/` (`index.js`, `tileMotion.js`, `tileMotionModel.js`, `drag.js`, `snapBar.js`, `snapModel.js`, `model.js`, `hide.js`, `hideModel.js`), `core/tileActions.js`, `features/fullscreenSpace/`, `features/splitView/`, `features/showDesktop/`.
