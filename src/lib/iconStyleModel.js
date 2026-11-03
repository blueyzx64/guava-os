// SPDX-License-Identifier: GPL-3.0-or-later
// Icon styles (macOS Tahoe, System Settings > Appearance > Icon & widget style): which stock
// Clutter effects turn an app icon into its Default, Dark, Clear or Tinted look. Pure: the
// Shell side is lib/iconStyle.js.
//
//   Default  no effect
//   Dark     darker, slightly more contrast (the coloured glyph stays readable)
//   Clear    decolourised and a little translucent, lifted in light mode, dimmed in dark mode
//   Tinted   monochrome in the accent colour (ColorizeEffect works on luminance), then lifted
//            so the darker tint does not sink into the glass
//
// At most two effects per icon: each one is an offscreen pass that Clutter caches until the
// icon itself changes, so a still icon costs nothing per frame.

export const ICON_STYLES = Object.freeze(['default', 'dark', 'clear', 'tinted']);
export const DEFAULT_STYLE = 'default';

/** GNOME's accent colours (libadwaita), used when the Shell cannot tell its accent. */
export const GNOME_ACCENTS = Object.freeze({
    blue: [53, 132, 228],
    teal: [33, 144, 164],
    green: [58, 148, 74],
    yellow: [200, 136, 0],
    orange: [237, 91, 0],
    red: [230, 45, 66],
    pink: [213, 97, 153],
    purple: [145, 65, 172],
    slate: [111, 131, 150],
});

/** @param {string} style @returns {string} a known style; anything else is Default */
export function normalizeStyle(style) {
    return ICON_STYLES.includes(style) ? style : DEFAULT_STYLE;
}

/** @param {?number[]} rgb @returns {number[]} three 0-255 integers (blue when unknown) */
export function normalizeTint(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3 || rgb.slice(0, 3).some(v => !Number.isFinite(v)))
        return [...GNOME_ACCENTS.blue];
    return rgb.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))));
}

/**
 * The effects and opacity for one style.
 *
 * @param {string} style one of ICON_STYLES
 * @param {{dark?: boolean, tint?: number[]}} env dark: the shell is in dark mode; tint: accent rgb
 * @returns {{style: string, opacity: number, effects: object[], key: string}} effects in paint
 *   order: {kind: 'desaturate', factor} | {kind: 'brightness', brightness, contrast} |
 *   {kind: 'colorize', tint: [r, g, b]}. `key` changes only when the result does.
 */
export function effectPlan(style, env = {}) {
    const s = normalizeStyle(style);
    const dark = !!env.dark;
    let effects = [];
    let opacity = 255;
    switch (s) {
    case 'dark':
        effects = [{ kind: 'brightness', brightness: -0.28, contrast: 0.12 }];
        break;
    case 'clear':
        effects = [
            { kind: 'desaturate', factor: 1 },
            { kind: 'brightness', brightness: dark ? -0.08 : 0.16, contrast: -0.12 },
        ];
        opacity = 215;
        break;
    case 'tinted':
        effects = [
            { kind: 'colorize', tint: normalizeTint(env.tint) },
            { kind: 'brightness', brightness: dark ? 0.1 : 0.2, contrast: 0.05 },
        ];
        break;
    default:
        break;
    }
    return { style: s, opacity, effects, key: JSON.stringify([s, opacity, effects]) };
}
