// SPDX-License-Identifier: GPL-3.0-or-later
// Pointer (macOS Accessibility > Display > Pointer, and AppKit's hide-while-typing). Pure:
//
//   ShakeDetector   back-and-forth pointer strokes -> "shaking" (Shake mouse pointer to locate);
//                   never while blocked, and a block (a drag, a grab) wipes its history
//   isBlocked       a button held, a grab, the overview or a modal: not the time to react
//   TypingHider     caret moves with a still pointer -> hide; any pointer motion -> show
//   readConfig      settings in, plain config out
//   recolorXcursor  an Xcursor file's pixels with a new fill and outline (custom colours)
//
// No allocation per pointer event: the detector keeps its reversal times in a fixed ring.

export const SHAKE = Object.freeze({
    minStroke: 50,      // px a stroke must travel before its reversal counts
    minSpeed: 0.6,      // px/ms over the stroke (a deliberate flick, not a slow drift)
    reversals: 3,       // reversals inside `window` that make a shake
    window: 800,        // ms
    hold: 350,          // ms the pointer stays big after the last qualifying reversal
    maxGap: 120,        // ms without motion that ends the current stroke
});

export const SHAKE_SCALE = 4;       // how much bigger the pointer gets (macOS: about 4x)
export const RING = 8;

/** Back-and-forth horizontal strokes, fast and long enough, a few times in a short while. */
export class ShakeDetector {
    constructor(opts = SHAKE) {
        this._o = { ...SHAKE, ...opts };
        this._times = new Float64Array(RING);
        this.reset();
    }

    reset() {
        this._n = 0;            // reversals stored (ring)
        this._head = 0;
        this._lastX = NaN;
        this._lastT = 0;
        this._dir = 0;
        this._startX = 0;
        this._startT = 0;
        this._lastShake = -Infinity;
    }

    _push(t) {
        this._times[this._head] = t;
        this._head = (this._head + 1) % RING;
        if (this._n < RING)
            this._n++;
    }

    _recent(t) {
        let c = 0;
        for (let i = 0; i < this._n; i++) {
            if (t - this._times[i] <= this._o.window)
                c++;
        }
        return c;
    }

    /**
     * One pointer sample.
     *
     * @param {number} x
     * @param {number} _y unused (macOS reacts to side-to-side shakes)
     * @param {number} t ms, monotonic
     * @param {boolean} [blocked] see isBlocked(): never shakes, and the history is dropped
     * @returns {boolean} the pointer should be big now
     */
    update(x, _y, t, blocked = false) {
        const o = this._o;
        if (blocked) {
            // A drag's motion must not count: forget it, so the first sample after the block
            // starts a fresh stroke instead of finishing a shake
            this.reset();
            return false;
        }
        if (Number.isNaN(this._lastX) || t - this._lastT > o.maxGap) {
            // First sample, or the pointer rested: a new stroke starts here
            this._lastX = x;
            this._lastT = t;
            this._dir = 0;
            this._startX = x;
            this._startT = t;
            return this.shaking(t);
        }
        const dx = x - this._lastX;
        const dir = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        if (dir !== 0 && this._dir !== 0 && dir !== this._dir) {
            const length = Math.abs(this._lastX - this._startX);
            const time = Math.max(1, this._lastT - this._startT);
            if (length >= o.minStroke && length / time >= o.minSpeed) {
                this._push(this._lastT);
                if (this._recent(t) >= o.reversals)
                    this._lastShake = t;
            } else {
                this._n = 0;
                this._head = 0;
            }
            this._startX = this._lastX;
            this._startT = this._lastT;
        }
        if (dir !== 0)
            this._dir = dir;
        this._lastX = x;
        this._lastT = t;
        return this.shaking(t);
    }

    /** @returns {boolean} still inside the hold after the last shake */
    shaking(t) {
        return t - this._lastShake <= this._o.hold;
    }
}

/**
 * Whether the pointer is busy with something else: dragging (a button held or a compositor
 * grab such as a window move or resize), the overview, or a modal. Shaking and hiding both
 * stand aside then.
 *
 * @param {{buttons?: boolean, grabbed?: boolean, overview?: boolean, modalCount?: number}} s
 */
export function isBlocked({ buttons = false, grabbed = false, overview = false, modalCount = 0 } = {}) {
    return !!(buttons || grabbed || overview || modalCount > 0);
}

/**
 * Hide the pointer while typing, like AppKit. A caret that moves twice with no pointer motion
 * in between is typing (one move alone is a click that placed the caret, or a focus change).
 * Any pointer motion shows it again.
 */
export class TypingHider {
    constructor(movesToHide = 2) {
        this._need = movesToHide;
        this._moves = 0;
        this.hidden = false;
    }

    /**
     * The caret moved.
     *
     * @param {{blocked?: boolean}} [state] blocked: a grab, a button held, the overview or a
     *   modal: never hide then
     * @returns {boolean} true when the pointer must be hidden now (it was visible)
     */
    caretMoved({ blocked = false } = {}) {
        if (blocked) {
            this._moves = 0;
            return false;
        }
        this._moves++;
        if (this.hidden || this._moves < this._need)
            return false;
        this.hidden = true;
        return true;
    }

    /** @returns {boolean} true when the pointer must be shown again now */
    pointerMoved() {
        this._moves = 0;
        if (!this.hidden)
            return false;
        this.hidden = false;
        return true;
    }

    /** Forget everything (disable, focus change); @returns {boolean} it was hidden */
    reset() {
        const was = this.hidden;
        this._moves = 0;
        this.hidden = false;
        return was;
    }
}

export const SIZES = ['system', '24', '32', '48', '64', '96'];

/** Settings in, plain config out. `get` is a GuavaSettings-like reader. */
export function readConfig(get) {
    const size = get.string('pointer-size');
    return {
        shake: get.bool('pointer-shake-to-locate'),
        hideWhileTyping: get.bool('pointer-hide-while-typing'),
        size: SIZES.includes(size) && size !== 'system' ? Number(size) : 0,
        colors: get.bool('pointer-custom-colors'),
        fill: parseHex(get.string('pointer-fill-color')) ?? [0, 0, 0],
        outline: parseHex(get.string('pointer-outline-color')) ?? [255, 255, 255],
    };
}

/** Whether the feature has anything to do. */
export function anyOn(c) {
    return c.shake || c.hideWhileTyping || c.size > 0 || c.colors;
}

/** '#rrggbb' -> [r, g, b], or null */
export function parseHex(s) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s ?? '').trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = v => v.toString(16).padStart(2, '0');

/** The generated theme's folder name: one per colour pair, so Mutter reloads on a change. */
export function themeName(fill, outline) {
    return `Guava-Pointer-${[...fill, ...outline].map(hex2).join('')}`;
}

export const THEME_PREFIX = 'Guava-Pointer-';
export const THEME_MARKER = '.guava-pointer';

/** index.theme of the generated theme: what it does not have comes from the user's theme. */
export function indexTheme(inherits) {
    return `[Icon Theme]\nName=Guava Pointer\nComment=Pointer colours made by Guava\nInherits=${inherits}\n`;
}

/**
 * One premultiplied ARGB pixel recoloured. Dark opaque parts become the fill, light parts the
 * outline, in between a mix; a soft dark shadow (low alpha) stays as it is.
 */
export function recolorPixel(argb, fill, outline) {
    const a = (argb >>> 24) & 255;
    if (a === 0)
        return argb >>> 0;
    const r = ((argb >>> 16) & 255) * 255 / a;
    const g = ((argb >>> 8) & 255) * 255 / a;
    const b = (argb & 255) * 255 / a;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (a < 153 && lum < 0.5)
        return argb >>> 0;
    const mix = i => Math.round((fill[i] * (1 - lum) + outline[i] * lum) * a / 255);
    return ((a << 24) | (mix(0) << 16) | (mix(1) << 8) | mix(2)) >>> 0;
}

const XCUR_MAGIC = 0x72756358;      // "Xcur"
const XCUR_IMAGE = 0xfffd0002;

/**
 * An Xcursor file with every image recoloured; the layout is kept byte for byte.
 *
 * @param {Uint8Array} bytes
 * @returns {?Uint8Array} null when it is not an Xcursor file
 */
export function recolorXcursor(bytes, fill, outline) {
    if (bytes.length < 16)
        return null;
    const out = new Uint8Array(bytes);
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (v.getUint32(0, true) !== XCUR_MAGIC)
        return null;
    const headerSize = v.getUint32(4, true);
    const ntoc = v.getUint32(12, true);
    for (let i = 0; i < ntoc; i++) {
        const entry = headerSize + i * 12;
        if (entry + 12 > out.length)
            return null;
        if (v.getUint32(entry, true) !== XCUR_IMAGE)
            continue;
        const pos = v.getUint32(entry + 8, true);
        if (pos + 36 > out.length)
            return null;
        const width = v.getUint32(pos + 16, true);
        const height = v.getUint32(pos + 20, true);
        const start = pos + v.getUint32(pos, true);
        const end = start + width * height * 4;
        if (end > out.length)
            return null;
        for (let p = start; p < end; p += 4)
            v.setUint32(p, recolorPixel(v.getUint32(p, true), fill, outline), true);
    }
    return out;
}

/**
 * The best image of an Xcursor file for a wanted size: the smallest nominal size that is at
 * least `want` (so it is only ever scaled down), else the largest there is.
 *
 * @param {Uint8Array} bytes
 * @param {number} want pixels
 * @returns {?{width: number, height: number, xhot: number, yhot: number, nominal: number,
 *   pixels: Uint8Array}} premultiplied BGRA bytes (Xcursor's ARGB, little endian), or null
 */
export function pickXcursorImage(bytes, want) {
    if (bytes.length < 16)
        return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) !== XCUR_MAGIC)
        return null;
    const headerSize = v.getUint32(4, true);
    const ntoc = v.getUint32(12, true);
    let best = null;
    for (let i = 0; i < ntoc; i++) {
        const entry = headerSize + i * 12;
        if (entry + 12 > bytes.length)
            return null;
        if (v.getUint32(entry, true) !== XCUR_IMAGE)
            continue;
        const nominal = v.getUint32(entry + 4, true);
        const fits = nominal >= want;
        const bestFits = best && best.nominal >= want;
        const better = !best || (fits && !bestFits) ||
            (fits && bestFits && nominal < best.nominal) || (!fits && !bestFits && nominal > best.nominal);
        if (better)
            best = { nominal, pos: v.getUint32(entry + 8, true) };
    }
    if (!best || best.pos + 36 > bytes.length)
        return null;
    const pos = best.pos;
    const width = v.getUint32(pos + 16, true);
    const height = v.getUint32(pos + 20, true);
    const start = pos + v.getUint32(pos, true);
    const end = start + width * height * 4;
    if (!width || !height || end > bytes.length)
        return null;
    return {
        width, height, nominal: best.nominal,
        xhot: v.getUint32(pos + 24, true), yhot: v.getUint32(pos + 28, true),
        pixels: bytes.slice(start, end),
    };
}
