// SPDX-License-Identifier: GPL-3.0-or-later
// Pointer click rules shared by the wallpaper clicks of Show Desktop and Stage Manager.
// No gi imports.

/**
 * A press and release count as a click (not a drag or a long press).
 *
 * @param {{x, y, time}} press
 * @param {{x, y, time}} release
 * @param {{slop?: number, maxMs?: number}} [opts] px the pointer may travel, ms it may be held
 */
export function isClick(press, release, { slop = 6, maxMs = 600 } = {}) {
    if (!press || !release)
        return false;
    const dist = Math.hypot(release.x - press.x, release.y - press.y);
    const dt = release.time - press.time;
    return dist <= slop && dt >= 0 && dt <= maxMs;
}
