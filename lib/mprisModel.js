// SPDX-License-Identifier: GPL-3.0-or-later
// Pure MPRIS decisions shared by lib/mpris.js and the notch. No gi:// imports; tested by
// tests/mprisModel.test.js.

export const NO_TRACK_ID = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

/**
 * Does the player hold a track? A player that is neither playing nor paused and reports no
 * title, URL or length has nothing loaded, whatever its track id says: Rhythmbox, for one,
 * publishes empty Metadata and CanPlay=true at startup, and Decibels uses the NoTrack id.
 * A playing or paused player always counts (some only fill in Metadata later).
 * @param {{trackId?: string, title?: string, url?: string, length?: number}} track
 * @param {string|undefined} status PlaybackStatus
 * @returns {boolean}
 */
export function hasTrack(track, status) {
    if (status === 'Playing' || status === 'Paused')
        return true;
    const { title, url, length } = track ?? {};
    return !!title || !!url || (Number.isFinite(length) && length > 0);
}

const RANK = { Playing: 2, Paused: 1 };

/**
 * The player to show: playing beats paused beats the rest; among equals the one that started
 * playing last wins (a newly started player takes over, like macOS), then the given order.
 * @template T
 * @param {Array<{status: string, since: number, item: T}>} entries since: when it last started playing
 * @returns {T|null}
 */
export function pickPlayer(entries) {
    let best = null;
    for (const e of entries ?? []) {
        const rank = RANK[e.status] ?? 0;
        const since = Number.isFinite(e.since) ? e.since : -Infinity;
        if (!best || rank > best.rank || (rank === best.rank && since > best.since))
            best = { rank, since, item: e.item };
    }
    return best ? best.item : null;
}

/**
 * Should the media live activity show for this status? Playing shows the moving waveform,
 * Paused a still one; Stopped (or unknown) shows nothing.
 * @param {string|undefined} status
 * @returns {boolean}
 */
export function showsActivity(status) {
    return status === 'Playing' || status === 'Paused';
}
