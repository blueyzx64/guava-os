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

/**
 * Which of the offered clipboard types to save before Guava borrows the clipboard.
 *
 * @param {string[]} offered mime types
 * @returns {?string} null when nothing worth keeping is there
 */
export function mimeToKeep(offered) {
    const list = offered ?? [];
    return KEEP_MIMES.find(m => list.includes(m)) ?? null;
}

/** Whether a saved clipboard of `size` bytes is small enough to hold and give back. */
export function canKeep(size) {
    return size > 0 && size <= KEEP_MAX_BYTES;
}
