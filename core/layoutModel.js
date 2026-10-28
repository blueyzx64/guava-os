// SPDX-License-Identifier: GPL-3.0-or-later
// LayoutModel: who owns which screen edge, and what is left for windows.
//
// A feature that sits on an edge (the menu bar on top, the dock, the Stage Manager strip, the
// notch) registers a claim instead of guessing the others' sizes. The model turns the claims
// into one rect per claim and the work area every window placement uses (tiling, maximize,
// Stage Manager, Show Desktop).
//
// Claim spec:
//   id        unique string ('menu-bar', 'dock', 'stage-strip', 'notch')
//   edge      'top' | 'bottom' | 'left' | 'right'
//   size      thickness in px, away from the edge
//   monitor   monitor index, or 'primary' (default) or 'all'
//   reserve   'strut'  Mutter already keeps windows out (chrome with affectsStruts, the panel)
//             'soft'   only Guava's placement honours it (the Stage Manager strip)
//             'none'   an overlay: windows may sit under it (default)
//   stack     true (default): claims on one edge stack outward to inward in `order`;
//             false: drawn at the edge without pushing (the notch inside the menu bar)
//   order     smaller is closer to the edge (default 0; ties keep registration order)
//   length    extent along the edge in px (default: the whole edge)
//   align     'start' | 'center' | 'end' along the edge, when `length` is set (default center)
//
// Pure JS (no gi imports). core/layout.js (LayoutService) is the Shell side.

export const EDGES = Object.freeze(['top', 'bottom', 'left', 'right']);
const RESERVES = ['strut', 'soft', 'none'];
const ALIGNS = ['start', 'center', 'end'];

function normalize(spec, seq) {
    const { id, edge } = spec;
    if (!id)
        throw new Error('LayoutModel: a claim needs an id');
    if (!EDGES.includes(edge))
        throw new Error(`LayoutModel: unknown edge '${edge}'`);
    const reserve = spec.reserve ?? 'none';
    if (!RESERVES.includes(reserve))
        throw new Error(`LayoutModel: unknown reserve '${reserve}'`);
    const align = spec.align ?? 'center';
    if (!ALIGNS.includes(align))
        throw new Error(`LayoutModel: unknown align '${align}'`);
    return Object.freeze({
        id, edge, reserve, align, seq,
        size: Math.max(0, Math.round(spec.size ?? 0)),
        monitor: spec.monitor ?? 'primary',
        stack: spec.stack ?? true,
        order: spec.order ?? 0,
        length: spec.length ?? null,
    });
}

/** True when the claim applies to monitor `index` (primary is the primary monitor's index). */
function onMonitor(claim, index, primary) {
    if (claim.monitor === 'all')
        return true;
    if (claim.monitor === 'primary')
        return index === primary;
    return claim.monitor === index;
}

/** The rect of a band `size` thick at `offset` from `edge` of monitor rect `m`. */
function band(m, edge, offset, size, length, align) {
    const horizontal = edge === 'top' || edge === 'bottom';
    const full = horizontal ? m.width : m.height;
    const len = length === null ? full : Math.min(length, full);
    const lead = align === 'start' ? 0 : align === 'end' ? full - len : Math.round((full - len) / 2);
    switch (edge) {
    case 'top':
        return { x: m.x + lead, y: m.y + offset, width: len, height: size };
    case 'bottom':
        return { x: m.x + lead, y: m.y + m.height - offset - size, width: len, height: size };
    case 'left':
        return { x: m.x + offset, y: m.y + lead, width: size, height: len };
    default:
        return { x: m.x + m.width - offset - size, y: m.y + lead, width: size, height: len };
    }
}

export class LayoutModel {
    constructor() {
        this._claims = new Map(); // id -> normalized claim
        this._seq = 0;
    }

    /**
     * Add or replace a claim.
     *
     * @param {object} spec see the file header
     * @returns {object} the stored (frozen) claim
     */
    claim(spec) {
        const old = this._claims.get(spec.id);
        const claim = normalize(spec, old?.seq ?? this._seq++);
        this._claims.set(claim.id, claim);
        return claim;
    }

    /** Change some fields of a claim. @returns {?object} the new claim, null if unknown */
    update(id, fields) {
        const old = this._claims.get(id);
        if (!old)
            return null;
        return this.claim({ ...old, ...fields, id });
    }

    /** @returns {boolean} true if it existed */
    release(id) {
        return this._claims.delete(id);
    }

    has(id) {
        return this._claims.has(id);
    }

    /** @returns {?object} the stored (frozen) claim */
    get(id) {
        return this._claims.get(id) ?? null;
    }

    /** Claims that apply to one monitor, in stacking order per edge. */
    claimsOn(index, primary = 0) {
        return [...this._claims.values()]
            .filter(c => onMonitor(c, index, primary))
            .sort((a, b) => a.order - b.order || a.seq - b.seq);
    }

    /**
     * Rects for one monitor.
     *
     * @param {number} index monitor index
     * @param {{x,y,width,height}} monitor its rect
     * @param {object} [opts]
     * @param {{x,y,width,height}} [opts.base] the area Mutter leaves for windows (it already
     *   accounts for 'strut' claims and for other clients' struts); default: the monitor
     * @param {number} [opts.primary] primary monitor index (for 'primary' claims), default 0
     * @param {boolean} [opts.strutsApplied] true (default) when `base` already excludes the
     *   'strut' claims; false subtracts them too (no Mutter area known)
     * @returns {{workArea: {x,y,width,height}, rects: Map<string, {x,y,width,height}>}}
     */
    compute(index, monitor, { base = monitor, primary = 0, strutsApplied = true } = {}) {
        const offsets = { top: 0, bottom: 0, left: 0, right: 0 };
        // How far from each edge Guava keeps windows out beyond what `base` already does: the
        // outer edge of the innermost claim that reserves on top of the base.
        const reach = { top: 0, bottom: 0, left: 0, right: 0 };
        const rects = new Map();
        for (const c of this.claimsOn(index, primary)) {
            const at = c.stack ? offsets[c.edge] : 0;
            rects.set(c.id, band(monitor, c.edge, at, c.size, c.length, c.align));
            if (!c.stack)
                continue;
            offsets[c.edge] += c.size;
            if (c.reserve === 'soft' || (c.reserve === 'strut' && !strutsApplied))
                reach[c.edge] = offsets[c.edge];
        }
        const left = Math.max(base.x, monitor.x + reach.left);
        const top = Math.max(base.y, monitor.y + reach.top);
        const right = Math.min(base.x + base.width, monitor.x + monitor.width - reach.right);
        const bottom = Math.min(base.y + base.height, monitor.y + monitor.height - reach.bottom);
        const workArea = {
            x: left, y: top,
            width: Math.max(0, right - left), height: Math.max(0, bottom - top),
        };
        return { workArea, rects };
    }
}
