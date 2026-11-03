// SPDX-License-Identifier: GPL-3.0-or-later
// Hot corners (macOS Desktop & Dock ▸ Hot Corners): where the four corners are on each
// monitor, which barriers make them, and whether a push into one runs its action.
//
// Each corner is two short pressure barriers along the two screen edges that meet there,
// like GNOME's own HotCorner (js/ui/layout.js), and fires when the pointer pushes into them
// hard enough. A corner exists only where the screen really ends: an edge another monitor
// continues has no corner, so barriers never block moving between monitors.
//
// Pure JS (no gi imports); tests/hotCornersModel.test.js.

export const CORNERS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

/** Schema keys: the action and the required modifier of each corner. */
export const actionKey = corner => `hot-corner-${corner}`;
export const modifierKey = corner => `hot-corner-${corner}-modifier`;

/** Modifier choices (macOS ⌘ ⌥ ⌃ ⇧; ⌘ is Super here). */
export const MODIFIERS = Object.freeze(['none', 'shift', 'ctrl', 'alt', 'super']);

/**
 * px each barrier runs along its edge, and the distance from the corner point where a push
 * counts. Small, so pushing against the top edge over the logo menu or the clock, or
 * against the dock's edge, is not a corner.
 */
export const CORNER_SIZE = 8;
/**
 * px of push needed within PRESSURE_TIMEOUT ms. GNOME's corner uses 100 px in 1000 ms; a
 * macOS corner reacts faster. A pointer that only reaches the corner (a fling that stops
 * there) builds no pressure, so it does not fire.
 */
export const PRESSURE_THRESHOLD = 60;
export const PRESSURE_TIMEOUT = 600;

const inside = (x, y, m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height;

/**
 * The corner point and its outward directions.
 *
 * @param {{x, y, width, height}} m monitor rect
 * @param {string} corner
 * @returns {{x: number, y: number, sx: -1|1, sy: -1|1}} sx/sy point out of the screen
 */
export function cornerPoint(m, corner) {
    const right = corner.endsWith('right');
    const bottom = corner.startsWith('bottom');
    return {
        x: right ? m.x + m.width : m.x,
        y: bottom ? m.y + m.height : m.y,
        sx: right ? 1 : -1,
        sy: bottom ? 1 : -1,
    };
}

/**
 * Whether the corner is a real screen corner: no other monitor continues either of the
 * two edges there (GNOME's rule for its top-left corner, for every corner).
 *
 * @param {{x, y, width, height}[]} monitors
 * @param {number} index
 * @param {string} corner
 */
export function hasCorner(monitors, index, corner) {
    const m = monitors[index];
    const p = cornerPoint(m, corner);
    // The pixel just past each edge, one pixel inside the corner along the other edge
    const insideX = p.sx > 0 ? p.x - 1 : p.x;
    const insideY = p.sy > 0 ? p.y - 1 : p.y;
    const beside = { x: p.sx > 0 ? p.x : p.x - 1, y: insideY };
    const beyond = { x: insideX, y: p.sy > 0 ? p.y : p.y - 1 };
    return !monitors.some((o, j) => j !== index &&
        (inside(beside.x, beside.y, o) || inside(beyond.x, beyond.y, o)));
}

/**
 * The two barriers of a corner. `allow` is the direction the pointer may cross (back into
 * the screen); Meta.Barrier blocks the other one, which is what builds the pressure.
 *
 * @returns {{x1, y1, x2, y2, allow: 'positive-x'|'negative-x'|'positive-y'|'negative-y'}[]}
 */
export function cornerBarriers(m, corner, size = CORNER_SIZE) {
    const p = cornerPoint(m, corner);
    const alongY = p.sy > 0 ? [p.y - size, p.y] : [p.y, p.y + size];
    const alongX = p.sx > 0 ? [p.x - size, p.x] : [p.x, p.x + size];
    return [
        // On the side edge (vertical barrier)
        { x1: p.x, x2: p.x, y1: alongY[0], y2: alongY[1], allow: p.sx > 0 ? 'negative-x' : 'positive-x' },
        // On the top or bottom edge (horizontal barrier)
        { x1: alongX[0], x2: alongX[1], y1: p.y, y2: p.y, allow: p.sy > 0 ? 'negative-y' : 'positive-y' },
    ];
}

/**
 * Every corner to build: [{monitor, corner}] for corners with an action and a real corner.
 *
 * @param {{x, y, width, height}[]} monitors
 * @param {Object<string, string>} actions corner -> action id ('none' = off)
 */
export function wantedCorners(monitors, actions) {
    const out = [];
    monitors.forEach((_m, monitor) => {
        for (const corner of CORNERS) {
            if ((actions[corner] ?? 'none') !== 'none' && hasCorner(monitors, monitor, corner))
                out.push({ monitor, corner });
        }
    });
    return out;
}

/**
 * Whether the pointer is in the corner (within CORNER_SIZE of the corner point on both
 * axes). Pressure on the barrier's far end over a menu bar item does not count.
 */
export function atCorner(x, y, m, corner, size = CORNER_SIZE) {
    const p = cornerPoint(m, corner);
    // The last pixel row/column is width-1 / height-1
    const px = p.sx > 0 ? p.x - 1 : p.x;
    const py = p.sy > 0 ? p.y - 1 : p.y;
    return Math.abs(x - px) < size && Math.abs(y - py) < size;
}

/**
 * Whether a push into a corner runs its action.
 *
 * @param {{action: string, modifier: string, held: Set<string>, fullscreen: boolean,
 *   overview: boolean, atCorner: boolean}} s held: the modifiers down now
 */
export function shouldFire({ action, modifier, held, fullscreen, overview, atCorner: there }) {
    if (!action || action === 'none' || !there)
        return false;
    // Over a full-screen window only to leave Mission Control (macOS and GNOME agree)
    if (fullscreen && !overview)
        return false;
    if (modifier && modifier !== 'none')
        return held.has(modifier);
    return true;
}
