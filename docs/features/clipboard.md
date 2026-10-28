# Clipboard history

## What it does
Keeps a history of what you copy (text, links, colours, images) with a top-bar popover and a keyboard-driven Quick Paste window. Registry id `clipboard-history` (key `clipboard-history`, on). Code: `features/clipboard/`.

## Use
- **Popover (top-bar icon):** search, filters (All, Text, Links, Images), Pinned and Recent sections. Pin and Remove show on hover. Footer: Recording/Paused switch and Clear History.
- **Quick Paste:** a centred glass window, list on the left and preview on the right. Enter pastes into the window that had focus, through a virtual Ctrl+V on Wayland. There is **no default shortcut**; set `clipboard-shortcut` in preferences (the button "Use Super+Shift+V" fills it in).
- Spotlight and the notch's Tray can show clipboard entries.

## Settings (default)
`clipboard-history` on · `clipboard-recording` on (a pause switch) · `clipboard-shortcut` empty · `clipboard-panel-icon` on · `clipboard-history-size` 25 (pinned items do not count and never expire) · `clipboard-images` on (over 5 MB never kept) · `clipboard-persist` on · `clipboard-ignore-sensitive` on · `clipboard-excluded-apps` empty.

## Privacy and limits
- History is saved in `~/.local/share/guava/clipboard/` (files readable only by you, images as separate files), because Guava tears down on every screen lock. Clear History and Remove delete the files. Turn `clipboard-persist` off to keep history in memory only.
- Nothing is recorded while the screen is locked. Copies marked secret and copies from password managers are skipped.
- It watches the selection `owner-changed` signal; there is no polling.
