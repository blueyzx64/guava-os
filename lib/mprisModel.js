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

/** WebKit's shared track id: it advertises navigation it does not implement and wants absolute Seek. */
export const WEBKIT_TRACK_ID = '/org/mpris/MediaPlayer2/webkit';

/**
 * Identity of a track across players that omit ids or reuse one id for everything.
 * @param {{trackId?: string, url?: string, title?: string, artists?: string[]}} t
 * @param {boolean} loaded false when the player holds no track
 * @returns {string|null} null when nothing is loaded
 */
export function trackKey(t, loaded) {
    if (!loaded)
        return null;
    return JSON.stringify([t?.trackId ?? '', t?.url ?? '', t?.title ?? '', t?.artists ?? []]);
}

/**
 * @param {unknown} value Metadata xesam:artist
 * @param {string} unknown the localised "Unknown artist"
 * @returns {string[]}
 */
export function normalizeArtists(value, unknown) {
    if (typeof value === 'string')
        return [value];
    if (Array.isArray(value) && value.length > 0 && value.every(a => typeof a === 'string'))
        return value;
    return [unknown];
}

/** @returns {string} the title, or `unknown` (localised "Unknown title") when it is not a string */
export function normalizeTitle(value, unknown) {
    return typeof value === 'string' ? value : unknown;
}

/** @returns {string|null} cover URL if it is a string */
export function normalizeCover(value) {
    return typeof value === 'string' ? value : null;
}

/** @returns {number|null} length in microseconds when finite and > 0 */
export function normalizeLength(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Round a seek target to whole microseconds inside [0, length] (only the lower bound when the
 * length is unknown). NaN and infinities give null.
 * @returns {number|null}
 */
export function clampSeekTarget(value, length) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    let t = Math.max(0, value);
    if (Number.isFinite(length) && length > 0)
        t = Math.min(t, length);
    return Math.round(t);
}

/**
 * Which D-Bus call moves the playhead.
 *   'seek-absolute'  WebKit: Seek(target), its argument is absolute
 *   'set-position'   a real track id: SetPosition(trackId, target)
 *   'seek-relative'  no usable id (Gapless and the like): Seek(target - Position)
 * @param {string|null|undefined} trackId
 * @returns {'seek-absolute'|'set-position'|'seek-relative'}
 */
export function seekMethod(trackId) {
    if (trackId === WEBKIT_TRACK_ID)
        return 'seek-absolute';
    if (typeof trackId === 'string' && trackId !== '' && trackId !== NO_TRACK_ID)
        return 'set-position';
    return 'seek-relative';
}

/** Navigation needs control and a track, and never works on WebKit's shared id. */
export function canNavigate({ control, loaded, trackId, can }) {
    return !!control && !!loaded && !!can && trackId !== WEBKIT_TRACK_ID;
}
