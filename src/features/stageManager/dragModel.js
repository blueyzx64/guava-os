// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager drag and drop (B31, SM-34): where a dragged thumbnail or window lands. Pure maths,
// no gi imports (tests: tests/stageManagerDrag.test.js).
//
//   rect  {x, y, width, height}, absolute pixels
//   point {x, y}

/** The pointer must move this far from the press before a press becomes a drag (a click is not one). */
export const DRAG_PX = 8;

/** A drop zone reaches this far past a thumbnail's box, so a drop near it counts. */
export const CARD_SLACK = 9;

export function inside(p, r) {
    return !!r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** Has the pointer moved far enough from the press to start a drag? */
export function dragStarted(start, p, threshold = DRAG_PX) {
    return Math.hypot(p.x - start.x, p.y - start.y) >= threshold;
}

/**
 * Where a dragged thumbnail would land: 'stage' (its set joins the stage set) over the work area
 * outside the strip band, otherwise null (a release there puts the thumbnail back).
 * @param {point} p
 * @param {{band: ?rect, workArea: ?rect}} area
 */
export function thumbDropTarget(p, { band, workArea }) {
    if (!inside(p, workArea) || inside(p, band))
        return null;
    return 'stage';
}

/**
 * Where a dragged stage window would land: a thumbnail (the window joins that set), the strip
 * band (the window becomes a set of its own, SM-25), or nothing.
 * @param {point} p
 * @param {{band: ?rect, cards: {id: number, rect: rect}[]}} area
 * @returns {?{kind: 'set', id: number}|{kind: 'strip'}}
 */
export function windowDropTarget(p, { band, cards }) {
    for (const card of cards) {
        const r = card.rect;
        const hit = { x: r.x - CARD_SLACK, y: r.y - CARD_SLACK, width: r.width + 2 * CARD_SLACK, height: r.height + 2 * CARD_SLACK };
        if (inside(p, hit))
            return { kind: 'set', id: card.id };
    }
    return inside(p, band) ? { kind: 'strip' } : null;
}

/** The pointer is in the screen-edge zone where a window drag reveals the strip. */
export function nearStripEdge(p, { workArea, side, reach }) {
    if (!workArea)
        return false;
    return side === 'right' ? p.x >= workArea.x + workArea.width - reach : p.x < workArea.x + reach;
}

/** A drag that ended with the window where it began was cancelled (Esc): nothing is dropped. */
export function sameFrame(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
