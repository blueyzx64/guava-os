// SPDX-License-Identifier: GPL-3.0-or-later
// Low Power Mode (macOS Monterey): "On battery" and "On power
// adapter" are separate choices (low-power-battery, low-power-adapter). While the one of the
// power source in use is on, Guava holds power-profiles-daemon's power-saver profile
// (HoldProfile); the hold is released when it no longer applies and on disable, so GNOME's own
// profile comes back. Choosing a profile by hand in GNOME's Power Mode menu makes the daemon
// drop the hold (ProfileReleased): Guava then leaves the user's choice alone until the power
// source or a Low Power Mode choice changes.
//
// It also reads the battery's health from UPower (Capacity, ChargeCycles) for the Battery
// item of the menu bar. Others reach it with ctx.features.instance('low-power') and the
// 'low-power-changed' event: `active`, `onBattery`, `hasBattery`, `available`, `health`,
// `toggle()`.
//
// D-Bus: org.freedesktop.UPower.PowerProfiles (power-profiles-daemon >= 0.20), else the older
// net.hadess.PowerProfiles; org.freedesktop.UPower (OnBattery, EnumerateDevices). No daemon:
// `available` is false and nothing is held.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { GuavaSettings } from '../../lib/settings.js';
import { PROFILE, batteryHealth, holdAction, lowPowerToggle, lowPowerWanted } from './model.js';

const PPD = [
    { name: 'org.freedesktop.UPower.PowerProfiles', path: '/org/freedesktop/UPower/PowerProfiles' },
    { name: 'net.hadess.PowerProfiles', path: '/net/hadess/PowerProfiles' },
];
const UPOWER = { name: 'org.freedesktop.UPower', path: '/org/freedesktop/UPower' };
const DEVICE_IFACE = 'org.freedesktop.UPower.Device';
const BATTERY_TYPE = 2;
const APP_ID = 'org.gnome.Shell.Extensions.Guava';

export class LowPower {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._cancellable = null;
        this._ppd = null;            // {name, path, iface} of the daemon found
        this._upower = null;         // Gio.DBusProxy of UPower
        this._battery = null;        // Gio.DBusProxy of the first battery device
        this._cookie = 0;
        this._pending = false;       // a HoldProfile call is in flight
        this._userOverride = false;  // the user picked a profile while Guava held one
        this._active = false;
    }

    /** Low Power Mode applies now (a hold is held or being requested). */
    get active() {
        return this._active;
    }

    get available() {
        return !!this._ppd;
    }

    get onBattery() {
        return !!this._upower?.get_cached_property('OnBattery')?.unpack();
    }

    get hasBattery() {
        return !!this._battery;
    }

    /** {percent, cycles, condition} or null (see model.js batteryHealth) */
    get health() {
        const read = (name, fallback) => this._battery?.get_cached_property(name)?.unpack() ?? fallback;
        if (!this._battery)
            return null;
        return batteryHealth({
            capacity: read('Capacity', 0),
            energyFull: read('EnergyFull', 0),
            energyFullDesign: read('EnergyFullDesign', 0),
            cycles: read('ChargeCycles', -1),
        });
    }

    /** The choice of the power source in use, flipped (the Control Center switch). */
    toggle() {
        const { key, value } = lowPowerToggle(this._state());
        this._ks.setBool(key, value);
    }

    enable() {
        const cleanup = this._cleanup;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._cancellable = new Gio.Cancellable();
        cleanup.add(() => {
            this._cancellable.cancel();
            this._release();
            this._upower = this._battery = null;
        });
        this._ks.watch(['low-power-battery', 'low-power-adapter'], () => {
            this._userOverride = false;
            this._sync();
        });
        this._findDaemon(0);
        this._connectUPower();
    }

    disable() {
        // The cleanup registry releases the hold and cancels pending calls
    }

    _state() {
        return {
            onBattery: this.onBattery,
            hasBattery: this.hasBattery || this.onBattery,
            battery: this._ks.bool('low-power-battery'),
            adapter: this._ks.bool('low-power-adapter'),
        };
    }

    _findDaemon(index) {
        const ppd = PPD[index];
        if (!ppd)
            return;
        Gio.DBus.system.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', new GLib.Variant('(s)', [ppd.name]), new GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                let owned = false;
                try {
                    [owned] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
                if (!owned) {
                    this._findDaemon(index + 1);
                    return;
                }
                this._ppd = { ...ppd, iface: ppd.name };
                // The daemon drops our hold when the user picks a profile by hand
                const id = Gio.DBus.system.signal_subscribe(ppd.name, ppd.name, 'ProfileReleased',
                    ppd.path, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                        const [cookie] = params.deepUnpack();
                        if (cookie !== this._cookie)
                            return;
                        this._cookie = 0;
                        this._userOverride = true;
                        this._setActive(false);
                    });
                this._cleanup.add(() => Gio.DBus.system.signal_unsubscribe(id));
                this._sync();
                this._emit();
            });
    }

    _connectUPower() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            UPOWER.name, UPOWER.path, UPOWER.name, this._cancellable, (_o, res) => {
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[Guava] Low Power Mode: no UPower: ${e.message}`);
                    return;
                }
                this._cleanup.connect(this._upower, 'g-properties-changed', (_p, changed) => {
                    if (changed.lookup_value('OnBattery', null)) {
                        this._userOverride = false;
                        this._sync();
                        this._emit();
                    }
                });
                this._findBattery();
                this._sync();
            });
    }

    _findBattery() {
        this._upower.call('EnumerateDevices', null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (proxy, res) => {
            let paths = [];
            try {
                [paths] = proxy.call_finish(res).deepUnpack();
            } catch (_e) {
                return;
            }
            this._tryBattery(paths, 0);
        });
    }

    _tryBattery(paths, i) {
        if (i >= paths.length)
            return;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            UPOWER.name, paths[i], DEVICE_IFACE, this._cancellable, (_o, res) => {
                let proxy = null;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (_e) {
                    return;
                }
                const type = proxy.get_cached_property('Type')?.unpack();
                const supply = proxy.get_cached_property('PowerSupply')?.unpack();
                if (type === BATTERY_TYPE && supply !== false) {
                    this._battery = proxy;
                    this._emit();
                    this._sync();
                } else {
                    this._tryBattery(paths, i + 1);
                }
            });
    }

    _sync() {
        if (!this._ppd)
            return;
        const wanted = lowPowerWanted(this._state()) && !this._userOverride;
        const action = holdAction(wanted, !!this._cookie || this._pending);
        if (action === 'hold')
            this._hold();
        else if (action === 'release')
            this._release();
    }

    _hold() {
        const { name, path, iface } = this._ppd;
        this._pending = true;
        this._setActive(true);
        Gio.DBus.system.call(name, path, iface, 'HoldProfile',
            new GLib.Variant('(sss)', [PROFILE, 'Low Power Mode (Guava)', APP_ID]),
            // Not cancellable: a hold granted after Guava stopped must still be given back
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                this._pending = false;
                try {
                    [this._cookie] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    console.warn(`[Guava] Low Power Mode: HoldProfile failed: ${e.message}`);
                    this._setActive(false);
                    return;
                }
                // Stopped, or no longer wanted, while the call was in flight
                if (this._cancellable.is_cancelled() || !(lowPowerWanted(this._state()) && !this._userOverride))
                    this._release();
            });
    }

    _release() {
        const cookie = this._cookie;
        this._cookie = 0;
        this._setActive(this._pending);
        if (!cookie || !this._ppd)
            return;
        const { name, path, iface } = this._ppd;
        // Not cancellable: the hold must go even while Guava stops
        Gio.DBus.system.call(name, path, iface, 'ReleaseProfile', new GLib.Variant('(u)', [cookie]),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_e) {
                    // The daemon dropped it already (it restarted, or the user chose a profile)
                }
            });
    }

    _setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._emit();
    }

    _emit() {
        if (this._cancellable?.is_cancelled())
            return;
        this._ctx.events.emit('low-power-changed', { active: this._active });
    }
}
