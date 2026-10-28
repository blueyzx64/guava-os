// SPDX-License-Identifier: GPL-3.0-or-later
// The pure geometry of lib/inputRing.js. No gi:// imports. Tested by tests/inputRingModel.test.js.

/**
 * `outer` minus `hole`, as up to four boxes (top, bottom, left, right) that tile the rest. With no
 * hole it is `outer` alone. Used for the input layers that cover the stage (outside-click
 * catchers) or stand in for the notch, and leave a hole to what lies below.
 * @param {{x: number, y: number, w: number, h: number}} outer
 * @param {{x: number, y: number, w: number, h: number}|null} hole
 * @returns {Array<{x: number, y: number, w: number, h: number}>}
 */
export function surround(outer, hole) {
    if (!hole)
        return [outer];
    const x1 = Math.max(outer.x, Math.min(outer.x + outer.w, hole.x));
    const x2 = Math.max(x1, Math.min(outer.x + outer.w, hole.x + hole.w));
    const y1 = Math.max(outer.y, Math.min(outer.y + outer.h, hole.y));
    const y2 = Math.max(y1, Math.min(outer.y + outer.h, hole.y + hole.h));
    const right = outer.x + outer.w;
    const bottom = outer.y + outer.h;
    return [
        { x: outer.x, y: outer.y, w: outer.w, h: y1 - outer.y },
        { x: outer.x, y: y2, w: outer.w, h: bottom - y2 },
        { x: outer.x, y: y1, w: x1 - outer.x, h: y2 - y1 },
        { x: x2, y: y1, w: right - x2, h: y2 - y1 },
    ].filter(r => r.w > 0 && r.h > 0);
}
