// SPDX-License-Identifier: GPL-3.0-or-later
// Tile motion: the pure part. No gi imports.
//
// A tile (zone, half, Fill, shortcut, drag drop, Return to Previous Size) moves the window's frame
// from rect A to rect B. The adapter (tileMotion.js) shows the move as a flight of the real window
// actor: the actor is scaled and shifted so its *frame* sits on a rect that travels from A to B.
// Only one bitmap is ever drawn, scaled down towards it, never a small bitmap stretched up:
//
//   grow    B is not smaller than A: resize at once, the new, larger buffer flies in from A's size
//   shrink  B is smaller: the old, larger buffer shrinks to B first, then the app is resized
//
//   planTile(...)       whether and how a move is animated
//   lerpRect(a, b, t)   the rect at progress t
//   frameTransform(...) the actor transform that puts its current frame on a wanted rect
//   isSettled(...)      the app's frame has reached the target

export const MIN_TRAVEL = 2;   // px: a smaller move is not worth a flight

const area = r => r.width * r.height;

/**
 * @param {object} p
 * @param {{x,y,width,height}} p.from the frame before
 * @param {{x,y,width,height}} p.to the frame wanted
 * @param {{animations: boolean, reducedMotion: boolean}} p.env core/motion env
 * @param {boolean} p.visible the window is mapped and drawn (not minimized, not hidden)
 * @param {boolean} p.fullscreen full screen has its own Space switch: no flight
 * @returns {'grow'|'shrink'|null} null: place the window at once
 */
export function planTile({ from, to, env, visible, fullscreen }) {
    if (!env.animations || env.reducedMotion || !visible || fullscreen)
        return null;
    if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0)
        return null;
    const travel = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y),
        Math.abs(from.width - to.width), Math.abs(from.height - to.height));
    if (travel < MIN_TRAVEL)
        return null;
    return area(to) >= area(from) ? 'grow' : 'shrink';
}

/** The rect at progress t (0 = a, 1 = b). */
export function lerpRect(a, b, t) {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        width: a.width + (b.width - a.width) * t,
        height: a.height + (b.height - a.height) * t,
    };
}

/**
 * The transform of a window actor that puts its frame `cur` (the app's frame right now) on the
 * rect `want`. The pivot is the frame's top-left corner, so the actor's position is untouched:
 * scale about the corner, then shift the corner.
 *
 * @returns {{scaleX: number, scaleY: number, tx: number, ty: number}}
 */
export function frameTransform(want, cur) {
    return {
        scaleX: cur.width > 0 ? want.width / cur.width : 1,
        scaleY: cur.height > 0 ? want.height / cur.height : 1,
        tx: want.x - cur.x,
        ty: want.y - cur.y,
    };
}

/** The app's frame is where it was asked to be (within a pixel). */
export function isSettled(cur, to) {
    return Math.abs(cur.x - to.x) <= 1 && Math.abs(cur.y - to.y) <= 1 &&
        Math.abs(cur.width - to.width) <= 1 && Math.abs(cur.height - to.height) <= 1;
}
