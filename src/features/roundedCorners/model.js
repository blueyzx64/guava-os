// SPDX-License-Identifier: GPL-3.0-or-later
// Rounded corners: pure decisions and geometry. No gi:// imports (tests run it under gjs -m).
//
// Which windows get corners (qualifies), the radius clamp, the frame inset inside the window
// actor (CSD shadow margins), and the mapping from actor-local logical pixels to the pixels of
// the offscreen texture a Clutter.OffscreenEffect paints (fboOrigin, shaderGeometry).

export const RADIUS_MIN = 0;
export const RADIUS_MAX = 24;
export const RADIUS_DEFAULT = 12;

/** Which corners are rounded: the `rounded-corners-which` setting. */
export const WHICH_VALUES = Object.freeze(['top', 'all']);
export const WHICH_DEFAULT = 'top';

/**
 * The per-corner mask the shader takes.
 *
 * @param {string} which 'top' (top-left and top-right only) or 'all'; junk means the default
 * @returns {number[]} 1 (rounded) or 0 (square) for top-left, top-right, bottom-right, bottom-left
 */
export function cornerMask(which) {
    const w = WHICH_VALUES.includes(which) ? which : WHICH_DEFAULT;
    return w === 'all' ? [1, 1, 1, 1] : [1, 1, 0, 0];
}

/** Window types that get corners. Menus, tooltips, DND icons, docks and desktops never do. */
export const ROUNDED_TYPES = Object.freeze(['normal', 'dialog', 'modal-dialog']);

/**
 * @param {number} value the setting
 * @returns {number} an integer in RADIUS_MIN..RADIUS_MAX (the default for junk)
 */
export function clampRadius(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return RADIUS_DEFAULT;
    return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(n)));
}

/**
 * The radius that fits a frame: never more than half its shorter side.
 *
 * @param {number} radius logical px
 * @param {number} width frame width
 * @param {number} height frame height
 * @returns {number}
 */
export function fitRadius(radius, width, height) {
    return Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
}

/** Lower-case id with a trailing ".desktop" removed; '' for nothing. */
export function normalizeId(id) {
    if (typeof id !== 'string')
        return '';
    return id.trim().toLowerCase().replace(/\.desktop$/, '');
}

/**
 * @param {(string|null|undefined)[]} ids WM_CLASS, WM_CLASS instance, app ids of a window
 * @param {string[]} blacklist the setting
 * @returns {boolean} one of the ids is listed
 */
export function isExcluded(ids, blacklist) {
    const listed = new Set((blacklist ?? []).map(normalizeId).filter(Boolean));
    if (listed.size === 0)
        return false;
    return ids.map(normalizeId).some(id => id && listed.has(id));
}

/**
 * Should this window be rounded right now?
 *
 * @param {{type: string, overrideRedirect: boolean, maximizedH: boolean, maximizedV: boolean,
 *   fullscreen: boolean, shellOwned: boolean, title: ?string, ids: string[]}} info
 * @param {{radius: number, blacklist: string[], roundMaximized?: boolean}} config roundMaximized: a
 *   window maximized both ways keeps its top corners (the menu bar is transparent over them)
 * @returns {boolean}
 */
export function qualifies(info, config) {
    if (clampRadius(config.radius) <= 0)
        return false;
    if (!ROUNDED_TYPES.includes(info.type) || info.overrideRedirect || info.shellOwned)
        return false;
    // Fullscreen; maximized, unless the transparent menu bar shows its corners; or tiled to a half
    // (mutter tiles by maximizing one direction)
    if (info.fullscreen)
        return false;
    if (info.maximizedH || info.maximizedV) {
        if (!(config.roundMaximized && info.maximizedH && info.maximizedV))
            return false;
    }
    // Desktop-icons extensions draw the desktop as a normal window titled '@!x,y;...'
    if (typeof info.title === 'string' && info.title.startsWith('@!'))
        return false;
    return !isExcluded(info.ids, config.blacklist);
}

/**
 * The visible frame inside the window actor, in actor-local logical pixels. The actor covers
 * the buffer rect; client-side decorated windows draw invisible shadow margins around the frame.
 *
 * @param {{x: number, y: number, width: number, height: number}} frame meta_window_get_frame_rect
 * @param {{x: number, y: number, width: number, height: number}} buffer meta_window_get_buffer_rect
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function frameInActor(frame, buffer) {
    return { x: frame.x - buffer.x, y: frame.y - buffer.y, width: frame.width, height: frame.height };
}

// clutter-private.h CLUTTER_NEARBYINT
const nearbyint = x => Math.trunc(x < 0 ? x - 0.5 : x + 0.5);

/**
 * clutter_actor_box_enlarge_for_effects() (mutter 50 clutter-actor-box.c): a stable,
 * pixel-aligned box padded by at least 0.75 px on each side.
 *
 * @param {{x1: number, y1: number, x2: number, y2: number}} box
 * @returns {{x1: number, y1: number, x2: number, y2: number}}
 */
export function enlargeForEffects(box) {
    const width = box.x2 - box.x1;
    const height = box.y2 - box.y1;
    if (width * height === 0)
        return { ...box };
    const x2 = Math.ceil(box.x2 + 0.75);
    const y2 = Math.ceil(box.y2 + 0.75);
    return { x1: x2 - nearbyint(width) - 3, y1: y2 - nearbyint(height) - 3, x2, y2 };
}

/**
 * Where the offscreen texture starts, in actor-local logical pixels. Mirrors
 * clutter_offscreen_effect_pre_paint() (mutter 50): the texture covers the enlarged bounding
 * box of the actor's local paint volume, or of its allocation when it has none.
 *
 * @param {?{x: number, y: number, width: number, height: number}} volume local paint volume
 * @param {{x1: number, y1: number, x2: number, y2: number}} allocation in parent coordinates
 * @returns {{x: number, y: number}}
 */
export function fboOrigin(volume, allocation) {
    if (volume && volume.width > 0 && volume.height > 0) {
        const box = enlargeForEffects({
            x1: volume.x, y1: volume.y, x2: volume.x + volume.width, y2: volume.y + volume.height,
        });
        return { x: Math.trunc(box.x1), y: Math.trunc(box.y1) };
    }
    const box = enlargeForEffects(allocation);
    return { x: Math.trunc(box.x1 - allocation.x1), y: Math.trunc(box.y1 - allocation.y1) };
}

/**
 * Shader uniforms, in texture pixels.
 *
 * @param {object} args
 * @param {{x: number, y: number, width: number, height: number}} args.frame frameInActor()
 * @param {{x: number, y: number}} args.origin fboOrigin()
 * @param {number} args.radius logical px (already clamped)
 * @param {number} args.resourceScale clutter_actor_get_real_resource_scale (1, 1.25, 2...)
 * @param {number} args.texWidth offscreen texture width in px
 * @param {number} args.texHeight offscreen texture height in px
 * @returns {{tex: number[], frame: number[], radius: number, aa: number}}
 *   frame is [x0, y0, x1, y1]; aa is the antialiasing width (one screen pixel)
 */
export function shaderGeometry({ frame, origin, radius, resourceScale, texWidth, texHeight }) {
    const real = resourceScale > 0 ? resourceScale : 1;
    // The texture is rendered at the ceiled scale, then filtered down to the real one
    const s = Math.ceil(real);
    const x0 = (frame.x - origin.x) * s;
    const y0 = (frame.y - origin.y) * s;
    return {
        tex: [texWidth, texHeight],
        frame: [x0, y0, x0 + frame.width * s, y0 + frame.height * s],
        radius: fitRadius(radius, frame.width, frame.height) * s,
        aa: Math.max(1, s / real),
    };
}
