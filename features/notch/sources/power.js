// SPDX-License-Identifier: GPL-3.0-or-later
// Live activities from the battery (UPower's display device, the same one the Shell's battery
// indicator reads): "Charging" when a charger is plugged in, "Low Battery" when the level
// crosses 20 % and 10 %, and the quiet "charging" row in the Now tab while it charges.
// Signal driven (g-properties-changed); nothing is polled.

import Gio from 'gi://Gio';

import { batteryChange } from '../model.js';

const BUS = 'org.freedesktop.UPower';
const PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const IFACE = 'org.freedesktop.UPower.Device';

/**
 * @param {CleanupRegistry} cleanup
 * @param {{activity: (key: string, kind: string, data: object|null, opts?: object) => void}} sink
 */
export function watchPower(cleanup, sink) {
    const cancellable = new Gio.Cancellable();
    let alive = true;
    let before = null;
    cleanup.add(() => {
        alive = false;
        cancellable.cancel();
    });

    const read = proxy => {
        const get = name => proxy.get_cached_property(name)?.unpack() ?? null;
        const now = {
            present: !!get('IsPresent'),
            state: get('State') ?? 0,
            percentage: get('Percentage') ?? 0,
        };
        const change = batteryChange(now, before);
        before = now.present ? now : null;
        if (!change) {
            sink.activity('battery', 'charging', null);
            return;
        }
        sink.activity('battery', 'charging', change.charging ? { percent: change.percent } : null);
        if (change.pluggedIn)
            sink.activity('battery-alert', 'charging-started', { percent: change.percent }, { fresh: true });
        else if (change.low)
            sink.activity('battery-alert', 'low-battery', { percent: change.percent }, { fresh: true });
    };

    Gio.DBusProxy.new(Gio.DBus.system, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, BUS, PATH, IFACE,
        cancellable, (_o, res) => {
            let proxy;
            try {
                proxy = Gio.DBusProxy.new_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`[Guava] notch: no UPower: ${e.message}`);
                return;
            }
            if (!alive)
                return;
            cleanup.connect(proxy, 'g-properties-changed', () => read(proxy));
            cleanup.add(() => sink.activity('battery', 'charging', null));
            read(proxy);
        });
}
