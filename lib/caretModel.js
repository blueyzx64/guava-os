// SPDX-License-Identifier: GPL-3.0-or-later
// The text caret of the focused app, as the IBus panel service reports it. Pure; lib/caret.js
// feeds it. A rect is trusted only for the focus it was reported in: a focus change forgets it.

export class CaretTracker {
    constructor() {
        this._rect = null;
    }

    /** IBus set-cursor-location; an empty rect (0,0,0,0) means the client has none. */
    report(rect) {
        const valid = !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
            !(rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0);
        this._rect = valid
            ? { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) }
            : null;
    }

    focusChanged() {
        this._rect = null;
    }

    /** @returns {?{x: number, y: number, width: number, height: number}} */
    get rect() {
        return this._rect;
    }
}
