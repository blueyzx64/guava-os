// SPDX-License-Identifier: GPL-3.0-or-later
// The Now Playing tile: art, title, artist, play/pause and next for one MPRIS player.
// Players come from the shared MprisWatcher (one D-Bus watcher for the whole extension).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { MprisWatcher } from '../../core/mprisWatcher.js';

const ART_SIZE = 36;
const SYMBOLIC_ART_SIZE = 20;
const FADE_MS = 150;

export class NowPlaying {
    constructor({ gettext, cleanup }) {
        this._gettext = gettext;
        this._cleanup = cleanup;
        this._watch = null;
        this._players = [];
        this._tokens = new Map();   // player -> token of its 'changed' handler
        this._destroyed = false;

        this.actor = new St.BoxLayout({
            style_class: 'quick-toggle button guava-cc-now-playing',
            visible: false,
            x_expand: true,
        });
        this._art = new St.Icon({
            style_class: 'guava-cc-np-art guava-cc-np-art-symbolic',
            icon_size: SYMBOLIC_ART_SIZE,
            icon_name: 'audio-x-generic-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({ style_class: 'guava-cc-np-title' });
        this._artist = new St.Label({ style_class: 'guava-cc-np-artist' });
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(this._title);
        text.add_child(this._artist);
        this._playPause = this._button('media-playback-start-symbolic', gettext('Play'),
            () => this._current()?.playPause());
        this._next = this._button('media-skip-forward-symbolic', gettext('Next track'),
            () => this._current()?.next());
        for (const child of [this._art, text, this._playPause, this._next])
            this.actor.add_child(child);
    }

    _button(iconName, name, onClick) {
        const button = new St.Button({
            style_class: 'guava-cc-np-button',
            accessible_name: name,
            can_focus: true,
            child: new St.Icon({ icon_name: iconName }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    async start() {
        if (this._destroyed || this._watch)
            return;
        this._watch = MprisWatcher.acquire(this._cleanup, this._gettext);
        this._watch.on('player-added', player => this._add(player));
        this._watch.on('player-removed', player => this._remove(player));
        this._watch.players.forEach(player => this._add(player));
    }

    _add(player) {
        if (this._players.includes(player))
            return;
        this._players.push(player);
        this._tokens.set(player, player.connect('changed', () => this._update()));
        this._update();
    }

    _remove(player) {
        const token = this._tokens.get(player);
        if (token !== undefined)
            player.disconnect(token);
        this._tokens.delete(player);
        this._players = this._players.filter(p => p !== player);
        this._update();
    }

    _current() {
        return this._players.find(p => p.isPlaying()) ?? this._players.at(-1) ?? null;
    }

    _update() {
        const player = this._current();
        const show = !!player;
        if (show) {
            this._title.text = player.trackTitle ?? '';
            this._artist.text = (player.trackArtists ?? []).join(', ');
            this._art.gicon = this._artIcon(player);
            const playing = player.isPlaying();
            this._playPause.child.icon_name = playing
                ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            this._playPause.accessible_name = playing ? this._gettext('Pause') : this._gettext('Play');
            A11y.setEnabled(this._next, player.canGoNext);
        }
        this._show(show);
    }

    _artIcon(player) {
        // Local files and http(s) URLs (St loads a FileIcon asynchronously through GIO/GVfs);
        // the app icon is the fallback if the art cannot load.
        const url = player.trackCoverUrl;
        const appIcon = player.app?.get_icon() ?? null;
        const plain = appIcon ?? new Gio.ThemedIcon({ name: 'audio-x-generic-symbolic' });
        this._art.fallback_gicon = plain;
        const cover = typeof url === 'string' && /^(file|https?):\/\//.test(url);
        // A bare symbolic note sits small in a tinted square instead of filling the art slot
        const symbolic = !cover && !appIcon;
        this._art.icon_size = symbolic ? SYMBOLIC_ART_SIZE : ART_SIZE;
        if (symbolic)
            this._art.add_style_class_name('guava-cc-np-art-symbolic');
        else
            this._art.remove_style_class_name('guava-cc-np-art-symbolic');
        return cover ? new Gio.FileIcon({ file: Gio.File.new_for_uri(url) }) : plain;
    }

    _show(show) {
        if (this.actor.visible === show)
            return;
        this.actor.remove_all_transitions();
        this.actor.visible = show;
        if (!show || !Glass.motion) {
            this.actor.opacity = 255;
            return;
        }
        this.actor.opacity = 0;
        this.actor.ease({ opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    destroy() {
        this._destroyed = true;
        for (const [player, token] of this._tokens)
            player.disconnect(token);
        this._tokens.clear();
        this._players = [];
        this._watch?.release();
        this._watch = null;
        this.actor.destroy();
    }
}
