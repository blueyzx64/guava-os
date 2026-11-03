// SPDX-License-Identifier: GPL-3.0-or-later
// The pure half of core/desktopLayers.js (tests/desktopLayersModel.test.js). No gi:// imports.

/**
 * The order the desktop layers stack in, bottom first: lower rank first, the one added first
 * when ranks are equal.
 *
 * @param {Array<{id: string, rank: number}>} layers in the order they were added
 */
export function stackOrder(layers) {
    return layers
        .map((layer, seq) => ({ layer, seq }))
        .sort((a, b) => a.layer.rank - b.layer.rank || a.seq - b.seq)
        .map(x => x.layer);
}

/**
 * Screen rectangles that layers keep clear for each other (the widgets' cards, which the
 * desktop icons flow around). Each owner replaces its own list.
 */
export class ReserveStore {
    constructor() {
        this._byOwner = new Map();
    }

    /** @returns {boolean} true when the owner's rectangles changed */
    set(owner, rects) {
        const next = rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
        const prev = this._byOwner.get(owner) ?? [];
        if (JSON.stringify(prev) === JSON.stringify(next))
            return false;
        if (next.length)
            this._byOwner.set(owner, next);
        else
            this._byOwner.delete(owner);
        return true;
    }

    /** Every owner's rectangles except `except`'s own. */
    all(except = null) {
        const out = [];
        for (const [owner, rects] of this._byOwner) {
            if (owner !== except)
                out.push(...rects);
        }
        return out;
    }
}
