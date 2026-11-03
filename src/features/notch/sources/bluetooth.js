// SPDX-License-Identifier: GPL-3.0-or-later
// Bluetooth headphones from BlueZ: "connected" with the battery level when one connects (an
// alert), and a quiet row per connected audio device in the Now tab. Reads the object manager
// once, then follows InterfacesAdded/Removed and PropertiesChanged; nothing is polled.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { connectedHeadphones, newlyConnected } from '../model.js';

const BUS = 'org.bluez';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';

const unpackProps = v => {
    const out = {};
    for (const [k, val] of Object.entries(v ?? {}))
        out[k] = val instanceof GLib.Variant ? val.deepUnpack() : val;
    return out;
};

/**
 * @param {CleanupRegistry} cleanup
 * @param {{activity: Function}} sink
 */
export function watchBluetooth(cleanup, sink) {
    const bus = Gio.DBus.system;
    const cancellable = new Gio.Cancellable();
    const devices = new Map(); // path -> {path, name, icon, connected, battery}
    let shown = [];            // connected headphones last published
    let loaded = false;
    let alive = true;

    const publish = () => {
        if (!alive || !loaded)
            return;
        const now = connectedHeadphones([...devices.values()]);
        for (const d of shown) {
            if (!now.some(n => n.path === d.path))
                sink.activity(`bt:${d.path}`, 'headphones', null);
        }
        for (const d of now)
            sink.activity(`bt:${d.path}`, 'headphones', { name: d.name, battery: d.battery });
        const fresh = newlyConnected(shown, now);
        if (fresh.length) {
            const d = fresh[fresh.length - 1];
            sink.activity('bt-alert', 'headphones-connected', { name: d.name, battery: d.battery }, { fresh: true });
        }
        shown = now;
    };

    const merge = (path, iface, props) => {
        const d = devices.get(path) ?? { path, name: '', icon: '', connected: false, battery: null };
        if (iface === DEVICE) {
            if ('Alias' in props || 'Name' in props)
                d.name = props.Alias ?? props.Name ?? d.name;
            if ('Icon' in props)
                d.icon = props.Icon;
            if ('Connected' in props)
                d.connected = !!props.Connected;
        } else if (iface === BATTERY && 'Percentage' in props) {
            d.battery = Number(props.Percentage);
        }
        devices.set(path, d);
    };

    const add = (path, ifaces) => {
        for (const [iface, props] of Object.entries(ifaces)) {
            if (iface === DEVICE || iface === BATTERY)
                merge(path, iface, unpackProps(props));
        }
    };

    const subs = [
        bus.signal_subscribe(BUS, 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', null, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [path, ifaces] = params.deepUnpack();
                add(path, ifaces);
                publish();
            }),
        bus.signal_subscribe(BUS, 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', null, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [path, ifaces] = params.deepUnpack();
                if (ifaces.includes(DEVICE))
                    devices.delete(path);
                publish();
            }),
        bus.signal_subscribe(BUS, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _n, params) => {
                const [iface, changed] = params.deepUnpack();
                if (iface !== DEVICE && iface !== BATTERY)
                    return;
                merge(path, iface, unpackProps(changed));
                publish();
            }),
    ];
    cleanup.add(() => {
        alive = false;
        cancellable.cancel();
        subs.forEach(id => bus.signal_unsubscribe(id));
        for (const d of shown)
            sink.activity(`bt:${d.path}`, 'headphones', null);
        shown = [];
    });

    bus.call(BUS, '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null, null,
        Gio.DBusCallFlags.NO_AUTO_START, -1, cancellable, (_c, res) => {
            try {
                const [objects] = bus.call_finish(res).deepUnpack();
                for (const [path, ifaces] of Object.entries(objects))
                    add(path, ifaces);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) && alive)
                    console.warn(`[Guava] notch: no BlueZ: ${e.message}`);
                if (!alive)
                    return;
            }
            // What is connected at start is not news: no alert for it
            loaded = true;
            shown = connectedHeadphones([...devices.values()]);
            for (const d of shown)
                sink.activity(`bt:${d.path}`, 'headphones', { name: d.name, battery: d.battery });
        });
}
