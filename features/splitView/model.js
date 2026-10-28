// SPDX-License-Identifier: GPL-3.0-or-later
// Full screen Split View: the pure decisions (no gi imports).
//
//   splitRects(area, side)          the two halves: the tiled window's and its partner's
//   isCandidate(win)                which windows can be picked as the partner
//   thumbnailRects(sizes, area)     the picker's thumbnails on the free half
//   survivorAfter(pair, gone)       who stays full screen when a pair ends
//   preSplitRect(frame, area)       the size a window that leaves a pair goes back to
//
// macOS (El Capitan to Sequoia, Full Screen and Split View): "Tile Window to Left/Right of Screen" on a full-screen window; the window takes that
// half and the other half shows the Space's other windows to pick the partner from. Guava offers
// it as two shortcuts, since GNOME apps' own buttons cannot show a hover menu.

/**
 * The halves of a work area (whole pixels, no gap: the windows meet in the middle).
 *
 * @param {{x, y, width, height}} area
 * @param {'left'|'right'} side where the full-screen window goes
 * @returns {{tiled: {x, y, width, height}, other: {x, y, width, height}}}
 */
export function splitRects(area, side) {
    const leftWidth = Math.floor(area.width / 2);
    const left = { x: area.x, y: area.y, width: leftWidth, height: area.height };
    const right = { x: area.x + leftWidth, y: area.y, width: area.width - leftWidth, height: area.height };
    return side === 'right' ? { tiled: right, other: left } : { tiled: left, other: right };
}

/**
 * A window the picker offers: a normal app window, shown in the taskbar, not the one being
 * tiled, not full screen in a Space of its own, not already in a pair.
 *
 * @param {{type: string, skipTaskbar: boolean, fullscreen: boolean, inSplit: boolean,
 *          isTiled: boolean}} w isTiled: it is the window being tiled
 */
export function isCandidate(w) {
    return w.type === 'normal' && !w.skipTaskbar && !w.fullscreen && !w.inSplit && !w.isTiled;
}

/**
 * Thumbnails for the picker: a grid of equal cells on the free half, each window scaled to fit
 * its cell (never enlarged), centred, with room for its title underneath.
 *
 * @param {{width: number, height: number}[]} sizes window frame sizes, in picker order
 * @param {{x, y, width, height}} area the free half
 * @param {{padding?: number, gap?: number, label?: number}} [opts]
 * @returns {{x, y, width, height, scale}[]} the thumbnail rects (label below each)
 */
export function thumbnailRects(sizes, area, { padding = 32, gap = 24, label = 28 } = {}) {
    const n = sizes.length;
    if (!n)
        return [];
    const innerW = Math.max(1, area.width - 2 * padding);
    const innerH = Math.max(1, area.height - 2 * padding);
    // The column count that gives the largest thumbnails for this aspect
    let best = { cols: 1, cell: 0 };
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const cw = (innerW - (cols - 1) * gap) / cols;
        const ch = (innerH - (rows - 1) * gap) / rows - label;
        const cell = Math.min(cw, ch * 1.6);
        if (cw > 0 && ch > 0 && cell > best.cell)
            best = { cols, cell };
    }
    const cols = best.cols;
    const rows = Math.ceil(n / cols);
    const cw = (innerW - (cols - 1) * gap) / cols;
    const ch = (innerH - (rows - 1) * gap) / rows - label;
    const top = area.y + padding + Math.max(0, (innerH - rows * (ch + label) - (rows - 1) * gap) / 2);
    return sizes.map((s, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const scale = Math.min(1, cw / Math.max(1, s.width), ch / Math.max(1, s.height));
        const width = Math.round(s.width * scale), height = Math.round(s.height * scale);
        const cx = area.x + padding + col * (cw + gap) + cw / 2;
        const cy = top + row * (ch + label + gap) + ch / 2;
        return { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height, scale };
    });
}

/**
 * When one window of a pair goes (closed, minimized, moved, made full screen), the other one
 * stays full screen in the Space (macOS); null when neither is left.
 *
 * @param {{a: *, b: *}} pair
 * @param {*} gone the window that left
 */
export function survivorAfter(pair, gone) {
    if (gone === pair.a)
        return pair.b ?? null;
    if (gone === pair.b)
        return pair.a ?? null;
    return null;
}

/**
 * The size a window goes back to when it leaves a pair: its frame before the split, unless
 * that frame still covers the whole area (Mutter had not given the window its windowed size
 * yet), which is no size to go back to.
 *
 * @param {?{x, y, width, height}} frame
 * @param {{x, y, width, height}} area
 * @returns {?{x, y, width, height}}
 */
export function preSplitRect(frame, area) {
    if (!frame || (frame.width >= area.width && frame.height >= area.height))
        return null;
    const { x, y, width, height } = frame;
    return { x, y, width, height };
}
