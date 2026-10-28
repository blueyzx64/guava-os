// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Look: GNOME's previewer, Sushi (org.gnome.NautilusPreviewer2), the window Files opens
// on Space. It is D-Bus activated; when it is not installed, Space just types a space.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS = 'org.gnome.NautilusPreviewer';
const PATH = '/org/gnome/NautilusPreviewer';
const IFACE = 'org.gnome.NautilusPreviewer2';
const TIMEOUT_MS = 3000;

export class QuickLook {
    constructor() {
        this._available = null;
    }

    /** Ask the bus again on the next check (Spotlight opened: sushi may have been installed). */
    reset() {
        this._available = null;
    }

    /** @returns {?boolean} the last answer of check(), null before it */
    get available() {
        return this._available;
    }

    /** Is Sushi installed (activatable) or running? */
    check(cancellable) {
        if (this._available !== null)
            return Promise.resolve(this._available);
        return new Promise(resolve => {
            Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'ListActivatableNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE,
                TIMEOUT_MS, cancellable, (conn, res) => {
                    try {
                        const [names] = conn.call_finish(res).deepUnpack();
                        this._available = names.includes(BUS);
                    } catch (e) {
                        this._available = false;
                    }
                    resolve(this._available);
                });
        });
    }

    /** Preview one file:// URI. */
    show(uri) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(BUS, PATH, IFACE, 'ShowFile',
                new GLib.Variant('(ssbs)', [uri, '', false, '']), null, Gio.DBusCallFlags.NONE,
                TIMEOUT_MS, null, (conn, res) => {
                    try {
                        conn.call_finish(res);
                        resolve(true);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
