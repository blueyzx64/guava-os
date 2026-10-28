// SPDX-License-Identifier: GPL-3.0-or-later
// "Other Location…": asks for a folder through the desktop portal's file chooser
// (org.freedesktop.portal.FileChooser OpenFile with directory=true), since the Shell has no
// GTK. The answer comes as a Response signal on the request object the call returns.
//
// pickFolder() resolves with the folder path, or null when the user cancelled or the portal
// is not there. Cancelling `cancellable` (feature disable) closes the request.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS = 'org.freedesktop.portal.Desktop';
const PATH = '/org/freedesktop/portal/desktop';
let serial = 0;

/**
 * @param {string} title dialog title
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<?string>}
 */
export function pickFolder(title, cancellable) {
    const bus = Gio.DBus.session;
    const token = `guava_folder_${++serial}`;
    const sender = bus.get_unique_name().slice(1).replace(/\./g, '_');
    const requestPath = `${PATH}/request/${sender}/${token}`;

    return new Promise(resolve => {
        let subscription = 0;
        let cancelId = 0;
        const done = path => {
            if (subscription)
                bus.signal_unsubscribe(subscription);
            subscription = 0;
            if (cancelId)
                cancellable.disconnect(cancelId);
            cancelId = 0;
            resolve(path);
        };
        // Subscribed before the call so a fast answer is not missed
        subscription = bus.signal_subscribe(BUS, 'org.freedesktop.portal.Request', 'Response',
            requestPath, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [response, results] = params.deepUnpack();
                const uri = response === 0 ? results.uris?.deepUnpack?.()[0] : null;
                done(uri ? Gio.File.new_for_uri(uri).get_path() : null);
            });
        cancelId = cancellable.connect(() => {
            bus.call(BUS, requestPath, 'org.freedesktop.portal.Request', 'Close', null, null,
                Gio.DBusCallFlags.NONE, -1, null, null);
            done(null);
        });
        const options = {
            handle_token: new GLib.Variant('s', token),
            directory: new GLib.Variant('b', true),
            modal: new GLib.Variant('b', true),
        };
        bus.call(BUS, PATH, 'org.freedesktop.portal.FileChooser', 'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', title, options]), new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[Guava] folder chooser unavailable: ${e.message}`);
                    done(null);
                }
            });
    });
}
