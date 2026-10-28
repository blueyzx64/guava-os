// SPDX-License-Identifier: GPL-3.0-or-later
// Pure decisions for typography (no gi:// imports; unit-tested under plain gjs).
//
// macOS draws text with San Francisco, unhinted, with grayscale antialiasing (no subpixel
// colour fringes since Mojave). Guava can't ship San Francisco (Apple's licence): it uses SF Pro
// when the user installed it, else Inter, the open typeface drawn after it (Fedora:
// rsms-inter-vf-fonts). The font size stays the user's.

/** UI families, best first: Apple's own, then Inter (variable, then static). */
export const UI_FAMILIES = Object.freeze(['SF Pro', 'SF Pro Text', 'Inter Variable', 'Inter']);
/** Monospace families: only Apple's own (a coding font is the user's choice otherwise). */
export const MONO_FAMILIES = Object.freeze(['SF Mono']);
/** The Fedora package that brings Inter (offered by the preferences). */
export const INTER_PACKAGE = 'rsms-inter-vf-fonts';

/** org.gnome.desktop.interface values that render text like macOS. */
export const MACOS_RENDERING = Object.freeze({
    'font-hinting': 'none',
    'font-antialiasing': 'grayscale',
});

/**
 * The first of `wanted` that is installed (case-insensitive), with its installed spelling.
 *
 * @param {string[]} installed family names (fc-list : family, one per entry)
 * @param {readonly string[]} wanted
 * @returns {?string}
 */
export function pickFamily(installed, wanted) {
    const byLower = new Map();
    for (const f of installed ?? [])
        byLower.set(String(f).trim().toLowerCase(), String(f).trim());
    for (const w of wanted) {
        const hit = byLower.get(w.toLowerCase());
        if (hit)
            return hit;
    }
    return null;
}

/**
 * Family names out of `fc-list : family` output. A font with localized names lists them
 * comma-separated on one line; each counts.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseFcList(text) {
    const out = new Set();
    for (const line of String(text ?? '').split('\n')) {
        for (const name of line.split(',')) {
            const n = name.replace(/\\-/g, '-').trim();
            if (n)
                out.add(n);
        }
    }
    return [...out];
}

/**
 * The size of a Pango font description string ("Adwaita Sans 11", "Cantarell Bold 10.5").
 *
 * @param {string} desc
 * @returns {?number} points, null when the string names none
 */
export function fontSize(desc) {
    const m = /\s(\d+(?:\.\d+)?)(px)?\s*$/.exec(String(desc ?? ''));
    if (!m || m[2])
        return null;
    return Number(m[1]);
}

/**
 * `family` at the size of the user's `original` description (or `fallbackSize`).
 *
 * @param {string} original the user's value of the key
 * @param {string} family
 * @param {number} fallbackSize
 * @returns {string}
 */
export function withFamily(original, family, fallbackSize) {
    const size = fontSize(original) ?? fallbackSize;
    return `${family} ${size}`;
}

/**
 * The fonts Guava sets, from what is installed.
 *
 * @param {string[]} installed
 * @returns {{ui: ?string, mono: ?string}}
 */
export function plan(installed) {
    return { ui: pickFamily(installed, UI_FAMILIES), mono: pickFamily(installed, MONO_FAMILIES) };
}
