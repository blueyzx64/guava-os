// SPDX-License-Identifier: GPL-3.0-or-later
// Now Playing data: the MPRIS player to show (playing beats paused, the last one started wins),
// through the extension's one shared watcher (core/mprisWatcher.js). The widget's buttons
// call playPause() / next() / previous() here.

import { MprisWatcher } from '../../mprisWatcher.js';
import { pickPlayer } from '../../../lib/mprisModel.js';
import { Provider } from './base.js';

export class MediaProvider extends Provider {
    initial() {
        return { player: null };
    }

    run(cleanup) {
        const watch = MprisWatcher.acquire(cleanup, this._env.gettext);
        this._since = new Map();
        this._watched = new Map(); // player -> signal id
        const follow = player => {
            if (this._watched.has(player))
                return;
            this._watched.set(player, player.connect('changed', () => this._pick(watch)));
            this._pick(watch);
        };
        watch.on('player-added', follow);
        watch.on('player-removed', player => {
            const id = this._watched.get(player);
            if (id) {
                player.disconnect(id);
                this._watched.delete(player);
            }
            this._since.delete(player);
            this._pick(watch);
        });
        cleanup.add(() => {
            for (const [player, id] of this._watched)
                player.disconnect(id);
            this._watched.clear();
            this._since.clear();
            this._player = null;
        });
        for (const p of watch.players)
            follow(p);
        this._pick(watch);
    }

    _pick(watch) {
        const entries = watch.players.map(p => {
            if (p.status === 'Playing' && !this._since.has(p))
                this._since.set(p, Date.now());
            else if (p.status !== 'Playing')
                this._since.delete(p);
            return { status: p.status, since: this._since.get(p), item: p };
        });
        const p = pickPlayer(entries);
        this._player = p;
        this.publish({
            player: p ? {
                trackTitle: p.trackTitle, trackArtists: p.trackArtists, trackCoverUrl: p.trackCoverUrl,
                status: p.status, canGoNext: p.canGoNext, canGoPrevious: p.canGoPrevious,
                appName: p.app?.get_name?.() ?? '',
            } : null,
        });
    }

    playPause() {
        this._player?.playPause();
    }

    next() {
        this._player?.next();
    }

    previous() {
        this._player?.previous();
    }

    raise() {
        this._player?.raise();
    }
}
