// SPDX-License-Identifier: GPL-3.0-or-later
// Pure rules of Guava's Liquid Glass (no gi imports; tests/glassParams.test.js).
//
// Real glass (env.blur, lib/glassBlur.js): the backdrop behind the surface is blurred, its
// saturation boosted and darkened (dark glass) or lifted (light glass), then the tint below is
// laid over it at a lower alpha (BLUR_ALPHA_RANGE); the effect draws fill and rounded mask, so
// the St background goes transparent. Without blur (no effect, Reduce Transparency, contrast)
// the St fill below carries the look on its own:
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
// Two looks share one pipeline (look.style). 'frost' is the default (liquid-glass off): the same
// blur effect with a flat neutral translucent fill, no sheen, rim, saturation boost, tint
// gradient, wallpaper tint or grain; FROST below. 'glass' is Liquid Glass (liquid-glass on): all
// of the above. Both honour the surfaces list, Show Borders, Reduce Transparency and contrast.
// Reduce Transparency: opaque fill, no wallpaper tint, no grain. Increase Contrast (Guava's, or
// GNOME's high contrast): Reduce Transparency plus a flat fill and strong borders.
// The continuous colours go in an inline style fragment (fillStyle); everything that only has
// a few states is a class (glassClasses, hostClasses; rules in styles/base.css).

export const SURFACES = ['panel', 'menus', 'dock', 'overlays'];

/** GSettings key -> [snapshot field, default used when the key is missing]. */
export const SETTING_FIELDS = {
    'liquid-glass': ['liquid', false],
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

/** Tint opacity over a blurred backdrop: the blur averages the backdrop, so less is needed. */
export const BLUR_ALPHA_RANGE = {
    content: [0.5, 0.8],
    bar: [0.35, 0.7],
};

/**
 * The backdrop treatment (macOS vibrancy-like material). sigma in logical px; saturation
 * multiplies chroma; dark glass darkens the backdrop (brightness), light glass lifts it
 * toward white (lift), so the tint needs less alpha for the same text contrast.
 */
export const BLUR = {
    sigma: { content: 22, bar: 18 },
    saturation: 1.7,
    dark: { brightness: 0.8, lift: 0 },
    light: { brightness: 1, lift: 0.3 },
};

/**
 * The frosted look (Liquid Glass off): a plain Gaussian blur of the real backdrop under a flat
 * neutral tint. alpha is the fill opacity over the blur (fixed: the Clear <-> Tinted slider and
 * the wallpaper tint belong to Liquid Glass); noBlur is the denser fill when no blur can draw.
 * The loop in resolve() still raises it until text reaches MIN_TEXT_CONTRAST.
 */
export const FROST = {
    alpha: { content: 0.72, bar: 0.6 },
    noBlur: { content: 0.9, bar: 0.78 },
    saturation: 1,
    dark: { brightness: 1, lift: 0 },
    light: { brightness: 1, lift: 0 },
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

/** Does this surface get the frosted look or Liquid Glass (which one: styleOf)? */
export function wantsSurface(snap, surface) {
    return Array.isArray(snap?.surfaces) && snap.surfaces.includes(surface);
}

/** 'glass' (Liquid Glass on) or 'frost' (the default Gaussian blur). */
export const styleOf = snap => snap?.liquid ? 'glass' : 'frost';

/** The role a surface plays when the caller does not say: bars hold icons, the rest text. */
export function roleFor(surface, role) {
    if (role === 'content' || role === 'bar')
        return role;
    return surface === 'panel' || surface === 'dock' ? 'bar' : 'content';
}

/** Fill opacity for the Clear <-> Tinted slider (0..100). */
export function sliderAlpha(tint, role, blur = false) {
    const range = blur ? BLUR_ALPHA_RANGE : ALPHA_RANGE;
    const [clear, tinted] = range[role] ?? range.content;
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
 *          wallpaper?: ?number[], blur?: boolean}} env wallpaper: average [r, g, b] (0-255) or
 *          null; blur: a backdrop blur can draw (lib/glassBlur.js)
 * @param {string} surface one of SURFACES
 * @param {string} [role] 'content' | 'bar' (default from the surface)
 * @returns {{tier: 'off'|'glass'|'solid', dark: boolean, motion: boolean, role: string,
 *   alpha: number, top: ?number[], bottom: ?number[], edge: 'soft'|'borders'|'contrast',
 *   noise: boolean, blur: ?{sigma: number, saturation: number, brightness: number,
 *   lift: number}}} top/bottom: [r, g, b, a]; bottom null = a flat fill; blur null = no
 *   backdrop blur
 */
export function resolve(snap, env, surface, role) {
    const dark = !!env.dark;
    const scheme = dark ? 'dark' : 'light';
    const style = styleOf(snap);
    const look = {
        tier: 'off', style, dark, motion: !env.reducedMotion, role: roleFor(surface, role),
        alpha: 0, top: null, bottom: null, edge: 'soft', noise: false, blur: null,
    };
    if (!wantsSurface(snap, surface))
        return look;

    if (contrastOn(snap, env))
        return { ...look, tier: 'solid', alpha: 1, top: [...CONTRAST_TINT[scheme], 1], edge: 'contrast' };

    const opaque = opaqueOn(snap, env);
    let base = TINT[scheme];
    const frost = style === 'frost';
    if (!frost && !opaque && snap.wallpaperTint && Array.isArray(env.wallpaper))
        base = mix(base, env.wallpaper, WALLPAPER_MIX);
    const edge = snap.showBorders ? 'borders' : 'soft';
    const tier = opaque ? 'solid' : 'glass';
    const blur = !opaque && env.blur ? blurParams(look.role, dark, style) : null;
    look.blur = blur;
    const paint = alpha => {
        if (frost) {
            // flat neutral fill: no sheen, no shade, no grain
            return { ...look, tier, alpha, top: [...round(base), round3(alpha)], edge };
        }
        if (!opaque && snap.noise) {
            // St draws a background image or a gradient, never both: grain on a flat fill
            const flat = [...round(base), round3(alpha + BOTTOM_EXTRA_ALPHA / 2)];
            return { ...look, tier, alpha, top: flat, edge, noise: true };
        }
        const top = [...round(mix(base, [255, 255, 255], SHEEN[scheme])), round3(alpha)];
        const bottom = [...round(mix(base, [0, 0, 0], SHADE[scheme])), round3(Math.min(1, alpha + BOTTOM_EXTRA_ALPHA))];
        return { ...look, tier, alpha, top, bottom, edge };
    };
    let alpha = opaque ? 1 : frost ? FROST[blur ? 'alpha' : 'noBlur'][look.role] : sliderAlpha(snap.tint, look.role, !!blur);
    let painted = paint(alpha);
    // A bright wallpaper lightens dark glass (and a dark one darkens light glass) just where
    // the backdrop is hardest on the text: the fill gets denser until the text reads
    while (!opaque && alpha < 1 && worstCaseContrast(painted) < MIN_TEXT_CONTRAST) {
        alpha = Math.min(1, round3(alpha + TINT_FLOOR_STEP));
        painted = paint(alpha);
    }
    return painted;
}

/** The backdrop treatment for a role and scheme. */
export function blurParams(role, dark, style = 'glass') {
    const frost = style === 'frost';
    const scheme = frost ? (dark ? FROST.dark : FROST.light) : (dark ? BLUR.dark : BLUR.light);
    return {
        sigma: BLUR.sigma[role] ?? BLUR.sigma.content, saturation: frost ? FROST.saturation : BLUR.saturation, ...scheme,
    };
}

const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a})`;

/**
 * The inline style fragment that paints the fill: '' when the surface draws no glass.
 * It is appended to the actor's own style (wrapFragment).
 *
 * @param {object} look resolve() result
 * @param {?number} [radius] corner radius for targets whose CSS has none
 * @param {boolean} [effect] the blur effect draws the fill: St draws none
 */
export function fillStyle(look, radius = null, effect = false) {
    if (!look || look.tier === 'off')
        return '';
    let s = effect ? ' background-color: transparent;' : ` background-color: ${rgba(look.top)};`;
    if (look.bottom && !effect)
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
    if (look.edge === 'contrast' || look.style === 'frost')
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
    if (look.style === 'frost' && look.edge === 'soft')
        classes.push('guava-glass-frost');
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
 * light glass, after the blur's brightness or lift. Checks both ends of the gradient.
 */
export function worstCaseContrast(look) {
    const text = look.dark ? TEXT.dark : TEXT.light;
    let back = look.dark ? 255 : 0;
    if (look.blur)
        back = Math.min(255, back * look.blur.brightness + (255 - back * look.blur.brightness) * look.blur.lift);
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

/**
 * Effect uniforms for a look (lib/glassBlur.js): colours as 0..1 floats, straight alpha.
 *
 * @returns {{top: number[], bottom: number[], blur: ?object}}
 */
export function effectColors(look) {
    const f = c => [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
    const top = f(look.top);
    return { top, bottom: look.bottom ? f(look.bottom) : top, blur: look.blur };
}

/**
 * Blur at a lower resolution where it costs less and looks the same: a blur of sigma s has no
 * detail finer than about s / 4 px. Halve until sigma <= MAX_SIGMA_PX device px, keeping at
 * least MIN_SIDE px per side.
 *
 * @param {number} sigma device px
 * @param {number} width device px
 * @param {number} height device px
 * @returns {number} 1, 2, 4, ...
 */
export function downscaleFor(sigma, width, height) {
    let ds = 1;
    while (sigma / ds > MAX_SIGMA_PX && width / (ds * 2) >= MIN_SIDE && height / (ds * 2) >= MIN_SIDE)
        ds *= 2;
    return ds;
}
const MAX_SIGMA_PX = 6;
const MIN_SIDE = 4;

/**
 * Surfaces over the wallpaper (menu bar, dock) keep one blurred capture while nothing but the
 * wallpaper lies behind them ('auto': static, live while a window overlaps or right after a
 * change); floating surfaces (menus, overlays) blur what is behind them on every paint.
 */
export function captureMode(surface) {
    return surface === 'panel' || surface === 'dock' ? 'auto' : 'live';
}

/** A live surface recaptures its backdrop at most this often (ms); the backdrop behind a menu rarely moves. */
export const LIVE_CAPTURE_MS = 80;
/** Same while the frame budget is blown (env.degraded): the blur is a still image with a slow refresh. */
export const LIVE_CAPTURE_DEGRADED_MS = 500;

/**
 * Is a live surface due a new backdrop capture? Capturing means a framebuffer copy and a blur on
 * every painted frame of the surface, the biggest cost of opening a menu, so it is throttled.
 *
 * @param {number} lastMs monotonic time of the last capture (negative: none yet)
 * @param {number} nowMs
 * @param {boolean} degraded the frame budget is blown
 */
export function liveCaptureDue(lastMs, nowMs, degraded = false) {
    return lastMs < 0 || nowMs - lastMs >= (degraded ? LIVE_CAPTURE_DEGRADED_MS : LIVE_CAPTURE_MS);
}

/** Extra backdrop captured around the surface (device px) so its edges blur naturally. */
export function captureMargin(surface, sigmaDevice) {
    return surface === 'panel' ? 0 : Math.ceil(sigmaDevice);
}

/**
 * Load governor: decorative blur drops first. Fed the interval between consecutive frames
 * that recaptured a live blur; when 3 in 4 of the last WINDOW of them exceed
 * SLOW_FACTOR frame budgets, live recapture freezes (surfaces show their last blur, which
 * costs one textured quad) until frames are fast again for RECOVER_MS.
 */
export class LoadGovernor {
    /** @param {() => number} [clock] monotonic ms; the same clock the frames are timed with (idle() reads it) */
    constructor({ window = 24, slowFactor = 2.5, recoverMs = 3000, idleMs = 250, clock = null } = {}) {
        this._clock = clock;
        this._window = window;
        this._slow = slowFactor;
        this._recover = recoverMs;
        this._idle = idleMs;
        this._samples = [];
        this._frozenAt = -1;
        this._fastSince = -1;
        this._last = -1;
    }

    get frozen() {
        return this._frozenAt >= 0;
    }

    /**
     * @param {number} nowMs a monotonic time of this frame
     * @param {number} budgetMs one refresh interval
     * @returns {boolean} frozen
     */
    frame(nowMs, budgetMs) {
        const dt = this._last < 0 ? -1 : nowMs - this._last;
        this._last = nowMs;
        if (dt < 0 || dt > this._idle)
            return this.frozen;   // the first frame of a burst, or idle: no evidence
        const slow = dt > this._slow * budgetMs;
        if (this.frozen) {
            if (slow)
                this._fastSince = -1;
            else if (this._fastSince < 0)
                this._fastSince = nowMs;
            else if (nowMs - this._fastSince >= this._recover)
                this._reset();
            return this.frozen;
        }
        this._samples.push(dt);
        if (this._samples.length > this._window)
            this._samples.shift();
        if (this._samples.length === this._window) {
            const sorted = [...this._samples].sort((a, b) => a - b);
            if (sorted[sorted.length >> 2] > this._slow * budgetMs) {   // 3 in 4 frames slow
                this._frozenAt = nowMs;
                this._fastSince = -1;
            }
        }
        return this.frozen;
    }

    /** No live surface for a while: forget, start fresh. nowMs defaults to the governor's clock. */
    idle(nowMs = this._clock?.() ?? this._last) {
        if (this.frozen && nowMs - this._last > this._recover)
            this._reset();
    }

    _reset() {
        this._samples = [];
        this._frozenAt = -1;
        this._fastSince = -1;
    }
}

// ---- backdrop capture geometry (lib/glassBlur.js) ----------------------------------------
// Rects are {x1, y1, x2, y2} in device px of one stage view's framebuffer.

const rectArea = r => Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);

/** The overlap of two rects, or null. */
export function intersectRect(a, b) {
    const r = {
        x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
        x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2),
    };
    return r.x2 > r.x1 && r.y2 > r.y1 ? r : null;
}

/**
 * Mutter hands a paint the region it redraws (logical px in the stage, disjoint rects). Convert
 * to device px of the view, shrinking inwards: a pixel wrongly left out only keeps its older
 * (correct) value in the cache, a pixel wrongly taken in would copy last frame's glass. At a
 * fractional scale the clip's edges can cover pixels of an older frame, so they step in one
 * more logical px.
 *
 * @param {{x: number, y: number, width: number, height: number}[]} rects logical, stage coordinates
 * @param {{x: number, y: number}} layout the view's origin (logical)
 * @param {number} scale
 * @param {number} [inset] logical px to step in at the clip's edges (default: 1 at a fractional scale)
 * @returns {{x1: number, y1: number, x2: number, y2: number}[]}
 */
export function clipToDevice(rects, layout, scale, inset = Number.isInteger(scale) ? 0 : 1) {
    const out = [];
    for (const r of rects) {
        const x1 = Math.ceil((r.x - layout.x + inset) * scale);
        const y1 = Math.ceil((r.y - layout.y + inset) * scale);
        const x2 = Math.floor((r.x + r.width - layout.x - inset) * scale);
        const y2 = Math.floor((r.y + r.height - layout.y - inset) * scale);
        if (x2 > x1 && y2 > y1)
            out.push({ x1, y1, x2, y2 });
    }
    return out;
}

/** Does the redraw clip (disjoint rects; null: the whole view) cover the whole box? */
export function clipCovers(box, clip) {
    if (!clip)
        return true;
    let area = 0;
    for (const c of clip) {
        const i = intersectRect(c, box);
        if (i)
            area += rectArea(i);
    }
    return area >= rectArea(box);
}

/**
 * What to copy from the framebuffer into the cached backdrop. The pixels of the surface's own
 * box are only fresh inside this paint's redraw clip (outside it the framebuffer still holds
 * the previous frame, i.e. the glass itself): copy those only. The margin around the box is
 * not covered by the glass, so it is always read.
 *
 * @param {object} cap the captured area (box plus margin)
 * @param {object} box the surface inside it
 * @param {?object[]} clip redraw clip in device px; null: everything was redrawn
 * @returns {object[]} rects to copy
 */
export function captureRects(cap, box, clip) {
    if (!clip)
        return [cap];
    const b = intersectRect(box, cap);
    if (!b)
        return [cap];
    const rects = [
        { x1: cap.x1, y1: cap.y1, x2: cap.x2, y2: b.y1 },
        { x1: cap.x1, y1: b.y2, x2: cap.x2, y2: cap.y2 },
        { x1: cap.x1, y1: b.y1, x2: b.x1, y2: b.y2 },
        { x1: b.x2, y1: b.y1, x2: cap.x2, y2: b.y2 },
    ].filter(r => r.x2 > r.x1 && r.y2 > r.y1);
    for (const c of clip) {
        const i = intersectRect(c, b);
        if (i)
            rects.push(i);
    }
    return rects;
}

/** Texture side for a capture: rounded up so a surface that grows or shrinks by pixels reuses it. */
export function textureSide(n, step) {
    return step > 1 ? Math.ceil(n / step) * step : n;
}
export const TEXTURE_STEP = 64;
