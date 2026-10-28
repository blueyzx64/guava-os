// SPDX-License-Identifier: GPL-3.0-or-later
// Pure geometry and bookkeeping of Guava's Sequoia-style tiling (macOS 15): tile zones, drag
// hit testing, margins, multi-window arrangements, the tile book (which window holds which
// tile and where it was before) and the shortcut table. No gi imports: tests/windowsModel.test.js.
//
// Rects are {x, y, width, height} in stage pixels. Zones are fractions of a work area
// (core/layout.js workArea(), which already leaves out the menu bar and the dock).

import { normalizeAccel } from '../../lib/keybindingsModel.js';
import { ARRANGEMENTS, ZONES } from '../../core/tileActions.js';

export { ARRANGEMENTS, ZONES, parseAction } from '../../core/tileActions.js';

/** Margin around and between tiles while "Tiled windows have margins" is on (px). */
export const TILE_MARGIN = 8;

/** Drag hit testing (px): how close to a screen edge counts, and the corner size along it. */
export const EDGE_PX = 6;
export const CORNER_MIN_PX = 48;
export const CORNER_FRACTION = 0.12;
/** With the modifier held, the outer quarter of the screen on each side is a half zone. */
export const MODIFIER_FRACTION = 0.25;

/** Zones that wait for the pointer to rest before they show (edges, corners); the top ones do not. */
export function needsDwell(zone) {
    return zone !== 'fill';
}

/**
 * The zone a finished drag tiles into. A grab that ends with the pointer button still down
 * was cancelled (Esc): the window goes back and nothing is tiled. The zone is the one under
 * the pointer when the button goes up: the top ones at once (a fast drag may release before
 * any outline showed), the edges only after their outline showed (`shown`).
 *
 * @param {{live: ?string, shown: ?string, buttonDown: boolean}} s
 * @returns {?string}
 */
export function dropZone({ live, shown, buttonDown }) {
    if (buttonDown || !live)
        return null;
    return needsDwell(live) ? (shown === live ? live : null) : live;
}

/** True when the pointer is within `pad` px of the rect. */
export function nearRect(p, rect, pad = 0) {
    return p.x >= rect.x - pad && p.x < rect.x + rect.width + pad &&
        p.y >= rect.y - pad && p.y < rect.y + rect.height + pad;
}

/**
 * The rect of a zone in a work area. With a margin, every outer edge is inset by the margin
 * and every inner edge by half of it, so neighbouring tiles keep one margin between them.
 * Edges are rounded before widths are taken, so neighbours share their edge exactly.
 *
 * @param {string} zone a key of ZONES
 * @param {{x, y, width, height}} area
 * @param {number} [margin] 0 for none
 * @returns {{x, y, width, height}}
 */
export function zoneRect(zone, area, margin = 0) {
    const f = ZONES[zone] ?? ZONES.fill;
    const inset = (start, end) => [start <= 0 ? margin : margin / 2, end >= 1 ? margin : margin / 2];
    const [l, r] = inset(f.x, f.x + f.w);
    const [t, b] = inset(f.y, f.y + f.h);
    const x0 = Math.round(area.x + f.x * area.width + l);
    const x1 = Math.round(area.x + (f.x + f.w) * area.width - r);
    const y0 = Math.round(area.y + f.y * area.height + t);
    const y1 = Math.round(area.y + (f.y + f.h) * area.height - b);
    return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** A rect of the given size centred in `area`, never larger than it. */
export function centerRect(area, width, height) {
    const w = Math.min(width, area.width);
    const h = Math.min(height, area.height);
    return {
        x: Math.round(area.x + (area.width - w) / 2),
        y: Math.round(area.y + (area.height - h) / 2),
        width: w,
        height: h,
    };
}

// Which side of the work area a zone touches: -1 start, 1 end, 0 both or neither
function anchorOf(start, size) {
    const touchesStart = start <= 0;
    const touchesEnd = start + size >= 1;
    if (touchesStart === touchesEnd)
        return 0;
    return touchesStart ? -1 : 1;
}

function placeAxis(tStart, tSize, size, anchor, aStart, aSize) {
    let start;
    if (size <= tSize)
        start = tStart + (tSize - size) / 2;
    else if (anchor < 0)
        start = tStart;
    else if (anchor > 0)
        start = tStart + tSize - size;
    else
        start = tStart + (tSize - size) / 2;
    // Keep it inside the work area where it fits, else at its start
    if (size >= aSize)
        return aStart;
    return Math.round(Math.min(Math.max(start, aStart), aStart + aSize - size));
}

/**
 * Where a window goes when its size is not the tile's: a window that cannot resize (fixed size)
 * is centred in the tile, as macOS slides it in and leaves the gap; one whose minimum size is
 * larger than the tile keeps the tile's outer edge and grows inward. Always kept inside the
 * work area when it fits.
 *
 * @param {string} zone
 * @param {{x, y, width, height}} target the zone rect
 * @param {{width, height}} size the window's real size
 * @param {{x, y, width, height}} area the work area
 * @returns {{x, y, width, height}}
 */
export function placeIn(zone, target, size, area) {
    const f = ZONES[zone] ?? ZONES.fill;
    return {
        x: placeAxis(target.x, target.width, size.width, anchorOf(f.x, f.w), area.x, area.width),
        y: placeAxis(target.y, target.height, size.height, anchorOf(f.y, f.h), area.y, area.height),
        width: size.width,
        height: size.height,
    };
}

/**
 * The drag zone under the pointer while a window is dragged, or null.
 * - Left/right screen edge: the half; near a corner along it: that quarter.
 * - Top or bottom edge near a corner: that quarter.
 * - Onto the menu bar (top edge elsewhere): Fill; at the top-centre (`picker` on): the picker,
 *   which stays while the pointer is within PICKER_KEEP_PX of its rect (`pickerRect`).
 * - With the modifier held (macOS Option): the outer quarters of the screen are the half
 *   zones, no edge needed; quarters and Fill still need the edge.
 *
 * @param {{x: number, y: number}} p pointer
 * @param {{x, y, width, height}} monitor the monitor's full rect
 * @param {object} opts
 * @param {number} opts.topEdge the y at or above which the pointer is "on the menu bar"
 *   (the menu bar's bottom, or the monitor's top plus EDGE_PX without one)
 * @param {boolean} opts.edges "Drag windows to screen edges to tile"
 * @param {boolean} opts.menuBar "Drag windows to menu bar to fill screen"
 * @param {boolean} opts.modifier the modifier is held and its setting is on
 * @returns {?string} a key of ZONES
 */
export function hitZone(p, monitor, { topEdge, edges = true, menuBar = true, modifier = false }) {
    const right = monitor.x + monitor.width - 1;
    const bottomY = monitor.y + monitor.height - 1;
    const corner = Math.max(CORNER_MIN_PX, Math.round(CORNER_FRACTION * Math.min(monitor.width, monitor.height)));
    const atLeft = p.x <= monitor.x + EDGE_PX;
    const atRight = p.x >= right - EDGE_PX;
    const atTop = p.y <= topEdge;
    const atBottom = p.y >= bottomY - EDGE_PX;
    const nearTop = p.y <= monitor.y + corner;
    const nearBottom = p.y >= bottomY - corner;
    const nearLeft = p.x <= monitor.x + corner;
    const nearRight = p.x >= right - corner;

    if (edges) {
        if (atLeft || atRight) {
            const side = atLeft ? 'left' : 'right';
            if (nearTop)
                return `top-${side}`;
            if (nearBottom)
                return `bottom-${side}`;
            return side;
        }
        if ((atTop || atBottom) && (nearLeft || nearRight))
            return `${atTop ? 'top' : 'bottom'}-${nearLeft ? 'left' : 'right'}`;
    }
    if (menuBar && atTop)
        return 'fill';
    if (modifier) {
        if (p.x < monitor.x + monitor.width * MODIFIER_FRACTION)
            return 'left';
        if (p.x > monitor.x + monitor.width * (1 - MODIFIER_FRACTION))
            return 'right';
    }
    return null;
}

/**
 * Pair windows with the zones of an arrangement: the first id is the active window.
 *
 * @param {string} name a key of ARRANGEMENTS
 * @param {number[]} ids active window first, then most recently used
 * @returns {{id: number, zone: string}[]} as many as both lists allow
 */
export function planArrangement(name, ids) {
    const zones = ARRANGEMENTS[name] ?? [];
    const out = [];
    for (let i = 0; i < zones.length && i < ids.length; i++)
        out.push({ id: ids[i], zone: zones[i] });
    return out;
}

/**
 * Where a window dragged out of its tile goes: its pre-tile size, positioned so the pointer
 * keeps its relative place across the title bar and stays inside the window.
 *
 * @param {{x, y, width, height}} frame the tiled frame
 * @param {{width, height}} restore the size to go back to
 * @param {{x: number, y: number}} p pointer
 * @returns {{x, y, width, height}}
 */
export function untileRect(frame, restore, p) {
    const rel = frame.width > 0 ? (p.x - frame.x) / frame.width : 0.5;
    const x = Math.round(p.x - Math.min(Math.max(rel, 0), 1) * restore.width);
    const y = Math.round(Math.min(frame.y, p.y));
    return { x, y, width: restore.width, height: restore.height };
}

/** True when the two rects differ by more than `slack` px on any edge. */
export function rectChanged(a, b, slack = 1) {
    if (!a || !b)
        return true;
    return Math.abs(a.x - b.x) > slack || Math.abs(a.y - b.y) > slack ||
        Math.abs(a.width - b.width) > slack || Math.abs(a.height - b.height) > slack;
}

/**
 * Which windows hold a tile, and the frame each had before its first tile ("Return to Previous
 * Size"). Keyed by window id (Meta.Window stable sequence). Re-tiling keeps the first restore.
 */
export class TileBook {
    constructor() {
        this._tiles = new Map(); // id -> {zone, monitor, restore}
    }

    /**
     * @param {number} id
     * @param {{zone: string, monitor: number, restore: {x, y, width, height, maximized?: boolean}}} tile
     * @returns {object} the stored tile (its restore is the first one ever given)
     */
    tile(id, { zone, monitor, restore }) {
        const old = this._tiles.get(id);
        const entry = Object.freeze({ zone, monitor, restore: old?.restore ?? Object.freeze({ ...restore }) });
        this._tiles.set(id, entry);
        return entry;
    }

    get(id) {
        return this._tiles.get(id) ?? null;
    }

    has(id) {
        return this._tiles.has(id);
    }

    /** Forget a tile and give back where the window was before it. */
    untile(id) {
        const entry = this._tiles.get(id);
        this._tiles.delete(id);
        return entry?.restore ?? null;
    }

    ids() {
        return [...this._tiles.keys()];
    }

    /** Ids of the windows tiled on one monitor. */
    onMonitor(monitor) {
        const out = [];
        for (const [id, t] of this._tiles) {
            if (t.monitor === monitor)
                out.push(id);
        }
        return out;
    }

    clear() {
        this._tiles.clear();
    }

    /**
     * Tiled neighbours of a window: tiles on the same monitor that share an edge with its
     * tile (the hook for the linked divider resize of phase 2).
     *
     * @returns {{id: number, side: 'left'|'right'|'top'|'bottom'}[]} side of `id`'s tile they touch
     */
    neighbours(id) {
        const me = this._tiles.get(id);
        if (!me || me.zone === 'fill')
            return [];
        const a = ZONES[me.zone];
        const out = [];
        const eps = 1e-6;
        const overlap = (s1, l1, s2, l2) => Math.min(s1 + l1, s2 + l2) - Math.max(s1, s2) > eps;
        for (const [other, t] of this._tiles) {
            if (other === id || t.monitor !== me.monitor || !(t.zone in ZONES) || t.zone === 'fill')
                continue;
            const b = ZONES[t.zone];
            if (overlap(a.y, a.h, b.y, b.h) && Math.abs(a.x + a.w - b.x) < eps)
                out.push({ id: other, side: 'right' });
            else if (overlap(a.y, a.h, b.y, b.h) && Math.abs(b.x + b.w - a.x) < eps)
                out.push({ id: other, side: 'left' });
            else if (overlap(a.x, a.w, b.x, b.w) && Math.abs(a.y + a.h - b.y) < eps)
                out.push({ id: other, side: 'bottom' });
            else if (overlap(a.x, a.w, b.x, b.w) && Math.abs(b.y + b.h - a.y) < eps)
                out.push({ id: other, side: 'top' });
        }
        return out;
    }
}

/**
 * The tiling shortcuts: schema key -> action. Defaults (schema) map the macOS Fn-Ctrl
 * shortcuts to Ctrl+Super, since Fn never reaches the OS.
 */
export const SHORTCUTS = Object.freeze([
    { key: 'windows-tile-left-shortcut', action: 'left' },
    { key: 'windows-tile-right-shortcut', action: 'right' },
    { key: 'windows-tile-top-shortcut', action: 'top' },
    { key: 'windows-tile-bottom-shortcut', action: 'bottom' },
    { key: 'windows-fill-shortcut', action: 'fill' },
    { key: 'windows-center-shortcut', action: 'center' },
    { key: 'windows-restore-shortcut', action: 'restore' },
    { key: 'windows-arrange-left-right-shortcut', action: 'arrange-left-right' },
    { key: 'windows-arrange-right-left-shortcut', action: 'arrange-right-left' },
    { key: 'windows-arrange-top-bottom-shortcut', action: 'arrange-top-bottom' },
    { key: 'windows-arrange-bottom-top-shortcut', action: 'arrange-bottom-top' },
    { key: 'windows-arrange-left-quarters-shortcut', action: 'arrange-left-quarters' },
    { key: 'windows-arrange-right-quarters-shortcut', action: 'arrange-right-quarters' },
    { key: 'windows-arrange-top-quarters-shortcut', action: 'arrange-top-quarters' },
    { key: 'windows-arrange-bottom-quarters-shortcut', action: 'arrange-bottom-quarters' },
]);

/**
 * Split shortcut keys into those Guava can bind and those it leaves unbound because one of
 * their accelerators is already taken (a stock GNOME binding, or another Guava shortcut that
 * is active). A key with no accelerator is neither.
 *
 * @param {{key: string, accels: string[]}[]} entries
 * @param {Map<string, string>} taken normalised accelerator -> who has it
 * @returns {{bind: string[], skipped: {key: string, accel: string, with: string}[]}}
 */
export function pickBindable(entries, taken) {
    const bind = [];
    const skipped = [];
    const mine = new Map();
    for (const { key, accels } of entries) {
        const valid = (accels ?? []).map(a => [a, normalizeAccel(a)]).filter(([, n]) => n);
        if (!valid.length)
            continue;
        const hit = valid.find(([, n]) => taken.has(n) || mine.has(n));
        if (hit) {
            skipped.push({ key, accel: hit[0], with: taken.get(hit[1]) ?? mine.get(hit[1]) });
            continue;
        }
        valid.forEach(([, n]) => mine.set(n, key));
        bind.push(key);
    }
    return { bind, skipped };
}
