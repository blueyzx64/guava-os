// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager geometry: where the strip, its entries and the flying windows go. Pure maths,
// no gi imports (tests: tests/stageManagerGeometry.test.js).
//
//   rect  {x, y, width, height}, absolute pixels

export const METRICS = Object.freeze({
    stripWidth: 200,      // the band the strip owns at the screen edge
    thumbW: 180,          // an entry's box at scale 1
    thumbH: 130,
    gap: 18,
    padTop: 24,
    padBottom: 24,
    minScale: 0.55,       // entries shrink to this at most; then fewer are listed
    floorPad: 14,         // the strip's hover area above and below the entries
    cardPad: 14,          // between an entry's box and the window inside it (scaled)
    badge: 34,            // app icon badge at scale 1
    stackMax: 3,          // windows drawn per entry
    tilt: 22,             // degrees: windows turn to face the stage
});

export function overlaps(a, b) {
    return !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Where a stage window is going to be. A client takes a few frames to answer a maximize or
 * restore, so the frame rect still shows the old size while the window already is maximized;
 * the strip reacts to the state, not to the frame, and so hides or shows once, on time.
 * @param {rect} frame the window's frame rect now
 * @param {boolean} maximized
 * @param {?rect} workArea the work area of its monitor
 */
export function stageRect(frame, maximized, workArea) {
    return maximized && workArea ? workArea : frame;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * The strip's side. It goes opposite a dock on the left or right edge (macOS); otherwise
 * where the user put it.
 * @param {'left'|'right'} preferred stage-manager-side
 * @param {?string} dockEdge the edge of the dock's layout claim, null without a dock
 */
export function stripSide(preferred, dockEdge) {
    if (dockEdge === 'left')
        return 'right';
    if (dockEdge === 'right')
        return 'left';
    return preferred === 'right' ? 'right' : 'left';
}

/**
 * Where the strip band, its entries and the glass floor under them go. Entries shrink to
 * m.minScale to fit the height; past that the strip scrolls: the floor is the whole band
 * height and `scrollMax` is how far the content can move.
 * @param {{workArea: rect, side: 'left'|'right', count: number}} args
 * @returns {{band: rect, slots: rect[], floor: ?rect, scale: number, scrollMax: number}}
 */
export function stripLayout({ workArea, side, count }, m = METRICS) {
    const x0 = side === 'right' ? workArea.x + workArea.width - m.stripWidth : workArea.x;
    const band = { x: x0, y: workArea.y, width: m.stripWidth, height: workArea.height };
    const n = Math.max(0, Math.floor(count));
    if (n === 0)
        return { band, slots: [], floor: null, scale: 1, scrollMax: 0 };
    const avail = Math.max(1, workArea.height - m.padTop - m.padBottom);
    const scale = clamp(avail / (n * m.thumbH + (n - 1) * m.gap), m.minScale, 1);
    const w = Math.round(m.thumbW * scale);
    const h = Math.round(m.thumbH * scale);
    const gap = Math.round(m.gap * scale);
    const total = n * h + (n - 1) * gap;
    const scrolls = total > avail;
    const top = scrolls ? workArea.y + m.padTop : Math.round(workArea.y + m.padTop + (avail - total) / 2);
    const x = Math.round(x0 + (m.stripWidth - w) / 2);
    const slots = [];
    for (let i = 0; i < n; i++)
        slots.push({ x, y: top + i * (h + gap), width: w, height: h });
    // The whole band, so the area reaches the screen edge
    const floor = scrolls ? band : { x: x0, y: top - m.floorPad, width: m.stripWidth, height: total + 2 * m.floorPad };
    const scrollMax = scrolls ? m.padTop + total + m.padBottom - workArea.height : 0;
    return { band, slots, floor, scale, scrollMax };
}

/**
 * Opacity (0..1) of a slot while the strip is scrolled: 1 when its near edge is at least the
 * padding inside the floor (the rest position), fading to 0 as that edge reaches the floor's
 * top or bottom, so nothing is drawn over the top bar or the screen edge. No clipping, no
 * offscreen pass.
 * @param {rect} slot absolute, unscrolled
 * @param {number} offset scroll distance
 * @param {rect} floor the visible band
 */
export function edgeFade(slot, offset, floor, m = METRICS) {
    const top = slot.y - offset - floor.y;
    const edge = Math.min(top, floor.height - (top + slot.height));
    return clamp(edge / m.padTop, 0, 1);
}

/** The scroll offset that brings a slot fully into the padded view, from the current one. */
export function revealOffset(slot, offset, floor, scrollMax, m = METRICS) {
    const top = slot.y - floor.y;
    let next = offset;
    if (top - offset < m.padTop)
        next = top - m.padTop;
    else if (top + slot.height - offset > floor.height - m.padBottom)
        next = top + slot.height - floor.height + m.padBottom;
    return clamp(next, 0, scrollMax);
}

/**
 * A window's size in an entry: its own aspect, about the same visual weight whatever its
 * shape (scaled toward `fill` of the box area, then fitted in the box).
 */
export function balancedFit(w, h, maxW, maxH, fill = 0.6) {
    if (!(w > 0) || !(h > 0) || !(maxW > 0) || !(maxH > 0))
        return { width: 0, height: 0, scale: 0 };
    let scale = Math.sqrt(clamp(fill, 0, 1) * maxW * maxH / (w * h));
    scale = Math.min(scale, maxW / w, maxH / h);
    return { width: w * scale, height: h * scale, scale };
}

/**
 * Layers of an entry, front first. Back layers peek out toward the screen edge; a set of
 * different apps fans out more and stays opaque.
 */
export function stackLayers(count, side, { set = false } = {}, m = METRICS) {
    const n = clamp(Math.floor(count) || 0, 0, m.stackMax);
    const dir = side === 'right' ? 1 : -1;
    const step = set ? { dx: 16, dy: -12, scale: 0.05, fade: 0.08, tilt: 3 }
        : { dx: 7, dy: -6, scale: 0.06, fade: 0.28, tilt: 0 };
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            index: i, dx: dir * i * step.dx, dy: i * step.dy, scale: 1 - i * step.scale,
            opacity: Math.round(255 * (1 - i * step.fade)), tilt: -dir * i * step.tilt,
        });
    }
    return out;
}

/** Y rotation in degrees: the window's far edge turns away on the stage side. */
export function tiltAngle(side, degrees) {
    return side === 'right' ? -degrees : degrees;
}

/**
 * Where one layer draws its window's frame inside an entry box (box-relative).
 * @param {{width, height}} frame
 * @param {rect} box the entry's slot, padded
 * @param {object} layer from stackLayers()
 * @param {number} scale the strip's scale
 */
export function layerRect(frame, box, layer, scale) {
    const fit = balancedFit(frame.width, frame.height, box.width, box.height);
    const width = fit.width * layer.scale;
    const height = fit.height * layer.scale;
    // Whole pixels, so the unrotated edges fall on pixel boundaries
    return {
        x: Math.round(box.x + (box.width - width) / 2 + layer.dx * scale),
        y: Math.round(box.y + (box.height - height) / 2 + layer.dy * scale),
        width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)),
    };
}

/** The padded box windows are drawn in, inside a slot (slot-relative). */
export function slotBox(slot, scale, m = METRICS) {
    // Room on the sides for the tilt's near edge, so windows stay on the floor
    const padX = Math.max(6, Math.round(m.cardPad * 1.7 * scale));
    const padY = Math.max(4, Math.round(m.cardPad * 0.7 * scale));
    return { x: padX, y: padY, width: slot.width - 2 * padX, height: slot.height - 2 * padY };
}

/**
 * Pose of a window clone (sized like the buffer) whose frame is drawn in `rect`, centred,
 * aspect kept, turned about the frame centre. Because the pivot is the frame centre, x and y
 * do not depend on scale or angle, so a flight can tween all of them at once.
 * @returns {?{x, y, pivotX, pivotY, scale, scaleX, scaleY}} pivot normalised to the buffer size;
 * scaleX/scaleY make the frame exactly rect-sized (whole pixels), scale is their minimum
 */
export function clonePose(frame, buffer, rect) {
    if (!(frame.width > 0) || !(frame.height > 0) || !(buffer.width > 0) || !(buffer.height > 0) ||
        !(rect.width > 0) || !(rect.height > 0))
        return null;
    const px = frame.x - buffer.x + frame.width / 2;
    const py = frame.y - buffer.y + frame.height / 2;
    return {
        x: rect.x + rect.width / 2 - px,
        y: rect.y + rect.height / 2 - py,
        pivotX: px / buffer.width,
        pivotY: py / buffer.height,
        scaleX: rect.width / frame.width,
        scaleY: rect.height / frame.height,
        scale: Math.min(rect.width / frame.width, rect.height / frame.height),
    };
}

/** A small rect on a point (where a window shrinks to when its entry is not shown). */
export function pointRect(point, frame, width = 24) {
    const h = frame.width > 0 ? width * frame.height / frame.width : width;
    return { x: point.x - width / 2, y: point.y - h / 2, width, height: h };
}

/**
 * The pressure barrier on the strip's screen edge that reveals a hidden strip. Null when
 * another monitor continues past that edge (a barrier would block the pointer crossing).
 * @returns {?{x1, x2, y1, y2, direction: 'positive'|'negative'}}
 */
export function edgeBarrier(workArea, monitor, others, side) {
    const right = side === 'right';
    const x = right ? monitor.x + monitor.width : monitor.x;
    const y1 = workArea.y;
    const y2 = workArea.y + workArea.height;
    const neighbour = others.some(o => {
        const touches = right ? o.x === monitor.x + monitor.width : o.x + o.width === monitor.x;
        return touches && o.y < y2 && o.y + o.height > y1;
    });
    if (neighbour || y2 <= y1)
        return null;
    return { x1: x, x2: x, y1, y2, direction: right ? 'negative' : 'positive' };
}

/**
 * Is the strip shown?
 * @param {object} s
 * @param {boolean} s.showRecent "Show recent apps": off keeps it hidden until revealed
 * @param {boolean} s.autohide steps aside while a stage window overlaps it
 * @param {boolean} s.overlapped a visible stage window overlaps the strip's floor
 * @param {boolean} s.revealed the pointer pushed the edge or is on the strip, or a drag needs it
 * @param {boolean} s.suppressed Mission Control, a full-screen window, nothing to list
 */
export function stripVisible({ showRecent, autohide, overlapped, revealed, suppressed }) {
    if (suppressed)
        return false;
    if (revealed)
        return true;
    if (!showRecent)
        return false;
    return !(autohide && overlapped);
}

/** A duration under the user's animation speed (1 normal, 2 twice as fast). */
export function scaleMs(ms, speed = 1) {
    const s = Number.isFinite(speed) && speed > 0 ? clamp(speed, 0.25, 4) : 1;
    return Math.max(0, Math.round(ms / s));
}

/** +1 when moving to a later workspace, -1 back, 0 none. */
export function workspaceDirection(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to)
        return 0;
    return to > from ? 1 : -1;
}

/**
 * What a window dragged by its titlebar does to the strip, from the pointer.
 * 'over': on an entry (a drop joins it). 'near': in the strip's floor, so it stays out. null:
 * elsewhere, and always in the screen-edge zone where Mutter tiles or maximizes the window
 * (the drag must still be able to tile).
 * @param {{x, y}} point
 * @param {{floor: ?rect, onEntry: boolean, workArea: rect, zone: number}} ctx
 * @returns {?('over'|'near')}
 */
export function dropHint(point, { floor, onEntry, workArea, zone }) {
    const inZone = point.x < workArea.x + zone || point.x >= workArea.x + workArea.width - zone ||
        point.y < workArea.y + zone;
    if (inZone || !floor || !overlaps({ x: point.x, y: point.y, width: 1, height: 1 }, floor))
        return null;
    return onEntry ? 'over' : 'near';
}

/** Index of the slot under a point, or -1. */
export function slotAt(slots, point) {
    return slots.findIndex(s => point.x >= s.x && point.x < s.x + s.width &&
        point.y >= s.y && point.y < s.y + s.height);
}

/**
 * The stage: the work area beside the strip's band, inset by `margin`. Entries dropped here
 * join the set; windows of a new set are tiled in its halves.
 * @param {rect} workArea
 * @param {?rect} floor the strip's floor (null: the whole work area)
 * @param {'left'|'right'} side the strip's side
 */
export function stageArea(workArea, floor, side, margin = 12) {
    const left = floor && side === 'left' ? floor.x + floor.width + margin : workArea.x + margin;
    const right = floor && side !== 'left' ? floor.x - margin : workArea.x + workArea.width - margin;
    return { x: left, y: workArea.y + margin, width: Math.max(1, right - left), height: Math.max(1, workArea.height - 2 * margin) };
}

/** The two halves of an area, `gap` apart, in whole pixels. */
export function halves(area, gap = 12) {
    const w = Math.floor((area.width - gap) / 2);
    return {
        left: { x: area.x, y: area.y, width: w, height: area.height },
        right: { x: area.x + area.width - w, y: area.y, width: w, height: area.height },
    };
}

/** Which half of a card the pointer is over: where a dragged entry will be placed. */
export function groupSide(point, card) {
    return point.x < card.x + card.width / 2 ? 'left' : 'right';
}
