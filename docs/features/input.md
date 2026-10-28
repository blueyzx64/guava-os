# Input: text cursor badges and Emoji & Symbols

## Text cursor indicators (`input-indicator`, on)
A small glass badge at the text cursor when Caps Lock turns on or off (`input-indicator-caps-lock`, on) or the input source changes (`input-indicator-source`, on). It fades out by itself. The cursor position comes from the IBus panel service; in apps that do not report one the badge shows near the pointer. Code: `features/inputIndicator/`, `lib/caret.js`.

## Emoji & Symbols (`emoji-picker`, on)
Super+Ctrl+Space (`emoji-shortcut`) opens a popover at the text cursor (centred when the app reports none) with a searchable emoji grid, recents, categories and skin tones (`emoji-skin-tone`, `emoji-recents`). Choosing an emoji types it into the window that had focus: through the input method when that window is a text-input client (the clipboard is untouched), otherwise by the Quick Paste technique (the emoji goes on the clipboard, a virtual keyboard sends the paste, and the old clipboard comes back). Names and data come from IBus's emoji dictionary. Code: `features/emoji/`, `lib/paste.js`.
