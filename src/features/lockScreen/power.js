// SPDX-License-Identifier: GPL-3.0-or-later
// Sleep, Restart and Shut Down for the lock screen's optional buttons: logind (the same service
// GDM's greeter uses), asked without interaction. A button shows only when logind answers "yes"
// (not "challenge": that would need an authentication prompt Guava must not add to the lock
// screen). Every call is async and cancelled with the feature.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS = 'org.freedesktop.login1';
const PATH = '/org/freedesktop/login1';
const IFACE = 'org.freedesktop.login1.Manager';
const METHOD = { suspend: 'Suspend', restart: 'Reboot', poweroff: 'PowerOff' };
const CAN = { suspend: 'CanSuspend', restart: 'CanReboot', poweroff: 'CanPowerOff' };

function call(method, args, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(BUS, PATH, IFACE, method, args, replyType,
            Gio.DBusCallFlags.NONE, 5000, cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export class Power {
    /** @param {Gio.Cancellable} cancellable cancelled when the feature stops */
    constructor(cancellable) {
        this._cancellable = cancellable;
    }

    /** @returns {Promise<{suspend: boolean, restart: boolean, poweroff: boolean}>} */
    async can() {
        const out = { suspend: false, restart: false, poweroff: false };
        await Promise.all(Object.keys(CAN).map(async id => {
            try {
                const reply = await call(CAN[id], null, GLib.VariantType.new('(s)'), this._cancellable);
                out[id] = reply.deepUnpack()[0] === 'yes';
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`[Guava] lock screen: ${CAN[id]} failed:`, e.message);
            }
        }));
        return out;
    }

    /** @param {string} id 'suspend' | 'restart' | 'poweroff' */
    async run(id) {
        if (!METHOD[id])
            return;
        try {
            await call(METHOD[id], new GLib.Variant('(b)', [false]), null, this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[Guava] lock screen: ${METHOD[id]} failed:`, e.message);
        }
    }
}
