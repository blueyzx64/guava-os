// SPDX-License-Identifier: GPL-3.0-or-later
// OSD router model: what a Shell on-screen display is, and which Guava surface shows it.
// Pure JS (no gi imports): runs under `gjs -m` in tests.
//
// The Shell shows its OSD by calling OsdWindowManager._showOsdWindow(monitor, icon, label,
// level, maxLevel); gsd-media-keys and gsd-power send the volume, brightness and keyboard
// backlight changes that way. core/osd.js intercepts the call, classifies it here and routes it
// to ONE sink, so the notch and the menu-bar pill never both show the same change.

/** The OSDs Guava draws itself. Anything else (keyboard layout, airplane mode) stays GNOME's. */
export const OSD_KINDS = Object.freeze(['volume', 'brightness', 'keyboard-backlight']);

/** Values of the osd-location setting. */
export const OSD_LOCATIONS = Object.freeze(['notch', 'menu-bar', 'system']);

/** Sinks a router can have, in the order they are named by `route`. */
export const OSD_SINKS = Object.freeze(['notch', 'pill']);

const ICON_KINDS = [
    [/^audio-volume-/, 'volume'],
    [/^keyboard-brightness/, 'keyboard-backlight'],
    [/^display-brightness/, 'brightness'],
];

/**
 * Describe one Shell OSD call.
 *
 * @param {{iconNames: string[], level: ?number, maxLevel: ?number}} osd the call's arguments
 *   (`iconNames` are the names of the GThemedIcon, `[]` for other icons)
 * @returns {{kind: string, muted: boolean, fraction: ?number}} kind is an OSD_KINDS entry or
 *   'other'; fraction is the level over its maximum, 0..1, or null when the call has no level
 */
export function classifyOsd({ iconNames, level, maxLevel }) {
    let kind = 'other';
    for (const [pattern, k] of ICON_KINDS) {
        if (iconNames.some(n => pattern.test(n))) {
            kind = k;
            break;
        }
    }
    const hasLevel = Number.isFinite(level) && level >= 0;
    const max = Number.isFinite(maxLevel) && maxLevel > 0 ? maxLevel : 1;
    const fraction = hasLevel ? Math.min(1, level / max) : null;
    const muted = kind === 'volume' &&
        (iconNames.some(n => /muted/.test(n)) || (hasLevel && level === 0));
    return { kind, muted, fraction };
}

/**
 * The one routing decision: which sink shows an OSD of this kind.
 *
 * - Not one of Guava's kinds, or location 'system': the stock OSD.
 * - Location 'notch': the notch when it runs (macOS with a Dynamic Island), else the pill.
 * - Location 'menu-bar': the pill; the notch only if the pill is not running.
 * A sink that is not running is never chosen; with none, the stock OSD shows.
 *
 * @param {{kind: string, location: string, sinks: {notch: boolean, pill: boolean}}} request
 * @returns {'notch'|'pill'|'stock'}
 */
export function route({ kind, location, sinks }) {
    if (!OSD_KINDS.includes(kind) || location === 'system')
        return 'stock';
    if (location === 'notch' && sinks.notch)
        return 'notch';
    if (sinks.pill)
        return 'pill';
    return sinks.notch ? 'notch' : 'stock';
}
