// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for the expanded notch: its size, track times, the clock and the card size. No
// gi:// imports; tested by tests/notchDashboardModel.test.js.

/** The expanded notch: one shape for every tab, on a 4px grid (logical px). Header band 32
 * (level with the top bar), body 136 (art 68 + 12 + scrubber 16 + 8 + controls 32), 4 + 20
 * padding; two columns of 340 and 248 with a 20 gap and 20 sides. */
export const DASH_SIZE = Object.freeze({ w: 648, h: 192, r: 32 });

/** @returns {string} "m:ss", or "h:mm:ss" from one hour on; '' for unknown input */
export function formatTrackTime(us) {
    if (!Number.isFinite(us) || us < 0)
        return '';
    const total = Math.floor(us / 1e6);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * @param {number|null} positionUs from MPRIS Position
 * @param {number|null} lengthUs from mpris:length
 * @returns {{fraction: number, elapsed: string, remaining: string}|null} null when the player
 *   gives no usable length or position (live streams, some browsers): no scrubber then
 */
export function trackProgress(positionUs, lengthUs) {
    if (!Number.isFinite(lengthUs) || lengthUs <= 0 || !Number.isFinite(positionUs) || positionUs < 0)
        return null;
    const pos = Math.min(positionUs, lengthUs);
    return {
        fraction: pos / lengthUs,
        elapsed: formatTrackTime(pos),
        remaining: `-${formatTrackTime(lengthUs - pos)}`,
    };
}

/**
 * Where a click on the scrubber seeks to.
 * @param {number} fraction 0..1 across the track (clamped)
 * @param {number|null} lengthUs from mpris:length
 * @returns {number|null} the target in microseconds, or null without a usable length
 */
export function seekTarget(fraction, lengthUs) {
    if (!Number.isFinite(lengthUs) || lengthUs <= 0 || !Number.isFinite(fraction))
        return null;
    return Math.round(Math.max(0, Math.min(1, fraction)) * lengthUs);
}

/**
 * @param {number} hours 0..23
 * @param {number} minutes 0..59
 * @param {'24h'|'12h'} format org.gnome.desktop.interface clock-format
 * @returns {{time: string, suffix: string}} suffix is 'AM'/'PM' in 12h, else ''
 */
export function formatClock(hours, minutes, format) {
    const mm = String(minutes).padStart(2, '0');
    if (format === '12h') {
        const h = hours % 12 === 0 ? 12 : hours % 12;
        return { time: `${h}:${mm}`, suffix: hours < 12 ? 'AM' : 'PM' };
    }
    return { time: `${String(hours).padStart(2, '0')}:${mm}`, suffix: '' };
}

/**
 * The notification card fits its content: header, title and two lines of body, plus a row of
 * action buttons when there are any.
 * @returns {{w: number, h: number, r: number}}
 */
export function cardSize({ actions }) {
    return { w: 430, h: actions ? 156 : 116, r: DASH_SIZE.r };
}
