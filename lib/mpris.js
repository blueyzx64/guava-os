// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// MPRIS over the session bus: finds media players (org.mpris.MediaPlayer2.*), follows each
// one's playback state and track, and exposes the controls. Features never create a Source
// themselves: core/mprisWatcher.js owns the one shared instance.
//
//   const source = new Source(gettext);  source.start();
//   source.connect('player-added', (_s, player) => ...);   // a player that can play
//   player.connect('changed', () => player.trackTitle ...);
//
// The decisions that need no D-Bus (track identity, text fallbacks, seek method and clamping)
// live in lib/mprisModel.js and are tested there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

import {
    hasTrack, trackKey, normalizeArtists, normalizeTitle, normalizeCover, normalizeLength,
    clampSeekTarget, seekMethod, canNavigate,
} from './mprisModel.js';

const LOG = '[Guava]';
const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const IFACE_ROOT = 'org.mpris.MediaPlayer2';
const IFACE_PLAYER = 'org.mpris.MediaPlayer2.Player';
const IFACE_PROPS = 'org.freedesktop.DBus.Properties';
const PLAYER_PROPS = ['Metadata', 'CanPlay', 'CanPause', 'CanControl', 'CanSeek', 'CanGoNext', 'CanGoPrevious'];

const XML = `<node>
  <interface name="${IFACE_ROOT}">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="Identity" type="s" access="read"/>
  </interface>
  <interface name="${IFACE_PLAYER}">
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg type="x" direction="in"/></method>
    <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
    <signal name="Seeked"><arg type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
  <interface name="${IFACE_PROPS}">
    <method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
    <method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method>
  </interface>
</node>`;
const NODE = Gio.DBusNodeInfo.new_for_xml(XML);
const iface = name => NODE.lookup_interface(name);

const TIMEOUT = -1;

function newProxy(busName, interfaceName, flags, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, flags, iface(interfaceName),
            busName, OBJECT_PATH, interfaceName, cancellable, (_o, res) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function callProxy(proxy, method, params, cancellable = null) {
    return new Promise((resolve, reject) => {
        proxy.call(method, params, Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT, cancellable, (_o, res) => {
            try {
                resolve(proxy.call_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Fire and forget: a player that vanished or refuses is not an error worth surfacing.
function fire(proxy, method, params = null) {
    proxy?.call(method, params, Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT, null, (_o, res) => {
        try {
            proxy.call_finish(res);
        } catch (_e) {
            // Ignored on purpose.
        }
    });
}

const isCancelled = e => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

export const Player = GObject.registerClass({
    Properties: {
        'can-play': GObject.ParamSpec.boolean('can-play', null, null, GObject.ParamFlags.READABLE, false),
        'can-seek': GObject.ParamSpec.boolean('can-seek', null, null, GObject.ParamFlags.READABLE, false),
    },
    Signals: {
        'changed': {},
        'seeked': { param_types: [GObject.TYPE_INT64] },
    },
}, class Player extends GObject.Object {
    _init(busName, gettext) {
        super._init();
        this._busName = busName;
        this._gettext = gettext;
        this._cancellable = new Gio.Cancellable();
        this._root = null;
        this._player = null;
        this._props = null;
        this._handlers = [];
        this._app = null;
        this._status = undefined;
        this._trackId = null;
        this._trackKey = null;
        this._length = null;
        this._artists = [];
        this._title = '';
        this._cover = null;
        this._canPlayProp = false;
        this._canSeekProp = false;
        this._seekTicket = 0;
        this._seekChain = Promise.resolve();
        this.source = new MessageList.Source();
        this._connect().catch(() => {});
    }

    // Proxies

    async _connect() {
        const flags = Gio.DBusProxyFlags.DO_NOT_AUTO_START;
        const c = this._cancellable;
        let root, player, props;
        try {
            [root, player, props] = await Promise.all([
                newProxy(this._busName, IFACE_ROOT, flags, c),
                newProxy(this._busName, IFACE_PLAYER, flags | Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, c),
                newProxy(this._busName, IFACE_PROPS, flags, c),
            ]);
        } catch (_e) {
            return;
        }
        if (c.is_cancelled())
            return;
        this._root = root;
        this._player = player;
        this._props = props;
        if (!player.g_name_owner) {
            this._close();
            return;
        }
        this._handlers.push(
            [player, player.connect('notify::g-name-owner', () => {
                if (!player.g_name_owner)
                    this._close();
            })],
            [player, player.connect('g-properties-changed', (_p, _changed, invalidated) => {
                this._update();
                if (invalidated.length > 0)
                    this.refresh().catch(() => {});
            })],
            [player, player.connect('g-signal', (_p, _sender, name, params) => {
                if (name === 'Seeked')
                    this.emit('seeked', params.deepUnpack()[0]);
            })]);
        this._update();
    }

    _close() {
        for (const [obj, id] of this._handlers)
            obj.disconnect(id);
        this._handlers = [];
        this._root = this._player = this._props = null;
        this._setFlags(false, false);
    }

    _setFlags(canPlay, canSeek) {
        if (canPlay !== this._canPlayProp) {
            this._canPlayProp = canPlay;
            this.notify('can-play');
        }
        if (canSeek !== this._canSeekProp) {
            this._canSeekProp = canSeek;
            this.notify('can-seek');
        }
    }

    // State

    _flag(name) {
        return this._player?.get_cached_property(name)?.get_boolean() === true;
    }

    _metadata() {
        try {
            return this._player?.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        } catch (_e) {
            return {};
        }
    }

    _update() {
        if (!this._player)
            return;
        const md = this._metadata();
        this._status = this._player.get_cached_property('PlaybackStatus')?.get_string()[0];
        const trackId = typeof md['mpris:trackid'] === 'string' ? md['mpris:trackid'] : null;
        const url = typeof md['xesam:url'] === 'string' ? md['xesam:url'] : '';
        const rawTitle = md['xesam:title'];
        const length = normalizeLength(md['mpris:length']);
        const loaded = hasTrack({
            trackId: trackId ?? undefined,
            title: typeof rawTitle === 'string' ? rawTitle : '',
            url,
            length: length ?? undefined,
        }, this._status);

        this._artists = normalizeArtists(md['xesam:artist'], this._gettext('Unknown artist'));
        this._title = normalizeTitle(rawTitle, this._gettext('Unknown title'));
        this._cover = normalizeCover(md['mpris:artUrl']);
        this._trackId = trackId;
        const key = trackKey({ trackId, url, title: this._title, artists: this._artists }, loaded);
        if (key !== this._trackKey)
            this._length = null;
        this._trackKey = key;
        if (length !== null)
            this._length = length;

        const entry = this._root?.get_cached_property('DesktopEntry')?.get_string()[0];
        this._app = entry ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`) : null;
        this.source.title = this._app?.get_name() ??
            this._root?.get_cached_property('Identity')?.get_string()[0] ?? '';
        this.source.icon = this._app?.get_icon() ?? null;

        const control = this.canControl;
        this._setFlags(control && this._flag('CanPlay') && loaded, control && loaded && this._flag('CanSeek'));
        this.emit('changed');
    }

    // Getters

    get busName() { return this._busName; }
    get trackId() { return this._trackId; }
    get trackKey() { return this._trackKey; }
    get length() { return this._length; }
    get trackArtists() { return this._artists; }
    get trackTitle() { return this._title; }
    get trackCoverUrl() { return this._cover; }
    get app() { return this._app; }
    get status() { return this._status; }
    get canPlay() { return this._canPlayProp; }
    get canSeek() { return this._canSeekProp; }
    get can_play() { return this._canPlayProp; }
    get can_seek() { return this._canSeekProp; }

    get canControl() {
        return !!this._player && this._player.get_cached_property('CanControl')?.get_boolean() !== false;
    }

    get canPause() {
        return this.canControl && this._trackKey !== null && this._flag('CanPause');
    }

    get canGoNext() {
        return canNavigate({
            control: this.canControl, loaded: this._trackKey !== null, trackId: this._trackId,
            can: this._flag('CanGoNext'),
        });
    }

    get canGoPrevious() {
        return canNavigate({
            control: this.canControl, loaded: this._trackKey !== null, trackId: this._trackId,
            can: this._flag('CanGoPrevious'),
        });
    }

    /** @returns {Promise<number|null>} microseconds, null when unreadable */
    get position() {
        const props = this._props;
        if (!props)
            return Promise.resolve(null);
        return callProxy(props, 'Get', new GLib.Variant('(ss)', [IFACE_PLAYER, 'Position']), this._cancellable)
            .then(res => res.get_child_value(0).get_variant().get_int64())
            .catch(() => null);
    }

    // Controls

    isPlaying() {
        return this._status === 'Playing';
    }

    playPause() {
        if (this.isPlaying()) {
            if (this.canPause)
                fire(this._player, 'Pause');
        } else if (this.canPlay) {
            fire(this._player, 'Play');
        }
    }

    previous() {
        if (this.canGoPrevious)
            fire(this._player, 'Previous');
    }

    next() {
        if (this.canGoNext)
            fire(this._player, 'Next');
    }

    raise() {
        if (this._app)
            this._app.activate();
        else if (this._root?.get_cached_property('CanRaise')?.get_boolean())
            fire(this._root, 'Raise');
    }

    /**
     * Move the playhead to an absolute position. Requests run one after another; one that a
     * newer call, a track change, a new connection or a loss of seeking overtakes gives false.
     * @param {number} value microseconds
     * @returns {Promise<boolean>}
     */
    seek(value) {
        const ticket = ++this._seekTicket;
        const run = async () => {
            if (ticket !== this._seekTicket || !this.canSeek || !this._player)
                return false;
            const proxy = this._player;
            const key = this._trackKey;
            const stale = () => ticket !== this._seekTicket || this._player !== proxy ||
                this._trackKey !== key || !this.canSeek;
            const target = clampSeekTarget(value, this._length);
            if (target === null)
                return false;
            try {
                const method = seekMethod(this._trackId);
                if (method === 'seek-absolute') {
                    await callProxy(proxy, 'Seek', new GLib.Variant('(x)', [target]), this._cancellable);
                } else if (method === 'set-position') {
                    await callProxy(proxy, 'SetPosition',
                        new GLib.Variant('(ox)', [this._trackId, target]), this._cancellable);
                } else {
                    const current = await this.position;
                    if (current === null || stale())
                        return false;
                    await callProxy(proxy, 'Seek', new GLib.Variant('(x)', [target - current]), this._cancellable);
                }
                return true;
            } catch (_e) {
                return false;
            }
        };
        const result = this._seekChain.then(run);
        this._seekChain = result.catch(() => false);
        return result;
    }

    /** Re-read the player's properties; for players that change them without a signal. */
    async refresh() {
        const props = this._props;
        const proxy = this._player;
        if (!props || !proxy)
            return;
        const key = this._trackKey;
        let all;
        try {
            const res = await callProxy(props, 'GetAll', new GLib.Variant('(s)', [IFACE_PLAYER]), this._cancellable);
            all = res.get_child_value(0);
        } catch (_e) {
            return;
        }
        if (this._player !== proxy || this._trackKey !== key)
            return;
        let dirty = false;
        for (const name of PLAYER_PROPS) {
            const fresh = all.lookup_value(name, null);
            if (!fresh)
                continue;
            const old = proxy.get_cached_property(name);
            if (!old || !old.equal(fresh)) {
                proxy.set_cached_property(name, fresh);
                dirty = true;
            }
        }
        if (dirty)
            this._update();
    }

    destroy() {
        this._cancellable.cancel();
        this._seekTicket++;
        this._close();
    }
});

export const Source = GObject.registerClass({
    Signals: {
        'player-added': { param_types: [Player.$gtype] },
        'player-removed': { param_types: [Player.$gtype] },
    },
}, class Source extends GObject.Object {
    _init(gettext) {
        super._init();
        this._gettext = gettext;
        this._entries = new Map();   // busName -> { player, announced, id }
        this._subscription = 0;
        this._cancellable = null;
    }

    /** Players that can play now (they have been announced with 'player-added'). */
    get players() {
        return [...this._entries.values()].filter(e => e.player.canPlay).map(e => e.player);
    }

    start() {
        if (this._cancellable)
            return;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        // Subscribe before listing so a player starting in between is not missed.
        this._subscription = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            IFACE_ROOT, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _s, _p, _i, _n, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (oldOwner)
                    this._drop(name);
                if (newOwner)
                    this._add(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                if (this._cancellable !== cancellable)
                    return;
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    for (const name of names) {
                        if (name.startsWith(PREFIX))
                            this._add(name);
                    }
                } catch (e) {
                    if (!isCancelled(e))
                        console.error(`${LOG} MPRIS: listing players failed:`, e);
                }
            });
    }

    _add(busName) {
        if (this._entries.has(busName))
            return;
        const player = new Player(busName, this._gettext);
        const entry = { player, announced: false, id: 0 };
        this._entries.set(busName, entry);
        const sync = () => {
            if (player.canPlay && !entry.announced) {
                entry.announced = true;
                this.emit('player-added', player);
            } else if (!player.canPlay && entry.announced) {
                entry.announced = false;
                this.emit('player-removed', player);
            }
        };
        entry.id = player.connect('notify::can-play', sync);
        sync();
    }

    _drop(busName) {
        const entry = this._entries.get(busName);
        if (!entry)
            return;
        this._entries.delete(busName);
        entry.player.disconnect(entry.id);
        if (entry.announced)
            this.emit('player-removed', entry.player);
        entry.player.destroy();
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._subscription) {
            Gio.DBus.session.signal_unsubscribe(this._subscription);
            this._subscription = 0;
        }
        for (const name of [...this._entries.keys()])
            this._drop(name);
    }

    destroy() {
        this.stop();
    }
});
