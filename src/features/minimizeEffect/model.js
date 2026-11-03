// SPDX-License-Identifier: GPL-3.0-or-later
// Minimize effects: the pure part. No gi imports.
//
//   readConfig(get)          settings -> {effect}
//   chooseMode(...)          which effect a minimize or restore gets
//   genieFrame(...)          a window and its target in the dock's frame of reference
//   genieRow(...)            where one line of the window (across the funnel) is at a given progress
//   genieVertex(...)         where one point of the window mesh is at a given progress
//   genieOpacity(p)          the fade at the very end of the funnel
//   scaleTarget(...)         the end transform of the Scale effect
//   scaleFrame(...)          the Scale effect's actor properties at a given progress
//   edgeTarget(...)          where a window goes when the dock shows no icon for it
//   retarget(...)            where an effect cut in on resumes, and for how long
//   textureBox(...)          the stage rect an offscreen effect's texture covers
//
// The Genie ("magic lamp"): the edge of the window nearest the dock pinches into a funnel
// whose sides are smooth S-curves, then the whole window slides down the funnel into the
// icon. Everything is computed in a canonical frame where `s` grows towards the dock and `l`
// runs along it, so a bottom, left or right dock share one formula. Restore plays it backwards.

export const EFFECTS = Object.freeze(['genie', 'scale', 'gnome']);

/** The funnel forms during the first part, the slide overlaps and ends it. */
const BEND_END = 0.55;
const SLIDE_START = 0.3;
/** The window fades over the last stretch, as it enters the icon. */
const FADE_START = 0.85;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = t => t * t * (3 - 2 * t);
const easeIn = t => t * t;

/**
 * @param {{string: Function}} get typed getters
 * @returns {{effect: string}}
 */
export function readConfig(get) {
    const effect = get.string('dock-minimize-effect');
    return Object.freeze({ effect: EFFECTS.includes(effect) ? effect : 'genie' });
}

/**
 * Which effect a minimize (or restore) gets.
 *   'stock'  leave it to GNOME (another feature owns this window, or the effect is 'gnome')
 *   'none'   animations are off: complete at once
 *   'fade'   reduced motion: the window fades where it is
 *   'scale'  shrink into the target
 *   'genie'  the magic lamp into the target
 *
 * @param {object} p
 * @param {string} p.effect config.effect
 * @param {{animations: boolean, reducedMotion: boolean, degraded?: boolean}} p.env core/motion env
 * @param {boolean} p.normal a normal window or dialog (the Shell animates only those)
 * @param {boolean} p.flagged WindowState says another feature set it aside
 * @param {boolean} p.hasTarget a target rect is known (edgeTarget() gives one on any monitor)
 * @param {boolean} [p.overview] the overview is open
 * @returns {'stock'|'none'|'fade'|'scale'|'genie'}
 */
export function chooseMode({ effect, env, normal, flagged, hasTarget, overview }) {
    if (effect === 'gnome' || !normal || flagged)
        return 'stock';
    // The overview animates its own previews (GNOME skips the effect there too)
    if (!env.animations || overview)
        return 'none';
    if (env.reducedMotion)
        return 'fade';
    if (!hasTarget)
        return 'stock';
    // The Genie warps the window mesh every frame: a Shell over its frame budget plays Scale instead
    return effect === 'scale' || env.degraded ? 'scale' : 'genie';
}

/**
 * The window and its target in the canonical frame (s towards the dock, l along it).
 *
 * @param {'bottom'|'left'|'right'} position the dock's edge
 * @param {{x,y,width,height}} win the window actor's rect (stage)
 * @param {{x,y,width,height}} target the icon rect (stage)
 * @returns {object} frozen frame
 */
export function genieFrame(position, win, target) {
    const tcx = target.x + target.width / 2;
    const tcy = target.y + target.height / 2;
    let sFar, extent, l0, length, sT, lT, widthT;
    if (position === 'left') {
        sFar = -(win.x + win.width);
        extent = win.width;
        l0 = win.y;
        length = win.height;
        sT = -tcx;
        lT = tcy;
        widthT = target.height;
    } else if (position === 'right') {
        sFar = win.x;
        extent = win.width;
        l0 = win.y;
        length = win.height;
        sT = tcx;
        lT = tcy;
        widthT = target.height;
    } else {
        sFar = win.y;
        extent = win.height;
        l0 = win.x;
        length = win.width;
        sT = tcy;
        lT = tcx;
        widthT = target.width;
    }
    return Object.freeze({
        position, sFar, extent, l0, length, sT, lT,
        widthT: Math.max(1, widthT),
        // The bottom edge reaches the icon during the bend; never pull it away from the dock
        reach: Math.max(0, sT - (sFar + extent)),
        winX: win.x, winY: win.y, winW: win.width, winH: win.height,
    });
}

/**
 * Where one row of the window goes: the rows are the lines of the window across the funnel
 * (parallel to the dock). `d` runs from the far edge (0) to the edge facing the dock (1);
 * the result is in the canonical frame (`s` towards the dock, `l` along it).
 *
 * @param {object} f genieFrame()
 * @param {number} d position across the window, 0..1 (outside it, the curve carries on)
 * @param {number} p progress, 0 = the window, 1 = in the icon
 * @param {{s: number, centre: number, width: number}} out written and returned
 * @returns {{s: number, centre: number, width: number}} out
 */
export function genieRow(f, d, p, out) {
    const bend = smooth(clamp01(p / BEND_END));
    const slide = easeIn(clamp01((p - SLIDE_START) / (1 - SLIDE_START)));
    const w = smooth(clamp01(d));
    // Funnel: rows nearer the dock narrow first; the slide narrows the rest
    const pinch = bend * w;
    const c = pinch + slide * (1 - pinch);
    const centre = f.l0 + f.length / 2;
    out.centre = centre + (f.lT - centre) * c;
    out.width = f.length + (f.widthT - f.length) * c;
    // Stretch the near edge to the icon, then slide everything into it
    const sBent = f.sFar + d * f.extent + bend * f.reach * w;
    out.s = sBent + (f.sT - sBent) * slide;
    return out;
}

const ROW = { s: 0, centre: 0, width: 0 };

/**
 * Where a mesh point goes. `x`, `y` are in the actor's own coordinates (0..width,
 * 0..height); the result is too (written into `out`, so a frame allocates nothing).
 *
 * @param {object} f genieFrame()
 * @param {number} x
 * @param {number} y
 * @param {number} width actor width
 * @param {number} height actor height
 * @param {number} p progress, 0 = the window, 1 = in the icon
 * @param {{x: number, y: number}} out
 * @returns {{x: number, y: number}} out
 */
export function genieVertex(f, x, y, width, height, p, out) {
    const u = width > 0 ? x / width : 0;
    const v = height > 0 ? y / height : 0;
    // Canonical coordinates: d from the far edge (0) to the edge facing the dock (1)
    let d, lt;
    if (f.position === 'left') {
        d = 1 - u;
        lt = v;
    } else if (f.position === 'right') {
        d = u;
        lt = v;
    } else {
        d = v;
        lt = u;
    }
    const row = genieRow(f, d, p, ROW);
    const l = row.centre + (lt - 0.5) * row.width;
    // Back to stage coordinates, then to the actor's
    let sx, sy;
    if (f.position === 'left') {
        sx = -row.s;
        sy = l;
    } else if (f.position === 'right') {
        sx = row.s;
        sy = l;
    } else {
        sx = l;
        sy = row.s;
    }
    out.x = sx - f.winX;
    out.y = sy - f.winY;
    return out;
}

/** Opacity (0..255) at progress p: solid until the window enters the icon. */
export function genieOpacity(p) {
    return Math.round(255 * (1 - smooth(clamp01((p - FADE_START) / (1 - FADE_START)))));
}

/**
 * The Scale effect's end: the window shrunk into the target, centred on it, keeping its
 * aspect ratio (scale about the actor's top-left corner, pivot 0,0).
 *
 * @param {{x,y,width,height}} win
 * @param {{x,y,width,height}} target
 * @returns {{x: number, y: number, scale: number}}
 */
export function scaleTarget(win, target) {
    const scale = Math.min(target.width / Math.max(1, win.width), target.height / Math.max(1, win.height));
    return {
        x: target.x + (target.width - win.width * scale) / 2,
        y: target.y + (target.height - win.height * scale) / 2,
        scale,
    };
}

/**
 * The Scale effect's actor properties at progress p (0 = the window, 1 = in the target).
 *
 * @param {{x: number, y: number}} from the window's place
 * @param {{x: number, y: number, scale: number}} end scaleTarget()
 * @param {number} p
 * @returns {{x: number, y: number, scale: number, opacity: number}}
 */
export function scaleFrame(from, end, p) {
    const q = clamp01(p);
    return {
        x: from.x + (end.x - from.x) * q,
        y: from.y + (end.y - from.y) * q,
        scale: 1 + (end.scale - 1) * q,
        opacity: Math.round(255 * (1 - q)),
    };
}

/**
 * Where a window minimizes to when the dock gives no icon (the dock is hidden, auto-hidden,
 * off, still starting, or the app has no tile): the middle of the dock's edge of the
 * window's monitor, an icon-sized square, as if the icon sat there.
 *
 * @param {'bottom'|'left'|'right'} position the dock's edge
 * @param {?{x,y,width,height}} monitor the window's monitor
 * @param {number} [size] the square's side
 * @returns {?{x,y,width,height}} null without a monitor
 */
export function edgeTarget(position, monitor, size = 48) {
    if (!monitor || !(monitor.width > 0) || !(monitor.height > 0))
        return null;
    const cx = Math.round(monitor.x + (monitor.width - size) / 2);
    const cy = Math.round(monitor.y + (monitor.height - size) / 2);
    if (position === 'left')
        return { x: monitor.x, y: cy, width: size, height: size };
    if (position === 'right')
        return { x: monitor.x + monitor.width - size, y: cy, width: size, height: size };
    return { x: cx, y: monitor.y + monitor.height - size, width: size, height: size };
}

/**
 * An effect cut in on (minimize, then restore before it ends, or the reverse) carries on
 * from where it is towards the new end, in the share of the full duration that is left.
 *
 * @param {?number} progress how far the interrupted effect got (0 = the window, 1 = in the
 *   target); null or undefined: nothing was running, start from the far end
 * @param {boolean} restoring the new direction
 * @param {number} fullMs the full effect's duration
 * @returns {{from: number, to: number, duration: number}}
 */
export function retarget(progress, restoring, fullMs) {
    const to = restoring ? 0 : 1;
    const from = progress === null || progress === undefined || Number.isNaN(progress)
        ? 1 - to : clamp01(progress);
    return { from, to, duration: Math.round(Math.max(0, fullMs) * Math.abs(to - from)) };
}

/**
 * The stage rect a Clutter.OffscreenEffect's texture covers. Clutter pads the actor's box for
 * effects (_clutter_actor_box_enlarge_for_effects: right edge ceil(x2 + 0.75), width rounded
 * plus 3), in device pixels or in logical ones scaled after; the texture size tells which.
 *
 * @param {{x,y,width,height}} box the actor's stage rect (whole logical pixels)
 * @param {number} texWidth
 * @param {number} texHeight
 * @param {number} scale the actor's resource scale
 * @returns {{x,y,width,height}} in logical stage pixels
 */
export function textureBox(box, texWidth, texHeight, scale) {
    const s = Math.max(1, Math.ceil(scale));
    const axis = (pos, len, tex) => {
        // Padded in device pixels: tex = len * s + 3; padded before scaling: tex = (len + 3) * s
        const unit = Math.abs(tex - (len * s + 3)) <= Math.abs(tex - (len + 3) * s) ? 1 / s : 1;
        const end = Math.ceil((pos + len) / unit + 0.75) * unit;
        return { pos: end - tex / s, len: tex / s };
    };
    const x = axis(box.x, box.width, texWidth);
    const y = axis(box.y, box.height, texHeight);
    return { x: x.pos, y: y.pos, width: x.len, height: y.len };
}
