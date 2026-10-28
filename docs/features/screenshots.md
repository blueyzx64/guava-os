# Screenshots

## What it does
The macOS capture shortcuts, the Shift+Super+5 toolbar and a floating thumbnail, built on GNOME's own screenshot UI and screencast service (never a second implementation). Registry id `screenshots` (key `screenshots`, on). Code: `features/screenshots/`.

## Use
- **Shift+Super+3:** capture the entire screen.
- **Shift+Super+4:** a bare crosshair; releasing a drag captures; Space switches to picking a window and back.
- **Shift+Super+5:** Guava's glass toolbar on the stock UI. While a recording runs it stops it; while the timer counts down it cancels it.
- **Thumbnail (`screenshots-thumbnail`, on):** appears after a capture; the file is saved after 5 seconds, or swipe it right to save now. Click to open, right-click for more.
- GNOME's own shortcuts (Print, Shift+Print, Alt+Print, Ctrl+Alt+Shift+R) are not touched. Screenshots are added to the notch shelf, and recordings show as a notch live activity.

## Settings (default)
`screenshots-save-to` `pictures` (Pictures/Screenshots; also Desktop, Documents, Clipboard only, other folder via `screenshots-other-folder`) · `screenshots-timer` 0 (5 or 10 seconds) · `screenshots-remember-selection` on · `screenshots-show-pointer` off · `screenshots-macos-names` on (`Screenshot 2026-03-09 at 08.05.07`) · shortcuts `screenshots-shortcut-screen`, `-selection`, `-toolbar`.

## Limits
- GNOME writes the PNG to Pictures/Screenshots and copies it to the clipboard first; Guava then moves that one file to the folder you chose and drops GNOME's "Screenshot captured" banner. Clipboard only moves the file to the Trash.
- The thumbnail cannot be dragged into other apps (the Shell cannot start a Wayland drag).
- Audio and annotation are not part of Guava.
