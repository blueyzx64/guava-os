// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for wallpaper tinting (lib/wallpaperTint.js samples, lib/glass.js mixes 8 % of
// the result into the glass tint, features/menuBar measures the band under the bar). No gi imports;
// tests/wallpaperModel.test.js.

/** Side of the thumbnail the wallpaper is decoded to; its average is the tint source. */
export const SAMPLE_SIZE = 32;
/** Wallpapers whose average colour is remembered for the session. */
export const CACHE_SIZE = 8;

/** '#rrggbb' (or '#rgb') -> [r, g, b], null when it is not a colour. */
export function parseHexColor(text) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? '').trim());
    if (!m)
        return null;
    const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * What to sample, from org.gnome.desktop.background and the colour scheme. The Shell shows
 * picture-uri-dark only for 'prefer-dark' (js/ui/background.js, getBackground), and a
 * picture-options of 'none' shows primary-color.
 *
 * @param {{pictureUri: string, pictureUriDark: string, options: string, primaryColor: string,
 *          colorScheme: string}} bg
 * @returns {{kind: 'none'}|{kind: 'color', color: number[]}|{kind: 'file', uri: string}}
 */
export function wallpaperSource({ pictureUri, pictureUriDark, options, primaryColor, colorScheme }) {
    if (options === 'none') {
        const color = parseHexColor(primaryColor);
        return color ? { kind: 'color', color } : { kind: 'none' };
    }
    const uri = (colorScheme === 'prefer-dark' && pictureUriDark) ? pictureUriDark : pictureUri;
    return uri ? { kind: 'file', uri } : { kind: 'none' };
}

/** True for a GNOME time-based (slideshow) background description. */
export const isXmlBackground = uri => /\.xml$/i.test(uri ?? '');

// The picture named by a <file> element: its text, or the first <size> of the multi-size form
function filePath(inner) {
    const size = /<size[^>]*>([\s\S]*?)<\/size>/.exec(inner);
    return (size ? size[1] : inner).trim();
}

/**
 * The first picture of a GNOME XML background (`<static><file>…</file>` or the multi-size
 * `<file><size …>…</size></file>` form), or null.
 */
export function xmlFirstImage(text) {
    const file = /<file>([\s\S]*?)<\/file>/.exec(text ?? '');
    return file ? filePath(file[1]) || null : null;
}

const xmlNumber = (inner, tag) => {
    const m = new RegExp(`<${tag}>\\s*([0-9.]+)\\s*</${tag}>`).exec(inner);
    return m ? Number(m[1]) : NaN;
};

/**
 * The picture a GNOME XML (day/night) background shows at `now`, and how long that lasts. The
 * file is a loop of <static> pictures and <transition>s from <starttime>; a transition counts
 * as its source for the first half and its target for the second. Without a start time or
 * durations it is the first picture, for good.
 *
 * @param {string} text the XML
 * @param {Date} now
 * @returns {?{path: string, until: ?number}} until: seconds to the next picture (null: never)
 */
export function xmlSlideAt(text, now) {
    const first = xmlFirstImage(text);
    if (!first)
        return null;
    const start = /<starttime>([\s\S]*?)<\/starttime>/.exec(text);
    const slides = [];
    for (const m of text.matchAll(/<(static|transition)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        const duration = xmlNumber(m[2], 'duration');
        if (!(duration > 0))
            continue;
        if (m[1] === 'static') {
            const file = /<file>([\s\S]*?)<\/file>/.exec(m[2]);
            if (file)
                slides.push({ duration, path: filePath(file[1]) });
        } else {
            const from = /<from>([\s\S]*?)<\/from>/.exec(m[2]);
            const to = /<to>([\s\S]*?)<\/to>/.exec(m[2]);
            if (from && to)
                slides.push({ duration, path: filePath(from[1]), then: filePath(to[1]) });
        }
    }
    const cycle = slides.reduce((s, x) => s + x.duration, 0);
    if (!start || !(cycle > 0))
        return { path: first, until: null };
    const field = tag => xmlNumber(start[1], tag);
    const begin = new Date(field('year'), field('month') - 1, field('day'),
        field('hour') || 0, field('minute') || 0, field('second') || 0);
    if (Number.isNaN(begin.getTime()))
        return { path: first, until: null };
    let t = (((now - begin) / 1000) % cycle + cycle) % cycle;
    for (const slide of slides) {
        if (t < slide.duration) {
            if (slide.then === undefined)
                return { path: slide.path, until: slide.duration - t };
            const half = slide.duration / 2;
            return t < half ? { path: slide.path, until: half - t } : { path: slide.then, until: slide.duration - t };
        }
        t -= slide.duration;
    }
    return { path: first, until: null };
}

/**
 * Average colour of raw pixel rows (GdkPixbuf layout), weighted by alpha when there is one.
 *
 * @param {Uint8Array} pixels
 * @param {{width: number, height: number, rowstride: number, channels: number}} layout
 * @returns {?number[]} [r, g, b] rounded, null when nothing is visible
 */
export function averageRgb(pixels, { width, height, rowstride, channels }) {
    let r = 0, g = 0, b = 0, w = 0;
    for (let y = 0; y < height; y++) {
        let i = y * rowstride;
        for (let x = 0; x < width; x++, i += channels) {
            const a = channels === 4 ? pixels[i + 3] / 255 : 1;
            r += pixels[i] * a;
            g += pixels[i + 1] * a;
            b += pixels[i + 2] * a;
            w += a;
        }
    }
    return w > 0 ? [r / w, g / w, b / w].map(v => Math.round(v)) : null;
}

/** A small most-recently-used map. */
export class ColorCache {
    constructor(limit = CACHE_SIZE) {
        this._limit = limit;
        this._map = new Map();
    }

    get(key) {
        if (!this._map.has(key))
            return undefined;
        const v = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, v);
        return v;
    }

    set(key, value) {
        this._map.delete(key);
        this._map.set(key, value);
        while (this._map.size > this._limit)
            this._map.delete(this._map.keys().next().value);
    }

    get size() {
        return this._map.size;
    }
}

// ---- the band under the menu bar (measured in the probe process) ----------------------------

/** WCAG relative luminance of an sRGB colour (0..255 channels) -> 0..1. */
export function relativeLuminance(r, g, b) {
    const lin = c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Decode width (px) for placements by ratio: enough for a band of a few dozen rows. */
export const PROBE_WIDTH = 480;

/** Placements that scale the picture to the monitor (zoom, stretched, scaled, spanned). */
export const decodesByRatio = option => option !== 'centered' && option !== 'wallpaper';

/**
 * Which part of the wallpaper image lies under the top band of a monitor.
 *
 * @param {{width: number, height: number}} image picture size in pixels
 * @param {{width: number, height: number}} monitor
 * @param {string} option org.gnome.desktop.background picture-options
 * @param {number} band band height in monitor px (the menu bar)
 * @returns {?{x: number, y: number, width: number, height: number}} image rect, or null when
 *   the band shows only the background colour ('none', or bars of 'scaled' / 'centered')
 */
export function wallpaperBand(image, monitor, option, band) {
    const { width: iw, height: ih } = image;
    const { width: mw, height: mh } = monitor;
    if (!iw || !ih || !mw || !mh || option === 'none')
        return null;
    const clampRect = (x, y, w, h) => {
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(iw, Math.ceil(x + w));
        const y1 = Math.min(ih, Math.ceil(y + h));
        return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
    };
    switch (option) {
    case 'stretched':
        return clampRect(0, 0, iw, ih * band / mh);
    case 'scaled': {
        // Fit inside: bars of the background colour above and below when the image is wider
        const s = Math.min(mw / iw, mh / ih);
        const top = (mh - ih * s) / 2;
        if (top >= band)
            return null;
        return clampRect(0, Math.max(0, -top) / s, iw, (band - Math.max(0, top)) / s);
    }
    case 'centered': {
        const top = (mh - ih) / 2;
        const left = (mw - iw) / 2;
        if (top >= band)
            return null;
        return clampRect(-left, -top, mw, band - Math.max(0, top));
    }
    case 'wallpaper':
        return clampRect(0, 0, Math.min(iw, mw), Math.min(ih, band));
    case 'zoom':
    case 'spanned':
    default: {
        // Cover: the image fills the monitor, centred, cropped on one axis
        const s = Math.max(mw / iw, mh / ih);
        const cropX = (iw * s - mw) / 2 / s;
        const cropY = (ih * s - mh) / 2 / s;
        return clampRect(cropX, cropY, mw / s, band / s);
    }
    }
}

/**
 * Luminance statistics of a rect of RGB(A) pixels, sampling a grid of at most ~grid² points.
 *
 * @param {Uint8Array} pixels
 * @param {{rowstride: number, channels: number}} layout
 * @param {{x, y, width, height}} rect
 * @param {number} [grid] samples per axis
 * @returns {{mean: number, spread: number}} spread = 90th - 10th percentile
 */
export function bandLuminance(pixels, { rowstride, channels }, rect, grid = 24) {
    const values = [];
    const stepX = Math.max(1, Math.floor(rect.width / grid));
    const stepY = Math.max(1, Math.floor(rect.height / Math.min(grid, rect.height)));
    for (let y = rect.y; y < rect.y + rect.height; y += stepY) {
        for (let x = rect.x; x < rect.x + rect.width; x += stepX) {
            const i = y * rowstride + x * channels;
            values.push(relativeLuminance(pixels[i], pixels[i + 1], pixels[i + 2]));
        }
    }
    if (!values.length)
        return { mean: 0, spread: 0, low: 0, high: 0 };
    values.sort((a, b) => a - b);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const at = f => values[Math.min(values.length - 1, Math.floor(f * values.length))];
    return { mean, spread: at(0.9) - at(0.1), low: at(0.1), high: at(0.9) };
}

// ---- limits of the probe process ---------------------------------------------------------------

/** Largest picture (pixels) the probe decodes: 64 MP is an 8K wallpaper with room to spare. */
export const MAX_PROBE_PIXELS = 64e6;

/** True when a picture of this size may be decoded (a bigger one counts as unreadable). */
export const withinProbeCap = (width, height) => width > 0 && height > 0 && width * height <= MAX_PROBE_PIXELS;

/** Milliseconds until an XML background shows its next picture (at least a second away). */
export const slideDelayMs = untilSeconds => Math.max(1000, Math.ceil(untilSeconds * 1000));
