// SPDX-License-Identifier: GPL-3.0-or-later
// Show Desktop: pure decisions and geometry. No gi:// imports (tests run it under gjs -m).
//
// Each window slides toward the screen edge nearest its centre, measured as a fraction of the
// work area's width or height (so on a wide screen a window in a corner still goes sideways
// unless it is really close to the top or bottom). A thin sliver (PEEK px of the frame) stays
// on screen so the user can see where the windows went and click one to bring them all back.
// Dialogs follow their parent's edge so a window and its dialog leave together.

/** Logical px of the window frame left on screen. */
export const PEEK = 16;

/** Window types that move aside. Desktop icons (DING), docks, menus and tooltips never do. */
export const MOVABLE_TYPES = Object.freeze(['normal', 'dialog', 'modal-dialog', 'utility']);

/** Animation length per speed setting (ms). macOS is close to 'normal'. */
export const SPEEDS = Object.freeze({ fast: 200, normal: 300, slow: 500 });

/**
 * @param {string} speed the `show-desktop-speed` setting
 * @returns {number} ms ('normal' for junk)
 */
export function durationFor(speed) {
    return Object.hasOwn(SPEEDS, speed) ? SPEEDS[speed] : SPEEDS.normal;
}

/**
 * Should this window slide aside?
 *
 * @param {{type: string, minimized: boolean, skipTaskbar: boolean, onWorkspace: boolean,
 *   visible: boolean, opacity: number}} w plain facts about the window and its actor.
 *   A window Stage Manager hid (opacity 0 or unmapped) is left where it is.
 * @returns {boolean}
 */
export function isMovable(w) {
    return !!w && MOVABLE_TYPES.includes(w.type) && !w.minimized && !w.skipTaskbar &&
        !!w.onWorkspace && !!w.visible && (w.opacity ?? 255) > 0;
}

/**
 * The edge nearest the centre of `frame`, as a fraction of the area's size.
 * Ties go to the sides (left before right), then top before bottom.
 *
 * @param {{x: number, y: number, width: number, height: number}} frame window frame rect
 * @param {{x: number, y: number, width: number, height: number}} area its monitor's work area
 * @returns {'left'|'right'|'top'|'bottom'}
 */
export function chooseEdge(frame, area) {
    const w = Math.max(1, area.width), h = Math.max(1, area.height);
    const cx = frame.x + frame.width / 2 - area.x;
    const cy = frame.y + frame.height / 2 - area.y;
    const dist = [
        ['left', cx / w],
        ['right', (w - cx) / w],
        ['top', cy / h],
        ['bottom', (h - cy) / h],
    ];
    let best = dist[0];
    for (const d of dist) {
        if (d[1] < best[1])
            best = d;
    }
    return best[0];
}

/**
 * Translation that moves `frame` toward `edge` until only `peek` px of it stay inside `area`.
 * Never moves a window back inward (a window already past the sliver line stays put).
 *
 * @param {{x: number, y: number, width: number, height: number}} frame
 * @param {{x: number, y: number, width: number, height: number}} area
 * @param {'left'|'right'|'top'|'bottom'} edge
 * @param {number} [peek]
 * @returns {{x: number, y: number}} translation in logical px
 */
export function edgeOffset(frame, area, edge, peek = PEEK) {
    switch (edge) {
    case 'left':
        return { x: Math.min(0, area.x + peek - (frame.x + frame.width)), y: 0 };
    case 'right':
        return { x: Math.max(0, area.x + area.width - peek - frame.x), y: 0 };
    case 'top':
        return { x: 0, y: Math.min(0, area.y + peek - (frame.y + frame.height)) };
    case 'bottom':
        return { x: 0, y: Math.max(0, area.y + area.height - peek - frame.y) };
    default:
        return { x: 0, y: 0 };
    }
}

/**
 * Where every window goes.
 *
 * @param {{id: *, frame: object, area: object, parentId?: *}[]} windows movable windows,
 *   each with its own monitor's work area
 * @param {number} [peek]
 * @returns {Map<*, {edge: string, x: number, y: number}>} id -> plan
 */
export function planReveal(windows, peek = PEEK) {
    const plans = new Map();
    const byId = new Map(windows.map(w => [w.id, w]));
    const edgeOf = (w, seen = new Set()) => {
        const parent = w.parentId !== undefined && w.parentId !== null ? byId.get(w.parentId) : null;
        if (parent && !seen.has(parent.id)) {
            seen.add(w.id);
            return edgeOf(parent, seen);
        }
        return chooseEdge(w.frame, w.area);
    };
    for (const w of windows) {
        const edge = edgeOf(w);
        plans.set(w.id, { edge, ...edgeOffset(w.frame, w.area, edge, peek) });
    }
    return plans;
}

/**
 * Does focusing this window end Show Desktop? Focus moving to nothing (Guava clears it on
 * reveal) or to the desktop icons window (DING) does not; any real window does.
 *
 * @param {{type: string, skipTaskbar: boolean}|null} w
 * @returns {boolean}
 */
export function focusEnds(w) {
    return !!w && MOVABLE_TYPES.includes(w.type) && !w.skipTaskbar;
}

export const WALLPAPER_MODES = Object.freeze(['always', 'stage-manager', 'never']);

/**
 * Does a click on empty wallpaper show the desktop (macOS Sonoma "Click wallpaper to reveal
 * desktop": Always, or Only in Stage Manager)? Stage Manager answers its own clicks while it runs
 * with its wallpaper option on (it sends the stage to the strip); Show Desktop takes the rest.
 *
 * @param {{mode: string, stageActive: boolean, stageHandles: boolean, blocked: boolean}} s
 *   blocked: the overview or a modal is open
 * @returns {boolean} true when Show Desktop should toggle
 */
export function wallpaperClickToggles({ mode, stageActive, stageHandles, blocked }) {
    if (blocked || mode === 'never' || !WALLPAPER_MODES.includes(mode))
        return false;
    if (stageActive)
        return !stageHandles;
    return mode === 'always';
}
