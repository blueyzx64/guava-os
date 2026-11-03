// SPDX-License-Identifier: GPL-3.0-or-later
// Pure decisions for shell-behaviour (no gi:// imports; unit-tested under plain gjs).

const EPSILON = 0.001;

/**
 * The snap points the overview swipe may use. The stock gesture offers HIDDEN, WINDOW_PICKER
 * and APP_GRID, so a swipe up goes on from the window picker into the app grid. While the
 * overview is at or below `limit` (and not on its way above it), the points above `limit` are
 * dropped: the swipe tracker clamps its progress to the outer points, so it can't pass `limit`.
 * Once the app grid is shown (the apps button, Super+A), the stock points stay, so a swipe down
 * from it still works.
 *
 * @param {number[]} points ascending snap points from the Shell
 * @param {number} progress the state adjustment value when the gesture begins
 * @param {number} cancelProgress the state the gesture falls back to when cancelled
 * @param {number} limit the highest state a swipe may reach (WINDOW_PICKER)
 * @returns {number[]}
 */
export function clampSnapPoints(points, progress, cancelProgress, limit) {
    if (!Array.isArray(points) || points.length === 0)
        return points;
    if (!(progress <= limit + EPSILON) || !(cancelProgress <= limit + EPSILON))
        return points;
    const kept = points.filter(p => p <= limit + EPSILON);
    // Keep at least two points, or the tracker has nowhere to go
    return kept.length >= 2 ? kept : points;
}

