// SPDX-License-Identifier: GPL-3.0-or-later
// Pure decisions for typing into another app's window (lib/paste.js does it): which paste
// chord the window wants, and which clipboard type to keep and give back around a paste.

const TERMINAL_HINTS = [
    'gnome-terminal', 'kgx', 'org.gnome.console', 'org.gnome.terminal', 'ptyxis',
    'org.gnome.ptyxis', 'tilix', 'kitty', 'alacritty', 'xterm', 'konsole', 'terminator',
    'foot', 'wezterm', 'org.wezfurlong.wezterm', 'xfce4-terminal', 'urxvt', 'st-256color',
    'guake', 'yakuake', 'terminology', 'cool-retro-term', 'blackbox', 'com.raggesilver.blackbox',
    'contour', 'rio', 'ghostty', 'com.mitchellh.ghostty',
];

/** Which paste chord the previous focus wants (WM class or app id): terminals use Ctrl+Shift+V. */
export function pasteChordFor(wmClass) {
    const k = typeof wmClass === 'string' ? wmClass.trim().toLowerCase() : '';
    return k && TERMINAL_HINTS.some(t => k === t || k.endsWith(`.${t}`)) ? 'ctrl-shift-v' : 'ctrl-v';
}

/** The keys of a chord, pressed in order and released in reverse (Clutter KEY_ names). */
export function chordKeys(chord) {
    return chord === 'ctrl-shift-v' ? ['Control_L', 'Shift_L', 'V'] : ['Control_L', 'v'];
}

// Text first (what people paste most), then images; St.Clipboard can give back one type
const KEEP_MIMES = [
    'text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING',
    'image/png', 'image/jpeg', 'text/html', 'text/uri-list',
];
export const KEEP_MAX_BYTES = 32 * 1024 * 1024;

/** Mime types a password manager adds to mark a secret (KeePassXC, Klipper/CopyQ convention). */
export const SECRET_HINT_MIMES = Object.freeze(['x-kde-passwordManagerHint']);

/**
 * Which of the offered clipboard types to save before Guava borrows the clipboard.
 *
 * @param {string[]} offered mime types
 * @returns {?string} null when nothing worth keeping is there
 */
export function mimeToKeep(offered) {
    const list = offered ?? [];
    // A secret is never copied around: the hint mime cannot travel with it, so a restored copy
    // would be plain text that the clipboard history records
    if (SECRET_HINT_MIMES.some(m => list.includes(m)))
        return null;
    return KEEP_MIMES.find(m => list.includes(m)) ?? null;
}

/** Whether a saved clipboard of `size` bytes is small enough to hold and give back. */
export function canKeep(size) {
    return size > 0 && size <= KEEP_MAX_BYTES;
}

/**
 * Tracks "Guava has borrowed the clipboard": from the moment it writes its own text until a
 * short while after it gives the old content back. The clipboard history ignores owner
 * changes in that window, so a borrowed emoji or a restored copy is not recorded as a copy.
 */
export class ClipboardBorrow {
    constructor(quietMs = 400) {
        this._quietMs = quietMs;
        this._open = 0;
        this._until = 0;
    }

    begin() {
        this._open++;
    }

    /** @param {number} now monotonic ms; owner changes up to quietMs later still count as ours */
    end(now) {
        if (this._open > 0)
            this._open--;
        this._until = Math.max(this._until, now + this._quietMs);
    }

    active(now) {
        return this._open > 0 || now < this._until;
    }
}
