// SPDX-License-Identifier: GPL-3.0-or-later
// Typing into the window that had focus before a Guava popover opened (Quick Paste, Emoji &
// Symbols). Two ways, both through stock Shell API:
//
//   sendPasteChord(win)       Ctrl+V (Ctrl+Shift+V in terminals) from a virtual keyboard, into
//                             `win` only while it still has focus. The Quick Paste technique.
//   commitText(text)          the Shell's input method commits the text to the focused
//                             text-input client (how the on-screen keyboard types an emoji).
//   saveClipboard()/restoreClipboard(saved)
//                             keep what was on the clipboard and give it back after a paste
//                             Guava made with a borrowed clipboard.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { KEEP_MAX_BYTES, canKeep, chordKeys, mimeToKeep, pasteChordFor } from './pasteModel.js';

Gio._promisify(Meta.Selection.prototype, 'transfer_async', 'transfer_finish');

const LOG = '[Guava]';
const KEY_GAP_US = 1000;

/**
 * How long after a Guava modal closes before typing into the app: the Shell gives the app its
 * keyboard (and text-input) focus back when the grab ends, and the app needs a moment to take
 * it before a key or a commit reaches it. Mutter emits nothing an extension can wait on.
 */
export const FOCUS_SETTLE_MS = 160;

/**
 * How long a borrowed clipboard stays borrowed after the paste chord: the app reads the
 * clipboard asynchronously after the key press, and Mutter does not tell an extension when a
 * client has read a selection (GJS cannot implement MetaSelectionSource's read vfuncs), so
 * Guava gives the old content back after this bound.
 */
export const CLIPBOARD_RESTORE_MS = 1000;
const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const KEEP_LIMIT = KEEP_MAX_BYTES + 1;     // one byte over tells "too big" from "exactly"

function _keyboard() {
    const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
    return backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
}

/**
 * Send the paste chord to `win` if it is still the focused window.
 *
 * @param {?Meta.Window} win
 * @returns {boolean} whether the keys went out
 */
export function sendPasteChord(win) {
    try {
        if (!win?.get_compositor_private() || global.display.focus_window !== win)
            return false;
        const keys = chordKeys(pasteChordFor(win.get_wm_class())).map(n => Clutter[`KEY_${n}`]);
        // One device per paste; the local reference is dropped after the key-up
        const dev = _keyboard();
        let t = GLib.get_monotonic_time();
        for (const k of keys)
            dev.notify_keyval(t += KEY_GAP_US, k, Clutter.KeyState.PRESSED);
        for (const k of [...keys].reverse())
            dev.notify_keyval(t += KEY_GAP_US, k, Clutter.KeyState.RELEASED);
        return true;
    } catch (e) {
        console.warn(`${LOG} paste failed: ${e.message}`);
        return false;
    }
}

/**
 * Whether the focused app takes text from the Shell's input method right now: a Wayland
 * text-input client (GTK, Qt, Electron with IME on) has focus, and no Shell entry does.
 */
export function canCommitText() {
    // js/misc/inputMethod.js InputMethod.currentFocus (Shell 45-51)
    return !!Main.inputMethod?.currentFocus && !(global.stage.get_key_focus() instanceof Clutter.Text);
}

/** Commit `text` through the input method; false when no client takes it. */
export function commitText(text) {
    if (!canCommitText())
        return false;
    try {
        Main.inputMethod.commit(text);
        return true;
    } catch (e) {
        console.warn(`${LOG} input method commit failed: ${e.message}`);
        return false;
    }
}

/** Put text on the clipboard. */
export function setClipboardText(text) {
    St.Clipboard.get_default().set_text(CLIPBOARD, text);
}

/**
 * What is on the clipboard now, to give back later (read through Meta.Selection, as the
 * clipboard history does; St.Clipboard.get_content aborts the Shell 50 in some states).
 *
 * @param {?Gio.Cancellable} [cancellable]
 * @returns {Promise<?{mime: string, bytes: GLib.Bytes}>} null for an empty or unusual clipboard
 */
export async function saveClipboard(cancellable = null) {
    const selection = global.display.get_selection();
    const type = Meta.SelectionType.SELECTION_CLIPBOARD;
    const mime = mimeToKeep(selection.get_mimetypes(type));
    if (!mime)
        return null;
    try {
        const out = Gio.MemoryOutputStream.new_resizable();
        await selection.transfer_async(type, mime, KEEP_LIMIT, out, cancellable);
        out.close(null);
        const bytes = out.steal_as_bytes();
        return canKeep(bytes.get_size()) ? { mime, bytes } : null;
    } catch (e) {
        console.debug(`${LOG} clipboard not saved: ${e.message}`);
        return null;
    }
}

/** Give back what saveClipboard() kept (nothing when it kept nothing). */
export function restoreClipboard(saved) {
    if (saved)
        St.Clipboard.get_default().set_content(CLIPBOARD, saved.mime, saved.bytes);
}
