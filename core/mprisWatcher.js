// SPDX-License-Identifier: GPL-3.0-or-later
// MprisWatcher: ONE shared MPRIS player source for the whole extension.
//
// The notch and the Control Center's Now Playing both need the list of players. They share
// one lib/mpris.js Source, started by the first user and stopped (cancelling its pending
// D-Bus calls) when the last one lets go.
//
//   import { MprisWatcher } from './mprisWatcher.js';
//   const watch = MprisWatcher.acquire(cleanup, gettext);   // released on cleanup.dispose()
//   watch.players                                           // players that can play right now
//   watch.on('player-added' | 'player-removed', (player) => ...);
//   watch.release();                                        // idempotent; drops its handlers
//
// Player (lib/mpris.js) exposes status, trackTitle, trackArtists, trackCoverUrl, app,
// isPlaying(), playPause(), next(), previous(), and a 'changed' signal.

import { Source } from '../lib/mpris.js';

let source = null;
let refs = 0;

class Handle {
    constructor(src) {
        this._source = src;
        this._ids = [];
    }

    /** @returns {Player[]} the players that can play (they have already been announced) */
    get players() {
        return this._source ? this._source.players : [];
    }

    /**
     * @param {'player-added'|'player-removed'} signal
     * @param {function(Player): void} fn
     */
    on(signal, fn) {
        if (!this._source)
            return;
        this._ids.push(this._source.connect(signal, (_s, player) => fn(player)));
    }

    release() {
        const src = this._source;
        if (!src)
            return;
        this._source = null;
        for (const id of this._ids)
            src.disconnect(id);
        this._ids = [];
        refs--;
        if (refs === 0 && source === src) {
            source = null;
            src.destroy();
        }
    }
}

export const MprisWatcher = {
    /**
     * @param {CleanupRegistry} cleanup the handle is released when it is disposed
     * @param {function(string): string} gettext used for "Unknown title" and the like
     * @returns {Handle}
     */
    acquire(cleanup, gettext) {
        if (!source) {
            // Share the source only once it has started; a failed start leaves nothing behind
            // for the next acquire() to reuse.
            const fresh = new Source(gettext);
            try {
                fresh.start();
            } catch (e) {
                try {
                    fresh.destroy();
                } catch (_e) {
                    // Nothing more to undo.
                }
                throw e;
            }
            source = fresh;
            refs = 0;
        }
        refs++;
        const handle = new Handle(source);
        cleanup?.add(() => handle.release());
        return handle;
    },

    /** @returns {number} how many users hold the watcher (for tests and debugging) */
    refCount() {
        return refs;
    },
};
