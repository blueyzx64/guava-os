// SPDX-License-Identifier: GPL-3.0-or-later
// Pure decisions behind lib/compat.js, so they run under plain `gjs -m` tests.

/**
 * Where to read "reduce motion" from, best first:
 * - 'st':    St.Settings `reduced-motion` property (GNOME 51; an St.ReducedMotion enum)
 * - 'a11y':  org.gnome.desktop.a11y.interface `reduced-motion` (gsettings-desktop-schemas 50+;
 *            an enum: 'no-preference' | 'reduce')
 * - 'iface': org.gnome.desktop.interface `enable-animations`, inverted (48-49)
 *
 * @param {{st: boolean, a11y: boolean, iface: boolean}} has which sources exist
 * @returns {'st'|'a11y'|'iface'|null}
 */
export function pickReducedMotionSource(has) {
    if (has.st)
        return 'st';
    if (has.a11y)
        return 'a11y';
    if (has.iface)
        return 'iface';
    return null;
}

/**
 * @param {'st'|'a11y'|'iface'|null} kind
 * @param {object} obj St.Settings for 'st', the Gio.Settings of that schema otherwise
 * @param {number} [reduceValue] St.ReducedMotion.REDUCE, for 'st'
 * @returns {boolean}
 */
export function readReducedMotion(kind, obj, reduceValue = 1) {
    switch (kind) {
    case 'st':
        return obj.reduced_motion === reduceValue;
    case 'a11y':
        return obj.get_string('reduced-motion') === 'reduce';
    case 'iface':
        return !obj.get_boolean('enable-animations');
    default:
        return false;
    }
}

/** Signal to watch on the source object for changes. */
export function reducedMotionSignal(kind) {
    return {
        st: 'notify::reduced-motion',
        a11y: 'changed::reduced-motion',
        iface: 'changed::enable-animations',
    }[kind] ?? null;
}

/**
 * The X11 window id in a Meta.Window description: X11 windows describe themselves as
 * '0x2a00004' (some versions add the title after it). Mutter 50 has no get_xwindow() in its
 * introspection, so this is how DBusMenu's registrar ids are matched to windows.
 *
 * @param {?string} desc Meta.Window.get_description()
 * @returns {?number}
 */
export function xidFromDescription(desc) {
    const m = /^0x([0-9a-f]+)/i.exec(desc ?? '');
    return m ? parseInt(m[1], 16) : null;
}
