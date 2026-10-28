// SPDX-License-Identifier: GPL-3.0-or-later
// The macOS app switcher (Cmd-Tab, here Super+Tab) and window cycler (Cmd-`, Super+`):
// selection, keys and what activating an app does. Values in, values out.
//
// Pure JS (no gi imports); tests/switcherModel.test.js.

/**
 * Apps in the switcher: every running app, most recently used first (core/desktop's MRU),
 * including hidden apps and apps whose windows are all minimized, like macOS.
 *
 * @param {string[]} mruAppIds running app ids, most recent first
 * @param {(id: string) => boolean} [known] false for ids the Shell cannot show (no app)
 * @returns {string[]}
 */
export function switcherApps(mruAppIds, known = () => true) {
    const out = [];
    for (const id of mruAppIds) {
        if (id && !out.includes(id) && known(id))
            out.push(id);
    }
    return out;
}

/**
 * The first selection. A tap of Super+Tab goes back to the previous app: the item after the
 * front app. With no front app (the desktop has focus) the first item is the target.
 *
 * @param {number} count
 * @param {{backward?: boolean, frontIsFirst?: boolean}} [opts]
 * @returns {number} -1 when there is nothing to show
 */
export function initialIndex(count, { backward = false, frontIsFirst = true } = {}) {
    if (count <= 0)
        return -1;
    if (backward)
        return count - 1;
    if (count === 1 || !frontIsFirst)
        return 0;
    return 1;
}

/** Move the selection by `delta`, wrapping around. */
export function step(index, count, delta) {
    if (count <= 0)
        return -1;
    return ((index + delta) % count + count) % count;
}

/** The selection after the item at `removed` left (an app quit while the switcher was open). */
export function indexAfterRemoval(index, removed, countAfter) {
    if (countAfter <= 0)
        return -1;
    if (removed < index)
        return index - 1;
    return Math.min(index, countAfter - 1);
}

/**
 * The app to activate at release when H hid some apps while the panel was open: the
 * selected app unless it was just hidden, else the most recent one that was not.
 *
 * @param {number} index the selection
 * @param {boolean[]} hidden per item: H hid it while the panel was open
 * @returns {number} -1: every app was hidden, activate nothing
 */
export function pickAfterHide(index, hidden) {
    if (!hidden[index])
        return index;
    return hidden.findIndex(h => !h);
}

/**
 * What a key does while the switcher is open (macOS: Tab/⇧Tab/` move, arrows move, Q quits,
 * H hides, ↓ or ↑ shows the app's windows, Esc or . cancels, Return activates). Guava also
 * takes 1 for App Exposé (the brief's "Down arrow or 1").
 *
 * @param {string} key a key name: 'Tab', 'ISO_Left_Tab', 'grave', 'Left', 'Right', 'Up',
 *   'Down', 'q', 'h', '1', 'Escape', 'period', 'Return', 'space', ...
 * @param {{shift?: boolean, rtl?: boolean}} [mods]
 * @returns {?('next'|'previous'|'quit'|'hide'|'expose'|'cancel'|'activate')} null: not ours
 */
export function keyAction(key, { shift = false, rtl = false } = {}) {
    switch (key) {
    case 'Tab':
        return shift ? 'previous' : 'next';
    case 'ISO_Left_Tab':
    case 'grave':
    case 'dead_grave':
        return 'previous';
    case 'Left':
        return rtl ? 'next' : 'previous';
    case 'Right':
        return rtl ? 'previous' : 'next';
    case 'Up':
    case 'Down':
    case '1':
    case 'KP_1':
        return 'expose';
    case 'q':
    case 'Q':
        return 'quit';
    case 'h':
    case 'H':
        return 'hide';
    case 'Escape':
    case 'period':
        return 'cancel';
    case 'Return':
    case 'KP_Enter':
    case 'ISO_Enter':
    case 'space':
        return 'activate';
    }
    return null;
}

/**
 * What activating an app does with its windows.
 *
 * @param {{id: number, workspace: number, minimized: boolean, hidden: boolean}[]} windows
 *   the app's user-facing windows, most recent first; workspace -1 is on every Space;
 *   hidden: Hide put it away (macOS ⌘H), not the user's minimize
 * @param {{active: number, switchToSpace: boolean, restoreMinimized: boolean}} opts
 *   switchToSpace: macOS "When switching to an application, switch to a Space with open
 *   windows for the application"; restoreMinimized: un-minimize when nothing else shows
 *   (macOS does it only with ⌥ held at release)
 * @returns {{kind: 'focus', windowId: number, unhide: number[]} |
 *   {kind: 'new-window', unhide: number[]} | {kind: 'none', unhide: number[]}}
 *   unhide: hidden windows to bring back first (activating a hidden app unhides it)
 */
export function planActivation(windows, { active, switchToSpace, restoreMinimized }) {
    const unhide = windows.filter(w => w.hidden).map(w => w.id);
    const shown = w => !w.minimized || w.hidden;
    const onSpace = w => w.workspace === active || w.workspace === -1;

    const here = windows.find(w => shown(w) && onSpace(w));
    if (here)
        return { kind: 'focus', windowId: here.id, unhide };
    const elsewhere = windows.find(w => shown(w));
    if (elsewhere && switchToSpace)
        return { kind: 'focus', windowId: elsewhere.id, unhide };
    if (elsewhere)
        return { kind: 'new-window', unhide };
    const minimized = windows.find(w => w.minimized);
    if (minimized && restoreMinimized) {
        const local = windows.find(w => w.minimized && onSpace(w));
        const pick = local ?? (switchToSpace ? minimized : null);
        if (pick)
            return { kind: 'focus', windowId: pick.id, unhide };
    }
    return { kind: 'none', unhide };
}

/** Icon sizes the panel picks from, largest first (macOS shows 128 px icons on wide screens). */
export const ICON_SIZES = Object.freeze([128, 112, 96, 80, 64, 48, 32]);

/**
 * The largest icon size that fits `count` items in `availWidth` (px, logical).
 *
 * @param {number} count
 * @param {number} availWidth the monitor width minus the margins the panel keeps
 * @param {number} itemExtra px each item adds around its icon (padding and spacing)
 * @returns {number}
 */
export function iconSizeFor(count, availWidth, itemExtra) {
    for (const size of ICON_SIZES) {
        if (Math.max(count, 1) * (size + itemExtra) <= availWidth)
            return size;
    }
    return ICON_SIZES[ICON_SIZES.length - 1];
}
