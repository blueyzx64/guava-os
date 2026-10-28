// SPDX-License-Identifier: GPL-3.0-or-later
// Pure arbitration for Guava modals: only one is open at a time, and other Guava
// overlays that are not ModalSurfaces (the Downloads fan) get closed first.
// No gi imports, so it runs under plain `gjs -m` (tests/modalModel.test.js).

const LOG = '[Guava]';

export class ModalArbiter {
    constructor() {
        this._open = null;          // {id, close}
        this._foreign = new Map();  // id -> close fn
    }

    /** id of the open modal, or null. */
    get current() {
        return this._open?.id ?? null;
    }

    /**
     * Another Guava overlay that owns its own grab. close() runs whenever a modal is requested.
     *
     * @param {string} id unique name
     * @param {Function} close closes the overlay; must be safe when it is already closed
     * @returns {Function} unregister
     */
    registerForeign(id, close) {
        this._foreign.set(id, close);
        return () => {
            if (this._foreign.get(id) === close)
                this._foreign.delete(id);
        };
    }

    /**
     * A modal wants to open. Closes every foreign overlay and any other open modal.
     *
     * @param {string} id the modal asking
     * @returns {boolean} false when this id is already the open one (toggle: caller closes it)
     */
    request(id) {
        if (this._open?.id === id)
            return false;
        this.closeForeign();
        this._closeOpen();
        return true;
    }

    /** The modal finished opening. */
    opened(id, close) {
        this._open = { id, close };
    }

    /** The modal finished closing (idempotent; ignores a stale id). */
    closed(id) {
        if (this._open?.id === id)
            this._open = null;
    }

    closeForeign() {
        for (const [id, close] of [...this._foreign]) {
            try {
                close();
            } catch (e) {
                console.warn(`${LOG} closing ${id} failed: ${e.message}`);
            }
        }
    }

    /** Close the open modal and all foreign overlays. */
    closeAll() {
        this.closeForeign();
        this._closeOpen();
    }

    _closeOpen() {
        const cur = this._open;
        if (!cur)
            return;
        this._open = null;
        try {
            cur.close();
        } catch (e) {
            console.warn(`${LOG} closing modal ${cur.id} failed: ${e.message}`);
        }
    }
}

/**
 * Where a modal anchored to a rect (a text caret) goes: its top-left corner under the rect,
 * or above it when it would leave the area at the bottom; always inside the area.
 *
 * @param {{x, y, width, height}} rect anchor, stage coordinates
 * @param {{width, height}} size the modal
 * @param {{x, y, width, height}} area the monitor (or work area) holding the anchor
 * @param {{gap?: number, margin?: number}} [opts]
 * @returns {{x: number, y: number, above: boolean}} relative to the area
 */
export function placeNear(rect, size, area, { gap = 8, margin = 12 } = {}) {
    const fitsBelow = rect.y + rect.height + gap + size.height <= area.y + area.height - margin;
    const fitsAbove = rect.y - gap - size.height >= area.y + margin;
    const above = !fitsBelow && fitsAbove;
    const y = above ? rect.y - gap - size.height : rect.y + rect.height + gap;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const x = clamp(rect.x - 24, area.x + margin, area.x + area.width - size.width - margin);
    return {
        x: Math.round(x - area.x),
        y: Math.round(clamp(y, area.y + margin, area.y + area.height - size.height - margin) - area.y),
        above,
    };
}

/**
 * The panel menu whose button is under a point, for hover switching (what the stock
 * PopupMenuManager does when its source actor is entered while another menu is open).
 *
 * @param {Array<{menu: object, rect: {x, y, width, height}}>} entries the buttons, in stage coordinates
 * @param {number} x
 * @param {number} y
 * @returns {object|null} the menu, or null when the point is on no button
 */
export function menuAtPoint(entries, x, y) {
    const hit = entries.find(({ rect }) =>
        x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
    return hit?.menu ?? null;
}
