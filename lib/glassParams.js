// SPDX-License-Identifier: GPL-3.0-or-later
// Pure rules of Guava's faux Liquid Glass (no gi imports; tests/glassParams.test.js).
//
// One look for every Guava surface, built from what St draws cheaply on the surface actor
// itself (the cookbook):
//   fill      a tint at 90-97 % (content) or 67-90 % (bars) alpha, set by the Clear <-> Tinted
//             slider, as a vertical gradient: a lighter top (the specular sheen) to a denser
//             bottom (the shade). 8 % of the wallpaper's average colour is mixed in.
//   edge      a 1px ring: a light lensing ring on dark glass, the darkened edge on light glass;
//             35 % contrast with Show Borders, 60 % with Increase Contrast.
//   rim       a 1px top highlight (an inset box-shadow, following the corners).
//   shadow    a soft drop shadow, drawn by a "shadow host": an actor with the same rounded rect
//             right behind the surface (St derives an outer shadow of a gradient from the whole
//             prerendered texture and paints it with hard, rectangular edges, so the surface
//             itself never carries one). Surfaces without a host have no drop shadow.
//   noise     optional: a faint grain image instead of the gradient (St draws one or the other).
// Reduce Transparency: opaque fill, no wallpaper tint, no grain. Increase Contrast (Guava's, or
// GNOME's high contrast): Reduce Transparency plus a flat fill and strong borders.
// The continuous colours go in an inline style fragment (fillStyle); everything that only has
// a few states is a class (glassClasses, hostClasses; rules in styles/base.css).

export const SURFACES = ['panel', 'menus', 'dock', 'overlays'];

/** GSettings key -> [snapshot field, default used when the key is missing]. */
export const SETTING_FIELDS = {
    'liquid-glass': ['liquid', true],
    'liquid-glass-surfaces': ['surfaces', ['panel', 'menus', 'dock', 'overlays']],
    'glass-tint': ['tint', 0],
    'glass-wallpaper-tint': ['wallpaperTint', true],
    'glass-reduce-transparency': ['reduceTransparency', false],
    'glass-increase-contrast': ['increaseContrast', false],
    'glass-show-borders': ['showBorders', false],
    'glass-noise': ['noise', false],
};

/** Fill opacity at the Clear (0) and Tinted (100) ends of the slider, per role. */
export const ALPHA_RANGE = {
    content: [0.9, 0.97],   // menus, Control Center, Spotlight, clipboard, calendar: text on it
    bar: [0.67, 0.9],       // menu bar, dock, Stage Manager floor: the least that keeps 4.5:1
};

/** Base tints (cookbook: light rgba(246,246,248), dark rgba(36,36,40)). */
export const TINT = { dark: [36, 36, 40], light: [246, 246, 248] };
/** Increase Contrast: flat, a little further from the text colour than the glass tint. */
export const CONTRAST_TINT = { dark: [24, 24, 26], light: [255, 255, 255] };
/** Share of the wallpaper's average colour mixed into the tint (macOS: 5-10 %). */
export const WALLPAPER_MIX = 0.08;
/** The specular sheen at the top (mix toward white) and the shade at the bottom (toward black). */
const SHEEN = { dark: 0.06, light: 0.55 };
const SHADE = { dark: 0.12, light: 0.035 };
/** The bottom of the gradient is this much denser than the top. */
const BOTTOM_EXTRA_ALPHA = 0.04;

/** Text on the glass reaches this contrast over the worst backdrop (WCAG AA). */
export const MIN_TEXT_CONTRAST = 4.5;
const TINT_FLOOR_STEP = 0.01;

const TEXT = { dark: [255, 255, 255], light: [29, 29, 31] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const round = c => c.map(v => Math.round(v));
const round3 = v => Math.round(v * 1000) / 1000;

/** Does this surface get glass? */
export function wantsSurface(snap, surface) {
    return !!snap?.liquid && Array.isArray(snap.surfaces) && snap.surfaces.includes(surface);
}

/** The role a surface plays when the caller does not say: bars hold icons, the rest text. */
export function roleFor(surface, role) {
    if (role === 'content' || role === 'bar')
        return role;
    return surface === 'panel' || surface === 'dock' ? 'bar' : 'content';
}

/** Fill opacity for the Clear <-> Tinted slider (0..100). */
export function sliderAlpha(tint, role) {
    const [clear, tinted] = ALPHA_RANGE[role] ?? ALPHA_RANGE.content;
    return clear + (tinted - clear) * clamp(tint, 0, 100) / 100;
}

/** Contrast mode: Guava's Increase Contrast or GNOME's high contrast. */
export const contrastOn = (snap, env) => !!(snap?.increaseContrast || env?.highContrast);
/** Opaque surfaces: Reduce Transparency, implied by contrast. */
export const opaqueOn = (snap, env) => !!snap?.reduceTransparency || contrastOn(snap, env);

/**
 * How one surface looks right now.
 *
 * @param {object} snap settings snapshot (SETTING_FIELDS)
 * @param {{dark: boolean, highContrast?: boolean, reducedMotion?: boolean,
 *          wallpaper?: ?number[]}} env wallpaper: average [r, g, b] (0-255) or null
 * @param {string} surface one of SURFACES
 * @param {string} [role] 'content' | 'bar' (default from the surface)
 * @returns {{tier: 'off'|'glass'|'solid', dark: boolean, motion: boolean, role: string,
 *   alpha: number, top: ?number[], bottom: ?number[], edge: 'soft'|'borders'|'contrast',
 *   noise: boolean}} top/bottom: [r, g, b, a]; bottom null = a flat fill
 */
export function resolve(snap, env, surface, role) {
    const dark = !!env.dark;
    const scheme = dark ? 'dark' : 'light';
    const look = {
        tier: 'off', dark, motion: !env.reducedMotion, role: roleFor(surface, role),
        alpha: 0, top: null, bottom: null, edge: 'soft', noise: false,
    };
    if (!wantsSurface(snap, surface))
        return look;

    if (contrastOn(snap, env))
        return { ...look, tier: 'solid', alpha: 1, top: [...CONTRAST_TINT[scheme], 1], edge: 'contrast' };

    const opaque = opaqueOn(snap, env);
    let base = TINT[scheme];
    if (!opaque && snap.wallpaperTint && Array.isArray(env.wallpaper))
        base = mix(base, env.wallpaper, WALLPAPER_MIX);
    const edge = snap.showBorders ? 'borders' : 'soft';
    const tier = opaque ? 'solid' : 'glass';
    const paint = alpha => {
        if (!opaque && snap.noise) {
            // St draws a background image or a gradient, never both: grain on a flat fill
            const flat = [...round(base), round3(alpha + BOTTOM_EXTRA_ALPHA / 2)];
            return { ...look, tier, alpha, top: flat, edge, noise: true };
        }
        const top = [...round(mix(base, [255, 255, 255], SHEEN[scheme])), round3(alpha)];
        const bottom = [...round(mix(base, [0, 0, 0], SHADE[scheme])), round3(Math.min(1, alpha + BOTTOM_EXTRA_ALPHA))];
        return { ...look, tier, alpha, top, bottom, edge };
    };
    let alpha = opaque ? 1 : sliderAlpha(snap.tint, look.role);
    let painted = paint(alpha);
    // A bright wallpaper lightens dark glass (and a dark one darkens light glass) just where
    // the backdrop is hardest on the text: the fill gets denser until the text reads
    while (!opaque && alpha < 1 && worstCaseContrast(painted) < MIN_TEXT_CONTRAST) {
        alpha = Math.min(1, round3(alpha + TINT_FLOOR_STEP));
        painted = paint(alpha);
    }
    return painted;
}

const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a})`;

/**
 * The inline style fragment that paints the fill: '' when the surface draws no glass.
 * It is appended to the actor's own style (wrapFragment).
 *
 * @param {object} look resolve() result
 * @param {?number} [radius] corner radius for targets whose CSS has none
 */
export function fillStyle(look, radius = null) {
    if (!look || look.tier === 'off')
        return '';
    let s = ` background-color: ${rgba(look.top)};`;
    if (look.bottom)
        s += ` background-gradient-direction: vertical; background-gradient-end: ${rgba(look.bottom)};`;
    else
        s += ' background-gradient-direction: none;';
    if (radius !== null && radius !== undefined)
        s += ` border-radius: ${Math.round(radius)}px;`;
    if (look.role === 'content')
        s += ` box-shadow: ${rimShadow(look)};`;
    return wrapFragment(s);
}

/**
 * The specular rim of a content surface (a menu, a card), written inline: the theme gives
 * menus a square outer shadow (.popup-menu-content, .quick-settings) that a stylesheet rule
 * does not reliably replace, while an inline declaration always does.
 */
export function rimShadow(look) {
    if (look.edge === 'contrast')
        return 'none';
    return look.dark ? 'inset 0 1px 0 0 rgba(255, 255, 255, 0.22)' : 'inset 0 1px 0 0 rgba(255, 255, 255, 0.95)';
}

/**
 * Classes for the glass surface itself.
 *
 * @param {object} look resolve() result
 * @param {string} surface
 * @returns {string[]} empty when the surface draws no glass
 */
export function glassClasses(look, surface) {
    if (!look || look.tier === 'off')
        return [];
    const classes = ['guava-glass', `guava-glass-${surface}`, `guava-glass-${look.role}`,
        look.dark ? 'guava-glass-dark' : 'guava-glass-light'];
    if (look.edge !== 'soft')
        classes.push(`guava-glass-${look.edge}`);
    if (look.tier === 'solid')
        classes.push('guava-glass-solid');
    if (look.noise)
        classes.push('guava-glass-noise');
    if (!look.motion)
        classes.push('guava-glass-static');
    return classes;
}

/** Classes for the shadow host (an actor with the same rounded rect behind the surface). */
export function hostClasses(look) {
    if (!look || look.tier === 'off')
        return [];
    return ['guava-glass-shadow', look.dark ? 'guava-glass-dark' : 'guava-glass-light'];
}

/** Inline style fragment for the shadow host: the surface's corner radius, so the shadow is rounded. */
export function hostStyle(radius) {
    return wrapFragment(` border-radius: ${Math.max(0, Math.round(radius))}px;`);
}

// Every fragment Guava writes is fenced by two declarations St ignores, so it can be found and
// removed again wherever it ended up (another feature may save and restore a style with it).
const MARK_START = ' -guava-glass: start;';
const MARK_END = ' -guava-glass: end;';
const FRAGMENTS = / -guava-glass: start;[\s\S]*? -guava-glass: end;/g;

/** Fence a list of declarations as one Guava fragment ('' stays ''). */
export function wrapFragment(decls) {
    return decls ? `${MARK_START}${decls}${MARK_END}` : '';
}

/** A style string without any Guava fragment. */
export function stripFragments(style) {
    return (style ?? '').replace(FRAGMENTS, '');
}

/** sRGB (0-255 channels) to WCAG relative luminance. */
export function luminance([r, g, b]) {
    const f = c => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of two colours. */
export function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Text contrast on the fill over the worst backdrop: white behind dark glass, black behind
 * light glass (there is no blur to average it). Checks both ends of the gradient.
 */
export function worstCaseContrast(look) {
    const text = look.dark ? TEXT.dark : TEXT.light;
    const back = look.dark ? 255 : 0;
    const over = ([r, g, b, a]) => [r, g, b].map(c => c * a + back * (1 - a));
    return Math.min(...[look.top, look.bottom].filter(Boolean).map(c => contrast(over(c), text)));
}

/**
 * Read every glass setting from a Gio.Settings (duck-typed so tests can fake it). Keys missing
 * from the schema fall back to their defaults.
 */
export function readSnapshot(gs) {
    const schema = gs?.settings_schema;
    const snap = {};
    for (const [key, [field, dflt]] of Object.entries(SETTING_FIELDS)) {
        let v = dflt;
        if (gs && (!schema || schema.has_key(key))) {
            if (typeof dflt === 'boolean')
                v = gs.get_boolean(key);
            else if (typeof dflt === 'number')
                v = gs.get_int(key);
            else
                v = gs.get_strv(key);
        }
        snap[field] = v;
    }
    return snap;
}
