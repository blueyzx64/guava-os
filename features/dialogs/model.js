// SPDX-License-Identifier: GPL-3.0-or-later
// macOS-style alerts for the Shell's modal dialogs: which dialog it is and the icon on top.
// Pure (no gi imports).

// EndSessionDialog's DialogType (js/ui/endSessionDialog.js, the same in 48.0-50.0 and main)
const END_SESSION_ICONS = Object.freeze({
    0: 'system-log-out-symbolic',    // LOGOUT
    1: 'system-shutdown-symbolic',   // SHUTDOWN
    2: 'system-reboot-symbolic',     // RESTART
    3: 'system-software-install-symbolic', // UPDATE_RESTART
    4: 'system-software-install-symbolic', // UPGRADE_RESTART
});

/**
 * Which Shell dialog a card is, from the style classes of its `.modal-dialog` box.
 *
 * @param {string} styleClass the box's style_class
 * @returns {'end-session'|'auth'|'run'|'other'}
 */
export function dialogKind(styleClass) {
    const classes = (styleClass ?? '').split(/\s+/);
    if (classes.includes('end-session-dialog'))
        return 'end-session';
    if (classes.includes('prompt-dialog'))
        return 'auth';
    if (classes.includes('run-dialog'))
        return 'run';
    return 'other';
}

/**
 * The icon on top of the card, like the app icon of a macOS alert; null for dialogs that
 * bring their own picture (other extensions', Guava's About This PC).
 *
 * @param {string} kind dialogKind()
 * @param {?number} endSessionType EndSessionDialog._type while it opens
 * @returns {?string}
 */
export function dialogIcon(kind, endSessionType = null) {
    switch (kind) {
    case 'end-session':
        return END_SESSION_ICONS[endSessionType] ?? 'system-shutdown-symbolic';
    case 'auth':
        return 'dialog-password-symbolic';
    case 'run':
        return 'system-run-symbolic';
    default:
        return null;
    }
}
