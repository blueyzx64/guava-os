# Desktop icons

## What it does
The files and folders of `~/Desktop` (and optionally mounted drives) as large icons, laid out from the top-right corner down the right-most column and then left, as the Finder desktop does. Registry id `desktop-icons` (key `desktop-icons`, on). Code: `features/desktopIcons/`.

## Use
Click selects (Ctrl toggles, Shift ranges), double-click opens, a rubber band from the wallpaper selects, dragging moves the selection to the nearest free cells (places are remembered). Right-click: Open, Show in Files, Rename, Move to Trash (Eject for drives), New Folder; the wallpaper menu gets New Folder and Sort By. Keys after a click: arrows, Enter, F2, Delete, Ctrl+A, Ctrl+Shift+N, Esc, typing a name.

## Settings (default)
`desktop-icons` on · `desktop-icons-size` 64 (32 to 128) · `desktop-icons-show-drives` on · `desktop-icons-sort` `none` (name, kind, date-modified, date-created, size; dragging an icon sets it back to none) · `desktop-icons-layout` (internal JSON).

## Limits
- Guava changes user files only by explicit actions: rename, Move to Trash (never a delete), New Folder.
- Previews come from GNOME's thumbnail cache; a missing preview is requested once per file.
- It stays idle while Desktop Icons NG is enabled; the preferences page says so.
- Dragging icons out into other apps is not built.
- Layer order: wallpaper, icons, widgets, windows (`core/desktopLayers.js`).
