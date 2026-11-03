# Clipboard: St.Clipboard, Meta.Selection, history, images, privacy

Summary: read and write the clipboard with `St.Clipboard`, detect changes without polling via `Meta.Selection` `owner-changed`, and handle images and other MIME types.
It also covers storing history safely and respecting password-manager hints, and it lists the EGO rules that apply specifically to clipboard extensions.
Verified against gnome-shell `src/st/st-clipboard.h`, mutter `src/meta/meta-selection.h`, `meta-selection-source.h` and `display.h` (main), the Clipboard Indicator extension (Tudmotu, master) and the EGO review guideline text.

## Contents
1. APIs
2. Detecting changes
3. Reading text, images, HTML
4. Writing (restore an entry)
5. History storage and persistence
6. Privacy and EGO rules
7. Pitfalls
8. Sources

## 1. APIs
`St.Clipboard` (singleton `St.Clipboard.get_default()`):
| Method | Notes |
|---|---|
| `get_text(type, (clipboard, text) => {})` | Async callback. `type` is `St.ClipboardType.CLIPBOARD` or `PRIMARY`. |
| `set_text(type, text)` | |
| `get_mimetypes(type)` | Returns a JS array of strings (`GList` of utf8). |
| `get_content(type, mimetype, (clipboard, bytes) => {})` | `bytes` is a `GLib.Bytes` or null. |
| `set_content(type, mimetype, bytes)` | Takes `GLib.Bytes`. |

`Meta.Selection` (`global.display.get_selection()`):
- Signal `owner-changed(selection, selectionType, selectionSource)`, where
  `selectionType` is `Meta.SelectionType.SELECTION_PRIMARY`,
  `SELECTION_CLIPBOARD` or `SELECTION_DND`. The source can be null when the
  owner was unset.
- `get_mimetypes(type)`, and `transfer_async(type, mimetype, size, outputStream, cancellable, cb)`
  with `transfer_finish` for streaming large payloads. `set_owner` and
  `unset_owner` exist too.
- `St.Clipboard` is a thin wrapper over this selection
  (`st_clipboard_set_selection`).

## 2. Detecting changes (no polling)
```js
// enable()
this._clipboard = St.Clipboard.get_default();
this._selection = global.display.get_selection();
this._selection.connectObject('owner-changed', (_sel, type, _source) => {
    if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
        this._queueRead();
}, this);
// disable()
this._selection.disconnectObject(this);
this._selection = null; this._clipboard = null;
this._cancellable?.cancel();
```
Clipboard Indicator does exactly this (`_setupSelectionTracking`), plus a
re-entrancy guard (`#refreshInProgress`) and a `_destroyed` check after every
await. Older extensions poll `get_text()` on a timer. Don't: it wakes the
Shell, and reviewers flag it.

## 3. Reading text, images, HTML
```js
const PREFERRED = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'text/html'];

function getContent(clipboard, mime) {
    return new Promise(resolve =>
        clipboard.get_content(St.ClipboardType.CLIPBOARD, mime,
            (_c, bytes) => resolve(bytes && bytes.get_size() > 0 ? bytes : null)));
}

async _read() {
    const offered = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
    if (offered.includes('x-kde-passwordManagerHint'))   // see §6
        return;
    const mime = PREFERRED.find(m => offered.includes(m));
    if (!mime) return;
    const bytes = await getContent(this._clipboard, mime);
    if (!this._enabled || !bytes) return;
    if (mime.startsWith('image/')) this._addImage(mime, bytes);
    else this._addText(new TextDecoder().decode(bytes.toArray()));
}
```
- Ask `get_mimetypes()` first instead of probing every type. Clipboard
  Indicator probes a list in order, which costs one transfer per miss.
- Some apps re-offer text as `UTF8_STRING` only (an Xwayland/legacy path).
  Normalize it to `text/plain;charset=utf-8` when storing (Clipboard Indicator
  comment citing https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233,
  "get_content() only returns text/plain;charset=utf-8 … for the first item").
- Images: show a thumbnail with
  `St.Icon({gicon: Gio.BytesIcon.new(bytes)})`, or an `St.ImageContent` from a
  `GdkPixbuf` loaded with `new_from_stream_at_scale_async`. Guava already
  promisifies that in `(Kiwi: apps/mediaPlayback.js; Guava equivalent not verified)`. Cap the size, for example skip
  anything over 5 MB.
- Files copied in Nautilus: `x-special/gnome-copied-files` plus a `GdkFileList`,
  which GTK 4 serializes as `text/uri-list` (nautilus-clipboard.c,
  gdkcontentserializer.c). Other apps vary, so inspect `get_mimetypes()`.

## 4. Writing (restore an entry)
```js
this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
// or, for any MIME type:
this._clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mime, entry.bytes /* GLib.Bytes */);
```
- Setting the clipboard emits `owner-changed` again. Ignore your own write
  (compare with the last entry, or set a flag) or you will create duplicates.
- "Paste on select": the Shell cannot inject Ctrl+V into apps without
  virtual-input hacks. Guava should set the clipboard and close, and let the
  user paste.
- `PRIMARY` (middle-click) is separate. Mirror it only if the user opts in.

## 5. History storage and persistence
- Keep the history in memory. Persist it only if the user opts in, under
  `GLib.get_user_cache_dir()/guava/clipboard/` (or `get_user_data_dir()`), using
  async Gio (`replace_contents_bytes_async`, promisified as in
  `features/launchpad/index.js`). Never use synchronous file I/O in the Shell
  (EGO-X-004).
- Store text as JSON. Store images as separate files named by checksum
  (`GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes)`).
- Enforce a maximum count and a maximum byte size. Provide "Clear history".
  Clear the in-memory history on `disable()`, because disable also runs at
  screen lock.
- Don't store anything while the screen is locked or in `unlock-dialog` mode.
  Stick to the `user` session mode.
- Settings keys: `clipboard-history-enabled`, `clipboard-history-size`,
  `clipboard-persist` and `clipboard-shortcut` (an `as` key, **empty
  default**).

## 6. Privacy and EGO rules
- **Clipboard access must be declared** in the `metadata.json` description, for
  example "Clipboard history: reads and stores clipboard contents locally". An
  extension MUST NOT share clipboard data with a third party without explicit
  user interaction, and MUST NOT ship default keyboard shortcuts for
  clipboard interaction (gjs.guide review guidelines, section "Clipboard Access
  must be declared"). shexli flags every `St.Clipboard.get_default()` call for
  manual review (EGO-A-005).
- **Password-manager hint:** KeePassXC adds the MIME type
  `x-kde-passwordManagerHint` with the data `secret`. Klipper and CopyQ skip
  such entries. Do the same: check `get_mimetypes()`, and optionally read the
  hint and compare it with `secret`. Bitwarden does not set it on Linux
  (community thread), so offer an "excluded apps" list by
  `global.display.focus_window?.get_wm_class()`, as Clipboard Indicator's
  `EXCLUDED_APPS` does.
- Private mode toggle: Clipboard Indicator offers one. It's a cheap and
  user-friendly feature.
- Never log clipboard contents. Not even with `console.debug`.

## 7. Pitfalls
- The `get_content` callback runs after `disable()` if the transfer was slow.
  Always check `_enabled` before touching UI.
- Large payloads: `St.Clipboard.get_content` loads everything into memory. For
  big images use `Meta.Selection.transfer_async` into a
  `Gio.MemoryOutputStream` (`meta_selection_transfer_async(sel, type, mime,
  size, output, cancellable, cb)`; pass a byte cap as `size`, -1 = all). This
  is exactly what st-clipboard.c does internally.
- Fast successive copies: coalesce reads with an idle source and remove it in
  `disable()`.
- `St.Clipboard` instances are a singleton. Don't destroy them. Just drop the
  reference.

## 8. Sources
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/st/st-clipboard.h
- https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/meta/meta-selection.h , .../meta-selection-source.h , src/core/meta-selection.c (owner-changed)
- https://gjs.guide/extensions/review-guidelines/review-guidelines.html (Clipboard Access must be declared)
- https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/blob/master/extension.js
- https://gitlab.gnome.org/GNOME/nautilus/-/blob/main/src/nautilus-clipboard.c (x-special/gnome-copied-files + GdkFileList)
- https://phabricator.kde.org/R120:637cd0bf62e419b8038cb9b1565089fbd341ee7a (Klipper: skip `x-kde-passwordManagerHint` = secret)
- https://community.bitwarden.com/t/linux-prevent-passwords-from-being-stored-in-clipboard-manager-history/94231
- shexli EGO-A-005: https://pypi.org/project/shexli/
