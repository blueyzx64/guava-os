// SPDX-License-Identifier: GPL-3.0-or-later
// The status-item host: apps' tray icons (StatusNotifierItem) in the menu bar.
//
// GNOME has no StatusNotifierItem host. Who draws the icons (model.js hostMode):
//   - The AppIndicator extension enabled (appindicatorsupport@rgcjonas.gmail.com, or Ubuntu's
//     fork): it owns org.kde.StatusNotifierWatcher and draws them. Guava does not ask for the
//     name; the manager hides and orders that extension's icons instead.
//     Turning the extension on while Guava hosts makes Guava let go of the name: the extension's
//     queued request then gets it, and the apps re-register with it.
//   - Nobody owns the watcher name: Guava owns it (never replacing anyone), keeps the list of
//     items, drops an item when its bus name vanishes, and draws them.
//   - Another program owns it (a KDE session, a tray daemon): Guava registers as a host with it
//     and draws the items it lists.
// If Guava loses the name to someone else, it becomes a client of the new owner.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import {
    APPINDICATOR_UUIDS, WATCHER_NAME, WATCHER_PATH, hostMode, itemAddress, parseItemAddress,
} from './model.js';
import { SniItem } from './sniItem.js';

const WATCHER_XML = `<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg type="s" direction="in" name="service"/></method>
    <method name="RegisterStatusNotifierHost"><arg type="s" direction="in" name="service"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>`;

const ERROR_STATES = new Set([ExtensionState.ERROR, ExtensionState.OUT_OF_DATE].filter(s => s !== undefined));

/** True when the AppIndicator extension is (about to be) enabled. */
function appIndicatorEnabled() {
    if (global.settings.get_boolean('disable-user-extensions'))
        return false;
    const enabled = global.settings.get_strv('enabled-extensions');
    return APPINDICATOR_UUIDS.some(uuid => {
        const state = Main.extensionManager.lookup(uuid)?.state;
        return enabled.includes(uuid) && state !== undefined && !ERROR_STATES.has(state);
    });
}

export class StatusItemHost {
    /**
     * @param {object} ctx
     * @param {CleanupRegistry} cleanup
     * @param {object} hooks
     * @param {(item: SniItem) => void} hooks.added the item has its first properties
     * @param {(item: SniItem) => void} hooks.changed
     * @param {(item: SniItem) => void} hooks.removed
     * @param {() => void} hooks.modeChanged
     */
    constructor(ctx, cleanup, hooks) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._hooks = hooks;
        this._mode = null;
        this._run = null;          // CleanupRegistry of the current mode
        this._items = new Map();   // address -> SniItem
        this._enabled = false;
    }

    /** 'own' | 'client' | 'defer' | 'off' */
    get mode() {
        return this._mode;
    }

    get items() {
        return [...this._items.values()];
    }

    start(enabled) {
        this._enabled = enabled;
        const sync = () => this.sync();
        this._cleanup.connect(Main.extensionManager, 'extension-state-changed', sync);
        this._cleanup.connect(global.settings, 'changed::enabled-extensions', sync);
        this._cleanup.connect(global.settings, 'changed::disable-user-extensions', sync);
        this._cleanup.add(() => this._stopMode());
        this.sync();
    }

    setEnabled(enabled) {
        this._enabled = enabled;
        this.sync();
    }

    /** Re-decide the mode; an unknown watcher owner is looked up first. */
    sync() {
        const appIndicator = appIndicatorEnabled();
        if (!this._enabled || appIndicator) {
            this._switch(hostMode({ enabled: this._enabled, appIndicator, otherOwner: false }));
            return;
        }
        if (this._mode === 'own' || this._mode === 'client')
            return;
        this._lookupOwner(otherOwner => {
            // Re-checked: the extension may have come up meanwhile
            const mode = hostMode({ enabled: this._enabled, appIndicator: appIndicatorEnabled(), otherOwner });
            this._switch(mode);
        });
    }

    _lookupOwner(done) {
        const cancellable = new Gio.Cancellable();
        const token = this._cleanup.add(() => cancellable.cancel());
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', new GLib.Variant('(s)', [WATCHER_NAME]), new GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                let owned = false;
                try {
                    [owned] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
                // After call_finish: a GTask reports CANCELLED once its cancellable is cancelled
                this._cleanup.release(token);
                done(owned);
            });
    }

    _switch(mode) {
        if (mode === this._mode)
            return;
        this._stopMode();
        this._mode = mode;
        this._run = new CleanupRegistry();
        if (mode === 'own')
            this._own(this._run);
        else if (mode === 'client')
            this._client(this._run);
        this._hooks.modeChanged();
    }

    _stopMode() {
        for (const address of [...this._items.keys()])
            this._remove(address);
        this._run?.dispose();
        this._run = null;
        this._mode = null;
    }

    // ---- items -----------------------------------------------------------------------------

    _add(address, bus, path) {
        if (this._items.has(address))
            return;
        const item = new SniItem({
            bus, path, gettext: this._ctx.gettext,
            onReady: it => {
                if (this._items.get(address) === it)
                    this._hooks.added(it);
            },
            onChanged: it => {
                if (this._items.get(address) === it)
                    this._hooks.changed(it);
            },
        });
        this._items.set(address, item);
        item.start();
    }

    _remove(address) {
        const item = this._items.get(address);
        if (!item)
            return;
        this._items.delete(address);
        if (item.button)
            this._hooks.removed(item);
        item.destroy();
    }

    // ---- own: Guava is the watcher -------------------------------------------------------------

    _own(run) {
        const watches = new Map();   // address -> bus watch id
        const unwatch = address => {
            const id = watches.get(address);
            if (id) {
                Gio.bus_unwatch_name(id);
                watches.delete(address);
            }
        };
        run.add(() => [...watches.keys()].forEach(unwatch));

        const impl = {
            RegisterStatusNotifierItemAsync: ([service], invocation) => {
                const sender = invocation.get_sender();
                const { bus, path } = parseItemAddress(service, sender);
                const address = itemAddress({ bus, path });
                if (!this._items.has(address)) {
                    this._add(address, bus, path);
                    watches.set(address, Gio.bus_watch_name_on_connection(Gio.DBus.session, bus,
                        Gio.BusNameWatcherFlags.NONE, null, () => {
                            unwatch(address);
                            this._remove(address);
                            exported.emit_signal('StatusNotifierItemUnregistered', new GLib.Variant('(s)', [address]));
                            exported.emit_property_changed('RegisteredStatusNotifierItems', this._registered());
                        }));
                    exported.emit_signal('StatusNotifierItemRegistered', new GLib.Variant('(s)', [address]));
                    exported.emit_property_changed('RegisteredStatusNotifierItems', this._registered());
                }
                invocation.return_value(null);
            },
            RegisterStatusNotifierHostAsync: (_params, invocation) => {
                invocation.return_value(null);
            },
            IsStatusNotifierHostRegistered: true,
            ProtocolVersion: 0,
        };
        // A live list, read by D-Bus property gets
        Object.defineProperty(impl, 'RegisteredStatusNotifierItems', { get: () => [...this._items.keys()] });
        const exported = Gio.DBusExportedObject.wrapJSObject(WATCHER_XML, impl);
        exported.export(Gio.DBus.session, WATCHER_PATH);
        run.add(() => exported.unexport());

        const ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session, WATCHER_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => exported.emit_signal('StatusNotifierHostRegistered', null),
            () => {
                // Someone else holds the name (or took it): join them as a host instead
                this._cleanup.idle(() => {
                    if (this._mode === 'own')
                        this._switch('client');
                }, { name: 'status items: watcher name lost' });
            });
        run.add(() => Gio.bus_unown_name(ownerId));
    }

    _registered() {
        return new GLib.Variant('as', [...this._items.keys()]);
    }

    // ---- client: another watcher ----------------------------------------------------------

    _client(run) {
        const hostName = `org.kde.StatusNotifierHost-${new Gio.Credentials().get_unix_pid()}-guava`;
        const hostId = Gio.bus_own_name_on_connection(Gio.DBus.session, hostName, Gio.BusNameOwnerFlags.NONE, null, null);
        run.add(() => Gio.bus_unown_name(hostId));
        const cancellable = new Gio.Cancellable();
        run.add(() => cancellable.cancel());

        const call = (method, params, type, done) => Gio.DBus.session.call(WATCHER_NAME, WATCHER_PATH,
            'org.kde.StatusNotifierWatcher', method, params, type ? new GLib.VariantType(type) : null,
            Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                try {
                    done?.(conn.call_finish(res));
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[Guava] status items: ${method} on the watcher failed: ${e.message}`);
                }
            });
        const add = address => {
            const slash = address.indexOf('/');
            const { bus, path } = slash > 0
                ? { bus: address.slice(0, slash), path: address.slice(slash) }
                : parseItemAddress(address, address);
            this._add(address, bus, path);
        };
        for (const [signal, fn] of [['StatusNotifierItemRegistered', add],
            ['StatusNotifierItemUnregistered', address => this._remove(address)]]) {
            const id = Gio.DBus.session.signal_subscribe(WATCHER_NAME, 'org.kde.StatusNotifierWatcher', signal,
                WATCHER_PATH, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => fn(params.deepUnpack()[0]));
            run.add(() => Gio.DBus.session.signal_unsubscribe(id));
        }
        call('RegisterStatusNotifierHost', new GLib.Variant('(s)', [hostName]), null, null);
        Gio.DBus.session.call(WATCHER_NAME, WATCHER_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                try {
                    const [list] = conn.call_finish(res).recursiveUnpack();
                    for (const address of list ?? [])
                        add(address);
                } catch (_e) {
                    // No items yet
                }
            });
        // The watcher went away: decide again (Guava may own the name now)
        const watch = Gio.bus_watch_name_on_connection(Gio.DBus.session, WATCHER_NAME, Gio.BusNameWatcherFlags.NONE,
            null, () => this._cleanup.idle(() => {
                if (this._mode === 'client') {
                    this._stopMode();
                    this.sync();
                }
            }, { name: 'status items: watcher gone' }));
        run.add(() => Gio.bus_unwatch_name(watch));
    }
}
