// SPDX-License-Identifier: GPL-3.0-or-later
// The desktop actions hot corners and gestures can run (macOS Desktop & Dock ▸ Hot Corners,
// Trackpad ▸ More Gestures). core/desktopActions.js runs them; this file is the pure list.
//
// Pure JS (no gi imports).

/**
 * Action ids, in the order prefs lists them. macOS also has Start/Disable Screen Saver and
 * Quick Note; GNOME has no screen saver and no system notes app, so they are left out.
 */
export const DESKTOP_ACTIONS = Object.freeze([
    'none',
    'mission-control',
    'app-expose',          // "Application Windows"
    'desktop',
    'notification-center',
    'launchpad',
    'lock-screen',
    'display-sleep',
]);

/** @returns {string} `id` when it is a known action, else 'none' */
export function normalizeAction(id) {
    return DESKTOP_ACTIONS.includes(id) ? id : 'none';
}

/**
 * Whether an action may run in a Shell action mode.
 *
 * @param {string} action
 * @param {{overview: boolean, locked: boolean}} state
 * @returns {boolean}
 */
export function actionAllowed(action, { overview, locked }) {
    if (locked || action === 'none')
        return false;
    // From Mission Control, only Mission Control (to close it) and the screen actions run;
    // the others would stack a second full-screen view on it.
    if (overview)
        return action === 'mission-control' || action === 'lock-screen' || action === 'display-sleep';
    return true;
}
