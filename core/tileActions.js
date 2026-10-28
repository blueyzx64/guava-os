// SPDX-License-Identifier: GPL-3.0-or-later
// The vocabulary of window tiling, shared by everything that asks for a tile: the zones (as
// fractions of a work area), the multi-window arrangements and the action strings of the
// 'window-tile-requested' event (core/events.js). The tiling engine (features/windows) acts on them;
// the drag snap bar (features/windows) and the menu bar's Window menu draw and request them. Pure JS, no gi imports.

// Marks a string for translation; the view translates it
const N_ = s => s;

/** Single-window tiles, as fractions of the work area. */
export const ZONES = Object.freeze({
    'fill': Object.freeze({ x: 0, y: 0, w: 1, h: 1 }),
    'left': Object.freeze({ x: 0, y: 0, w: 1 / 2, h: 1 }),
    'right': Object.freeze({ x: 1 / 2, y: 0, w: 1 / 2, h: 1 }),
    'top': Object.freeze({ x: 0, y: 0, w: 1, h: 1 / 2 }),
    'bottom': Object.freeze({ x: 0, y: 1 / 2, w: 1, h: 1 / 2 }),
    'top-left': Object.freeze({ x: 0, y: 0, w: 1 / 2, h: 1 / 2 }),
    'top-right': Object.freeze({ x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2 }),
    'bottom-left': Object.freeze({ x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2 }),
    'bottom-right': Object.freeze({ x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2 }),
    'left-third': Object.freeze({ x: 0, y: 0, w: 1 / 3, h: 1 }),
    'center-third': Object.freeze({ x: 1 / 3, y: 0, w: 1 / 3, h: 1 }),
    'right-third': Object.freeze({ x: 2 / 3, y: 0, w: 1 / 3, h: 1 }),
    'left-two-thirds': Object.freeze({ x: 0, y: 0, w: 2 / 3, h: 1 }),
    'right-two-thirds': Object.freeze({ x: 1 / 3, y: 0, w: 2 / 3, h: 1 }),
});

/**
 * Multi-window arrangements (Fill & Arrange): the zones in order, the first for the active
 * window, the rest for the next most recently used windows. macOS 15 names in comments.
 */
export const ARRANGEMENTS = Object.freeze({
    'left-right': Object.freeze(['left', 'right']),                         // Left & Right
    'right-left': Object.freeze(['right', 'left']),                         // Right & Left
    'top-bottom': Object.freeze(['top', 'bottom']),                         // Top & Bottom
    'bottom-top': Object.freeze(['bottom', 'top']),                         // Bottom & Top
    'quarters': Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    'left-quarters': Object.freeze(['left', 'top-right', 'bottom-right']),   // Left & Quarters
    'right-quarters': Object.freeze(['right', 'top-left', 'bottom-left']),   // Right & Quarters
    'top-quarters': Object.freeze(['top', 'bottom-left', 'bottom-right']),   // Top & Quarters
    'bottom-quarters': Object.freeze(['bottom', 'top-left', 'top-right']),   // Bottom & Quarters
});

/**
 * Parse a tiling action (the payload of the 'window-tile-requested' event and the shortcuts): a zone name, 'center', 'restore', or 'arrange-<arrangement>'.
 *
 * @param {string} action
 * @returns {?{kind: 'zone'|'center'|'restore'|'arrange', name?: string}}
 */
export function parseAction(action) {
    if (typeof action !== 'string')
        return null;
    if (action in ZONES)
        return { kind: 'zone', name: action };
    if (action === 'center' || action === 'restore')
        return { kind: action };
    if (action.startsWith('arrange-') && action.slice(8) in ARRANGEMENTS)
        return { kind: 'arrange', name: action.slice(8) };
    return null;
}

/**
 * The layouts of the snap bar (the drag-to-top picker, Windows 11 Snap Layouts): each splits the
 * screen into zones, every zone a key of ZONES (so each one is also a tile action). Windows 11's
 * set, in its order. A new layout is a new entry; the bar sizes itself to the list. The names
 * are gettext keys (marked with N_) for the accessible labels.
 */
export const SNAP_LAYOUTS = Object.freeze([
    Object.freeze({ id: 'halves', name: N_('Two Halves'), zones: Object.freeze(['left', 'right']) }),
    Object.freeze({
        id: 'wide-left', name: N_('Two Thirds and One Third'),
        zones: Object.freeze(['left-two-thirds', 'right-third']),
    }),
    Object.freeze({
        id: 'wide-right', name: N_('One Third and Two Thirds'),
        zones: Object.freeze(['left-third', 'right-two-thirds']),
    }),
    Object.freeze({
        id: 'thirds', name: N_('Three Columns'),
        zones: Object.freeze(['left-third', 'center-third', 'right-third']),
    }),
    Object.freeze({
        id: 'main-left', name: N_('Large Left and Two Stacked'),
        zones: Object.freeze(['left', 'top-right', 'bottom-right']),
    }),
    Object.freeze({
        id: 'quarters', name: N_('Four Quarters'),
        zones: Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    }),
]);
