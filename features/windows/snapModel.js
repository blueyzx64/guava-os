// SPDX-License-Identifier: GPL-3.0-or-later
// Pure model of the snap bar (Windows 11 Snap Layouts): its geometry on a monitor, the three
// states it moves through while a window is dragged near the top centre, and which zone of
// which layout a pointer is over. No gi imports: tests/snapModel.test.js.
//
//   hidden --pointer at the top centre--> handle --pointer on the handle--> bar
//   bar --pointer leaves the bar--> handle (collapsed) --pointer leaves its reach--> hidden
//
// Rects are {x, y, width, height} in stage pixels. The bar is computed, never read back from
// actors, so hit testing needs no layout and works from the first frame of the expansion.

import { SNAP_LAYOUTS } from '../../core/tileActions.js';
import { nearRect, zoneRect } from './model.js';

export const SNAP_STATES = Object.freeze({ HIDDEN: 'hidden', HANDLE: 'handle', BAR: 'bar' });

/** The handle (px) and the corner radii it morphs between. */
export const HANDLE_W = 88;
export const HANDLE_H = 14;
export const HANDLE_RADIUS = 7;
export const BAR_RADIUS = 18;

/** Space between the top bar's bottom edge and the handle or bar (px). */
export const TOP_GAP = 6;
/** Bar padding, space between thumbnails, and the gap between zones inside one (px). */
export const BAR_PAD = 12;
export const THUMB_GAP = 10;
export const ZONE_GAP = 3;

/** A thumbnail is a fraction of the monitor's width, within limits (px); its height keeps the monitor's ratio. */
export const THUMB_FRACTION = 0.06;
export const THUMB_MIN_W = 64;
export const THUMB_MAX_W = 104;

/** The top-centre zone that reveals the handle: half its width is a fraction of the monitor, at least this (px). */
export const REVEAL_FRACTION = 0.12;
export const REVEAL_MIN_HALF = 160;
/** How close to the handle the pointer must be to expand it, and how far from it the handle stays (px). */
export const HANDLE_REACH = 6;
export const HANDLE_KEEP = 24;
/** How far outside the bar the pointer may stray before it collapses (px). */
export const BAR_KEEP = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Where everything sits for one monitor.
 *
 * @param {{x, y, width, height}} monitor
 * @param {number} topEdge the y of the top bar's bottom edge
 * @param {{id: string, name: string, zones: string[]}[]} [layouts]
 * @returns {{
 *   handle: object, bar: object, reveal: object,
 *   thumbs: {id: string, name: string, rect: object, zones: {zone: string, rect: object}[]}[]
 * }} thumbnail rects are relative to the bar, zone rects to their thumbnail
 */
export function snapGeometry(monitor, topEdge, layouts = SNAP_LAYOUTS) {
    const tw = clamp(Math.round(monitor.width * THUMB_FRACTION), THUMB_MIN_W, THUMB_MAX_W);
    const th = Math.round(tw * monitor.height / monitor.width);
    const width = layouts.length * tw + (layouts.length - 1) * THUMB_GAP + 2 * BAR_PAD;
    const centre = monitor.x + monitor.width / 2;
    const y = Math.round(topEdge + TOP_GAP);
    const half = Math.max(REVEAL_MIN_HALF, Math.round(REVEAL_FRACTION * monitor.width));
    const area = { x: 0, y: 0, width: tw, height: th };
    return {
        handle: { x: Math.round(centre - HANDLE_W / 2), y, width: HANDLE_W, height: HANDLE_H },
        bar: { x: Math.round(centre - width / 2), y, width, height: th + 2 * BAR_PAD },
        reveal: { x: Math.round(centre - half), y: monitor.y, width: 2 * half, height: topEdge - monitor.y + 1 },
        thumbs: layouts.map((layout, i) => ({
            id: layout.id,
            name: layout.name,
            rect: { x: BAR_PAD + i * (tw + THUMB_GAP), y: BAR_PAD, width: tw, height: th },
            zones: layout.zones.map(zone => ({ zone, rect: zoneRect(zone, area, ZONE_GAP) })),
        })),
    };
}

/**
 * The state after the pointer moved. One step per call: a pointer that jumps onto the handle
 * reveals it first and expands it on the next move.
 *
 * @param {string} state a SNAP_STATES value
 * @param {{x: number, y: number}} p
 * @param {ReturnType<typeof snapGeometry>} geom
 * @returns {string} a SNAP_STATES value
 */
export function nextSnapState(state, p, geom) {
    const inReveal = nearRect(p, geom.reveal);
    const nearHandle = nearRect(p, geom.handle, HANDLE_KEEP);
    switch (state) {
    case SNAP_STATES.BAR:
        if (nearRect(p, geom.bar, BAR_KEEP))
            return SNAP_STATES.BAR;
        return inReveal || nearHandle ? SNAP_STATES.HANDLE : SNAP_STATES.HIDDEN;
    case SNAP_STATES.HANDLE:
        if (nearRect(p, geom.handle, HANDLE_REACH))
            return SNAP_STATES.BAR;
        return inReveal || nearHandle ? SNAP_STATES.HANDLE : SNAP_STATES.HIDDEN;
    default:
        return inReveal ? SNAP_STATES.HANDLE : SNAP_STATES.HIDDEN;
    }
}

/**
 * The zone of the expanded bar under the pointer. Zones keep a small gap inside a thumbnail;
 * the pointer finds the zone nearest across it, so the gap is not a dead spot.
 *
 * @returns {?{layoutId: string, zone: string}} the layout and the key of ZONES, or null
 */
export function snapZoneAt(p, geom) {
    for (const thumb of geom.thumbs) {
        for (const { zone, rect } of thumb.zones) {
            const abs = {
                x: geom.bar.x + thumb.rect.x + rect.x, y: geom.bar.y + thumb.rect.y + rect.y,
                width: rect.width, height: rect.height,
            };
            if (nearRect(p, abs, ZONE_GAP / 2))
                return { layoutId: thumb.id, zone };
        }
    }
    return null;
}

/** The corner radius for a bar of `width`: the handle's at the handle's width, the bar's at full width. */
export function radiusAt(width, barWidth) {
    const t = clamp((width - HANDLE_W) / (barWidth - HANDLE_W), 0, 1);
    return Math.round(HANDLE_RADIUS + t * (BAR_RADIUS - HANDLE_RADIUS));
}
