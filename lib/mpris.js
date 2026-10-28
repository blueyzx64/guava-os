// SPDX-License-Identifier: GPL-3.0-or-later
// MPRIS player model: Player (one org.mpris.MediaPlayer2.* bus name) and Source (finds them).
// Source is not meant to be created directly; use core/mprisWatcher.js, which shares
// one Source between the notch and the Control Center.

import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { hasTrack, NO_TRACK_ID } from './mprisModel.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio.DBusProxy, 'new', 'new_finish');

const MPRIS_PLAYER_PREFIX = 'org.mpris.MediaPlayer2.';
const WEBKIT_TRACK_ID = '/org/mpris/MediaPlayer2/webkit';

const MEDIA_DBUS_XML = `<?xml version="1.0"?>
<node>
    <interface name="org.freedesktop.DBus.Properties">
        <method name="Get">
            <arg type="s" name="interface_name" direction="in"/>
            <arg type="s" name="property_name" direction="in"/>
            <arg type="v" name="value" direction="out"/>
        </method>
        <method name="GetAll">
            <arg type="s" name="interface_name" direction="in"/>
            <arg type="a{sv}" name="properties" direction="out"/>
        </method>
    </interface>
    <interface name="org.mpris.MediaPlayer2.Player">
        <method name="SetPosition">
            <arg type="o" name="TrackId" direction="in"/>
            <arg type="x" name="Position" direction="in"/>
        </method>
        <method name="Seek">
            <arg type="x" name="Offset" direction="in"/>
        </method>
        <method name="Play"/>
        <method name="Pause"/>
        <method name="Next"/>
        <method name="Previous"/>
        <signal name="Seeked">
            <arg type="x" name="Position"/>
        </signal>
        <property name="CanGoNext" type="b" access="read"/>
        <property name="CanGoPrevious" type="b" access="read"/>
        <property name="CanPlay" type="b" access="read"/>
        <property name="CanPause" type="b" access="read"/>
        <property name="CanControl" type="b" access="read"/>
        <property name="CanSeek" type="b" access="read"/>
        <property name="Metadata" type="a{sv}" access="read"/>
        <property name="PlaybackStatus" type="s" access="read"/>
    </interface>
    <interface name="org.mpris.MediaPlayer2">
        <method name="Raise"/>
        <property name="CanRaise" type="b" access="read"/>
        <property name="DesktopEntry" type="s" access="read"/>
        <property name="Identity" type="s" access="read"/>
    </interface>
</node>`;

let mediaNodeInfo = null;

function _lookupInterface(name) {
    mediaNodeInfo ??= Gio.DBusNodeInfo.new_for_xml(MEDIA_DBUS_XML);
    return mediaNodeInfo.interfaces.find(iface => iface.name === name);
}

const PROPERTIES_IFACE_NAME = 'org.freedesktop.DBus.Properties';
const PLAYER_IFACE_NAME = 'org.mpris.MediaPlayer2.Player';
const MPRIS_IFACE_NAME = 'org.mpris.MediaPlayer2';

export class Player extends GObject.Object {
    constructor(busName, gettext) {
        super();
        this._busName = busName;
        this._gettext = gettext;
        this.source = new MessageList.Source();
        this._canPlay = false;
        this._canSeek = false;
        this._trackKey = null;
        this._cancellable = new Gio.Cancellable();
        this._mprisProxy = null;
        this._playerProxy = null;
        this._propertiesProxy = null;
        this._seekRequest = 0;
        this._seekPending = null;

        const mprisIface = _lookupInterface(MPRIS_IFACE_NAME);
        const playerIface = _lookupInterface(PLAYER_IFACE_NAME);
        const propertiesIface = _lookupInterface(PROPERTIES_IFACE_NAME);

        const mprisPromise = Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.NONE,
            mprisIface,
            busName,
            '/org/mpris/MediaPlayer2',
            mprisIface.name,
            this._cancellable
        )
            .then(proxy => this._mprisProxy = proxy)
            .catch(() => {});

        const playerPromise = Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
            playerIface,
            busName,
            '/org/mpris/MediaPlayer2',
            playerIface.name,
            this._cancellable
        )
            .then(proxy => this._playerProxy = proxy)
            .catch(() => {});

        const propertiesPromise = Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.NONE,
            propertiesIface,
            busName,
            '/org/mpris/MediaPlayer2',
            propertiesIface.name,
            this._cancellable
        )
            .then(proxy => this._propertiesProxy = proxy)
            .catch(() => {});

        Promise.all([playerPromise, propertiesPromise, mprisPromise])
            .then(this._ready.bind(this))
            .catch(() => {});
    }

    get position() {
        return this._propertiesProxy?.GetAsync('org.mpris.MediaPlayer2.Player', 'Position')
            .then(result => result[0].get_int64())
            .catch(() => null);
    }

    async seek(value) {
        const proxy = this._playerProxy;
        const trackKey = this.trackKey;
        const request = ++this._seekRequest;
        if (!this.canSeek || !proxy || !Number.isFinite(value))
            return false;
        const length = Number.isFinite(this._length) && this._length > 0 ? this._length : null;
        const target = Math.round(length ? Math.min(length, Math.max(0, value)) : Math.max(0, value));
        // Wait for an applied seek before reading the next relative offset,
        // and discard targets superseded while a request was in flight.
        const pending = (this._seekPending ?? Promise.resolve()).then(async () => {
            if (!this.canSeek || proxy !== this._playerProxy || trackKey !== this.trackKey ||
                request !== this._seekRequest)
                return false;
            try {
                if (this._trackId === WEBKIT_TRACK_ID) {
                    // WebKit advertises SetPosition but rejects it, and its Seek
                    // method interprets the argument as an absolute position.
                    await proxy.SeekAsync(target);
                } else if (this._trackId && this._trackId !== NO_TRACK_ID) {
                    await proxy.SetPositionAsync(this._trackId, target);
                } else {
                    // Players without a track id (e.g. Gapless) only support relative seeks.
                    const current = await this.position;
                    if (!Number.isFinite(current) || !this.canSeek || proxy !== this._playerProxy ||
                        trackKey !== this.trackKey || request !== this._seekRequest)
                        return false;
                    await proxy.SeekAsync(target - current);
                }
                return true;
            } catch {
                return false;
            }
        });
        this._seekPending = pending;
        try {
            return await pending;
        } finally {
            if (this._seekPending === pending)
                this._seekPending = null;
        }
    }

    async refresh() {
        const proxy = this._playerProxy;
        const trackKey = this.trackKey;
        if (!proxy || !this._propertiesProxy)
            return;
        try {
            const [properties] = await this._propertiesProxy.GetAllAsync(PLAYER_IFACE_NAME);
            if (proxy !== this._playerProxy || trackKey !== this.trackKey)
                return;
            let changed = false;
            for (const name of ['Metadata', 'CanPlay', 'CanPause', 'CanControl', 'CanSeek', 'CanGoNext', 'CanGoPrevious']) {
                const value = properties[name];
                if (value && !proxy.get_cached_property(name)?.equal(value)) {
                    proxy.set_cached_property(name, value);
                    changed = true;
                }
            }
            if (changed)
                this._update();
        } catch {
            // Keep the cached state when a player cannot refresh its properties.
        }
    }

    get busName() { return this._busName; }
    get trackId() { return this._trackId; }
    get trackKey() { return this._trackKey; }
    get length() { return this._length; }
    get trackArtists() { return this._trackArtists; }
    get trackTitle() { return this._trackTitle; }
    get trackCoverUrl() { return this._trackCoverUrl; }
    get app() { return this._app; }
    get canControl() { return !!this._playerProxy && this._playerProxy.CanControl !== false; }
    // WebKit advertises navigation unconditionally, even without page handlers.
    get canGoNext() { return this.canControl && this.trackKey !== null && this.trackId !== WEBKIT_TRACK_ID && !!this._playerProxy.CanGoNext; }
    get canGoPrevious() { return this.canControl && this.trackKey !== null && this.trackId !== WEBKIT_TRACK_ID && !!this._playerProxy.CanGoPrevious; }
    get status() { return this._playerProxy?.PlaybackStatus; }
    get canPlay() { return this._canPlay; }
    get canPause() { return this.canControl && this.trackKey !== null && !!this._playerProxy.CanPause; }
    get canSeek() { return this._canSeek; }

    destroy() {
        this._cancellable.cancel();
        this._close();
    }

    _parseMetadata(metadata) {
        metadata ??= {};
        const trackId = metadata['mpris:trackid']?.deepUnpack();
        const length = metadata['mpris:length']?.deepUnpack();
        const title = metadata['xesam:title']?.deepUnpack();
        const url = metadata['xesam:url']?.deepUnpack();
        // Idle when neither the track details nor the playback state indicate media: Decibels
        // uses NoTrack for loaded audio, and Rhythmbox starts with empty Metadata.
        const noTrack = !hasTrack({ trackId, title, url, length }, this.status);
        // Gapless omits track ids and WebKit reuses one id for every track.
        const trackKey = noTrack ? null
            : JSON.stringify([trackId, url, title, metadata['xesam:artist']?.deepUnpack()]);
        if (this._trackKey !== trackKey)
            this._length = null;
        this._trackId = trackId;
        this._trackKey = trackKey;
        if (Number.isFinite(length) && length > 0)
            this._length = length;

        this._trackArtists = metadata['xesam:artist']?.deepUnpack();
        if (typeof this._trackArtists === 'string') {
            this._trackArtists = [this._trackArtists];
        } else if (!Array.isArray(this._trackArtists) || !this._trackArtists.every(artist => typeof artist === 'string')) {
            this._trackArtists = [this._gettext('Unknown artist')];
        }

        this._trackTitle = title;
        if (typeof this._trackTitle !== 'string')
            this._trackTitle = this._gettext('Unknown title');

        this._trackCoverUrl = metadata['mpris:artUrl']?.deepUnpack();
        if (typeof this._trackCoverUrl !== 'string')
            this._trackCoverUrl = null;

        if (this._mprisProxy?.DesktopEntry) {
            this._app = Shell.AppSystem.get_default().lookup_app(this._mprisProxy.DesktopEntry + '.desktop');
        } else {
            this._app = null;
        }

        this.source.set({
            title: this._app?.get_name() ?? this._mprisProxy?.Identity,
            icon: this._app?.get_icon() ?? null,
        });
    }

    _update() {
        const metadata = this._playerProxy?.Metadata;
        this._parseMetadata(metadata);
        this._setCanSeek(this.canControl && this.trackKey !== null && !!this._playerProxy?.CanSeek);
        this._setCanPlay(this.canControl && !!this._playerProxy?.CanPlay && this.trackKey !== null);
        this.emit('changed');
    }

    previous() {
        if (this.canGoPrevious)
            this._playerProxy.PreviousAsync().catch(() => {});
    }

    next() {
        if (this.canGoNext)
            this._playerProxy.NextAsync().catch(() => {});
    }

    playPause() {
        if (this.isPlaying() ? this.canPause : this.canPlay) {
            const action = this.isPlaying() ? 'PauseAsync' : 'PlayAsync';
            this._playerProxy[action]().catch(() => {});
        }
    }

    raise() {
        if (this._app) {
            this._app.activate();
        } else if (this._mprisProxy?.CanRaise) {
            this._mprisProxy.RaiseAsync().catch(() => {});
        }
    }

    isPlaying() { return this.status === 'Playing'; }

    _ready() {
        // destroy() cancels pending proxy lookups, so they never arrive here
        if (!this._mprisProxy || !this._playerProxy)
            return;

        const mprisProxy = this._mprisProxy;
        mprisProxy.connectObject('notify::g-name-owner', () => {
            if (!this._mprisProxy?.g_name_owner)
                this._close();
        }, this);

        if (!mprisProxy.g_name_owner) {
            this._close();
            return;
        }

        this._playerProxy.connectObject('g-properties-changed', this._update.bind(this), this);
        this._playerProxy.connectObject('g-signal', (_proxy, _sender, name, parameters) => {
            if (name === 'Seeked')
                this.emit('seeked', parameters.deep_unpack()[0]);
        }, this);
        this._update();
    }

    _close() {
        this._mprisProxy?.disconnectObject(this);
        this._playerProxy?.disconnectObject(this);
        this._mprisProxy = null;
        this._playerProxy = null;
        this._propertiesProxy = null;
        this._setCanPlay(false);
        this._setCanSeek(false);
    }

    _setCanPlay(value) {
        if (this._canPlay === value)
            return;
        this._canPlay = value;
        this.notify('can-play');
    }

    _setCanSeek(value) {
        if (this._canSeek === value)
            return;
        this._canSeek = value;
        this.notify('can-seek');
    }
}

GObject.registerClass({
    Signals: {
        'changed': { param_types: [] },
        'seeked': { param_types: [GObject.TYPE_INT64] },
    },
    Properties: {
        'can-play': GObject.ParamSpec.boolean('can-play', 'can-play', 'Whether the player can play', GObject.ParamFlags.READABLE, false),
        'can-seek': GObject.ParamSpec.boolean('can-seek', 'can-seek', 'Whether the player can seek', GObject.ParamFlags.READABLE, false),
    },
}, Player);

export class Source extends GObject.Object {
    constructor(gettext) {
        super();
        this._players = new Map();
        this._gettext = gettext;
        this._cancellable = null;
        this._nameOwnerSub = 0;
    }

    /** Begin watching the session bus. Async, cancelled by stop(). Safe to call twice. */
    start() {
        if (this._cancellable)
            return;
        const cancellable = this._cancellable = new Gio.Cancellable();
        const bus = Gio.DBus.session;
        // Subscribe first so a player starting while ListNames is out is not missed;
        // _addPlayer ignores duplicates.
        this._nameOwnerSub = bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', MPRIS_PLAYER_PREFIX.slice(0, -1), Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _sender, _path, _iface, _signal, params) =>
                this._onNameOwnerChanged(...params.deepUnpack()));
        this._listNames(bus, cancellable);
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._nameOwnerSub) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerSub);
            this._nameOwnerSub = 0;
        }

        const players = [...this._players.values()];
        this._players.clear();

        for (const player of players) {
            player.disconnectObject(this);
            this.emit('player-removed', player);
            player.destroy();
        }
    }

    destroy() {
        this.stop();
    }

    get players() {
        return [...this._players.values()].filter(player => player.canPlay);
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new Player(busName, this._gettext);
        this._players.set(busName, player);

        player.connectObject('notify::can-play', () => {
            this.emit(player.canPlay ? 'player-added' : 'player-removed', player);
        }, this);

        if (player.canPlay)
            this.emit('player-added', player);
    }

    async _listNames(bus, cancellable) {
        try {
            const reply = await bus.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'ListNames', null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, cancellable);
            // stop(), or stop() and start() again, while the call was out
            if (this._cancellable !== cancellable)
                return;
            const [names] = reply.deepUnpack();
            for (const name of names) {
                if (name.startsWith(MPRIS_PLAYER_PREFIX))
                    this._addPlayer(name);
            }
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('[Guava] Failed to enumerate MPRIS players:', error);
        }
    }

    _onNameOwnerChanged(name, oldOwner, newOwner) {
        if (!name.startsWith(MPRIS_PLAYER_PREFIX))
            return;

        if (oldOwner) {
            const player = this._players.get(name);
            if (player) {
                this._players.delete(name);
                player.disconnectObject(this);
                this.emit('player-removed', player);
                player.destroy();
            }
        }

        if (newOwner)
            this._addPlayer(name);
    }
}

GObject.registerClass({
    Signals: {
        'player-added': { param_types: [Player] },
        'player-removed': { param_types: [Player] },
    },
}, Source);
