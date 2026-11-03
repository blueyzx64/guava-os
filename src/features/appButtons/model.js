// SPDX-License-Identifier: GPL-3.0-or-later
// Pure logic for the apps' own titlebar buttons (layout, look, GTK sheets). No gi imports, so it runs under `gjs -m` tests.

export const VALID_BUTTONS = ['close', 'minimize', 'maximize'];
export const MACOS_ORDER = ['close', 'minimize', 'maximize'];
export const SYSTEM_RIGHT_ORDER = ['minimize', 'maximize', 'close'];

/**
 * Parse a WM button-layout such as 'appmenu:minimize,maximize,close'.
 * The side with more control buttons wins; a tie goes to the left only when it has any,
 * otherwise to the right (GNOME default).
 *
 * @param {string} layoutStr
 * @returns {{buttons: string[], side: 'left'|'right'}}
 */
export function parseButtonLayout(layoutStr) {
    const parts = String(layoutStr ?? '').split(':');
    const pick = part => (part ?? '').split(',')
        .map(b => b.trim())
        .filter(b => VALID_BUTTONS.includes(b));
    const left = pick(parts[0]);
    const right = pick(parts[1]);

    let side;
    let ordered;
    if (left.length >= right.length && left.length > 0) {
        side = 'left';
        ordered = left;
    } else if (right.length > 0) {
        side = 'right';
        ordered = right;
    } else {
        side = 'right';
        ordered = SYSTEM_RIGHT_ORDER;
    }
    return { buttons: [...new Set(ordered)], side };
}

/**
 * The WM button-layout Guava sets: the apps' own buttons on
 * the chosen side, at its outer edge (right: minimize,maximize,close; left: close,minimize,
 * maximize, macOS order), or close alone with set 'close'. The other entries of `original`
 * (appmenu, icon, spacer) are kept. When the buttons move to the other side than the original
 * had them, the whole layout is mirrored, so the app menu stays opposite the buttons:
 * 'appmenu:close' -> right 'appmenu:minimize,maximize,close', left 'close,minimize,maximize:appmenu'.
 *
 * @param {string} original the user's layout
 * @param {{position?: string, set?: string}} opts position 'right' | 'left', set 'all' | 'close'
 * @returns {string}
 */
export function appButtonsLayout(original, { position = 'right', set = 'all' } = {}) {
    const parts = String(original ?? '').split(':');
    const extras = part => (part ?? '').split(',')
        .map(b => b.trim())
        .filter(b => b && !VALID_BUTTONS.includes(b));
    let left = extras(parts[0]);
    let right = extras(parts[1]);
    const side = position === 'left' ? 'left' : 'right';
    if (side !== parseButtonLayout(original).side)
        [left, right] = [right.reverse(), left.reverse()];
    if (side === 'right')
        right = [...right, ...(set === 'close' ? ['close'] : SYSTEM_RIGHT_ORDER)];
    else
        left = [...(set === 'close' ? ['close'] : MACOS_ORDER), ...left];
    return `${left.join(',')}:${right.join(',')}`;
}

/**
 * The GTK stylesheets (in gtk/) Guava imports into ~/.config/gtk-<version>.0/gtk.css, in
 * order: one traffic-light set (titlebuttons<v>.css, plus its small size) when the style is
 * 'macos', then the app fixes of popup-menu-styling (last, so they can override the rest).
 *
 * @param {{style: string, size: string, appFixes: boolean}} config
 * @param {'3'|'4'} version GTK major version
 * @returns {string[]} file names
 */
export function gtkSheets(config, version) {
    const sheets = [];
    if (config.style === 'macos') {
        sheets.push(`titlebuttons${version}.css`);
        if (config.size === 'small')
            sheets.push(`titlebuttons-size-small${version}.css`);
    }
    if (config.appFixes)
        sheets.push(`fixes${version}.css`);
    return sheets;
}
