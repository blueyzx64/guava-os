// SPDX-License-Identifier: GPL-3.0-or-later
// Battery data from UPower: the computer's battery and every device UPower knows a charge of,
// which includes Bluetooth mice, keyboards and headsets (UPower reads BlueZ's Battery1).
// Everything is async and event-driven: EnumerateDevices once, then DeviceAdded/Removed and
// each device's PropertiesChanged. No polling.
//
// D-Bus: org.freedesktop.UPower (system bus), interfaces org.freedesktop.UPower and
// org.freedesktop.UPower.Device.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Provider } from './base.js';

const BUS = 'org.freedesktop.UPower';
const PATH = '/org/freedesktop/UPower';
const DEVICE = 'org.freedesktop.UPower.Device';

export class BatteriesProvider extends Provider {
    initial() {
        return { devices: [] };
    }

    run(cleanup) {
        const cancel = new Gio.Cancellable();
        cleanup.add(() => cancel.cancel());
        this._cancel = cancel;
        this._devices = new Map(); // path -> {proxy, id}
        cleanup.add(() => {
            for (const { proxy, id } of this._devices.values())
                proxy.disconnect(id);
            this._devices.clear();
        });
        const bus = Gio.DBus.system;
        for (const [signal, fn] of [['DeviceAdded', p => this._add(p)], ['DeviceRemoved', p => this._remove(p)]]) {
            const sub = bus.signal_subscribe(BUS, BUS, signal, PATH, null, Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _n, params) => fn(params.deepUnpack()[0]));
            cleanup.add(() => bus.signal_unsubscribe(sub));
        }
        bus.call(BUS, PATH, BUS, 'EnumerateDevices', null, new GLib.VariantType('(ao)'),
            Gio.DBusCallFlags.NONE, -1, cancel, (conn, res) => {
                let paths = [];
                try {
                    paths = conn.call_finish(res).deepUnpack()[0];
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._read();
                    return;
                }
                for (const p of paths)
                    this._add(p);
                this._read();
            });
    }

    _add(path) {
        if (!this.running || this._devices.has(path))
            return;
        const cancel = this._cancel;
        Gio.DBusProxy.new(Gio.DBus.system, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, null, BUS, path, DEVICE,
            cancel, (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(res);
                } catch (_e) {
                    return; // cancelled, or the device went away meanwhile
                }
                if (cancel.is_cancelled() || this._devices.has(path))
                    return;
                const id = proxy.connect('g-properties-changed', () => this._read());
                this._devices.set(path, { proxy, id });
                this._read();
            });
    }

    _remove(path) {
        const rec = this._devices?.get(path);
        if (!rec)
            return;
        rec.proxy.disconnect(rec.id);
        this._devices.delete(path);
        this._read();
    }

    _read() {
        const prop = (p, name) => p.get_cached_property(name)?.deepUnpack();
        const devices = [...this._devices.entries()].map(([path, { proxy }]) => ({
            path,
            type: prop(proxy, 'Type'),
            percentage: prop(proxy, 'Percentage'),
            state: prop(proxy, 'State'),
            model: prop(proxy, 'Model') || prop(proxy, 'Vendor') || '',
            powerSupply: prop(proxy, 'PowerSupply'),
            isPresent: prop(proxy, 'IsPresent'),
        }));
        this.publish({ devices });
    }
}
