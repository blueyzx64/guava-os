// SPDX-License-Identifier: GPL-3.0-or-later
// The green button (macOS): a click on the maximize button of an app's own titlebar enters full
// screen; on a full-screen window it leaves full screen. Pure decision logic for greenButton.js.
//
// The buttons are drawn by the apps, so Mutter only sees a maximize (or unmaximize) request.
// What tells the green button apart from the other ways to maximize (prototyped in Shell 50.6):
//   - a request from the app (button, double-click on the titlebar) arrives with no current
//     Clutter event; Super+Up and Shell menus (window menu, app menu Zoom) run inside a key or
//     button event, Guava's own calls inside one too, or with the pointer elsewhere;
//   - a drag (unmaximize by drag, drag to the top) is a grab op;
//   - an app restoring its maximized state at start does so right after it maps;
//   - the button itself sits in a band at the top of the frame, on the side of the buttons:
//     the pointer is there at the click. A double-click elsewhere on the titlebar stays Zoom
//     (maximize), as on macOS.

/** Height of the band at the top of the frame that holds the titlebar buttons (px). */
export const TITLEBAR_PX = 56;
/** Width given to each button on its side of the titlebar, plus the margin to the edge (px). */
export const BUTTON_PX = 48;
export const EDGE_PAD_PX = 24;
/** A window this young is still starting: its maximize requests are its saved state (ms). */
export const SETTLE_MS = 1000;

/**
 * The band of the frame where the titlebar buttons are, or null when the layout has no
 * maximize button.
 *
 * @param {{x: number, y: number, width: number, height: number}} frame
 * @param {{buttons: string[], side: 'left'|'right'}} layout parseButtonLayout() of the WM layout
 * @returns {?{x: number, y: number, width: number, height: number}}
 */
export function buttonBand(frame, layout) {
    if (!frame || !layout?.buttons?.includes('maximize'))
        return null;
    const width = Math.min(frame.width, layout.buttons.length * BUTTON_PX + EDGE_PAD_PX);
    const height = Math.min(frame.height, TITLEBAR_PX);
    const x = layout.side === 'left' ? frame.x : frame.x + frame.width - width;
    return { x, y: frame.y, width, height };
}

function inside(p, r) {
    return !!p && !!r && p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/**
 * What a change of a window's maximized state means.
 *
 * @param {object} s
 * @param {boolean} s.maximized maximized both ways now
 * @param {boolean} s.wasMaximized before this change
 * @param {boolean} s.fullscreen
 * @param {boolean} s.hasEvent a Clutter event is being handled (keyboard, Shell UI)
 * @param {boolean} s.grabbing a window grab op is active (drag, resize)
 * @param {number} s.ageMs since the window appeared (Infinity when unknown)
 * @param {?{x: number, y: number}} s.pointer
 * @param {?{x: number, y: number, width: number, height: number}} s.band buttonBand() of the frame
 * @returns {?('enter'|'leave')} enter or leave full screen (the maximized state goes back to
 *   wasMaximized first), or null to leave the change alone
 */
export function greenButtonAction(s) {
    if (s.maximized === s.wasMaximized || s.hasEvent || s.grabbing || !(s.ageMs >= SETTLE_MS))
        return null;
    if (!inside(s.pointer, s.band))
        return null;
    return s.fullscreen ? 'leave' : 'enter';
}
