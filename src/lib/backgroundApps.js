// SPDX-License-Identifier: GPL-3.0-or-later
// Background apps: follows org.freedesktop.background.Monitor (the Background portal's list,
// the same data GNOME's Quick Settings "Background Apps" show) and stops one the way the Shell
// does: the app's own "quit" action over org.gtk.Actions, else Shell.App.request_quit().
//
//   const bg = new BackgroundApps(cleanup, ids => ...);   // ids: desktop ids
//   bg.ids;                                                 // the current list
//   bg.stop(app);
//
// Async proxy only (no sync IO); the property may be missing when no portal runs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { backgroundAppIds, gApplicationPath } from './backgroundAppsModel.js';

const NAME = 'org.freedesktop.background.Monitor';
const PATH = '/org/freedesktop/background/monitor';
const IFACE = `<node><interface name="${NAME}">
  <property name="BackgroundApps" type="aa{sv}" access="read"/>
</interface></node>`;
const Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE);

export class BackgroundApps {
    /**
     * @param {import('./disposables.js').CleanupRegistry} cleanup
     * @param {(ids: string[]) => void} onChange
     */
    constructor(cleanup, onChange) {
        this.ids = [];
        this._onChange = onChange;
        const cancellable = new Gio.Cancellable();
        cleanup.add(() => cancellable.cancel());
        this._proxy = null;
        Proxy(Gio.DBus.session, NAME, PATH, (proxy, error) => {
            if (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn('[Guava] background apps:', error.message);
                return;
            }
            this._proxy = proxy;
            cleanup.connect(proxy, 'g-properties-changed', () => this._sync());
            // The portal may start after the Shell
            cleanup.connect(proxy, 'notify::g-name-owner', () => this._sync());
            this._sync();
        }, cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
    }

    _sync() {
        const value = this._proxy?.get_cached_property('BackgroundApps');
        const ids = backgroundAppIds(this._proxy?.g_name_owner && value ? value.recursiveUnpack() : []);
        if (ids.join('\n') === this.ids.join('\n'))
            return;
        this.ids = ids;
        this._onChange(ids);
    }

    /** Stop a background app ("Stop Running in Background"). */
    stop(app) {
        const { name, path } = gApplicationPath(app.get_id());
        Gio.DBus.session.call(name, path, 'org.gtk.Actions', 'Activate',
            new GLib.Variant('(sava{sv})', ['quit', [], {}]), null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_e) {
                    // No GApplication quit action: ask the app to quit
                    app.request_quit();
                }
            });
    }
}
