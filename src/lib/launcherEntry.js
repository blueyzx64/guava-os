// SPDX-License-Identifier: GPL-3.0-or-later
// LauncherEntry watcher: listens to com.canonical.Unity.LauncherEntry Update signals on the
// session bus (the de facto badge/progress API apps such as Thunderbird, Telegram and
// Electron apps use, and the one Dash to Dock honours) and keeps lib/launcherEntryModel.js
// current. Entries go when their sender leaves the bus.
//
//   const badges = new LauncherEntryWatcher(cleanup, appId => redraw(appId));
//   badges.get(appId);   // {count, countVisible, progress, progressVisible, urgent} or null
//
// No sync IO: a signal subscription and name watches only.

import Gio from 'gi://Gio';

import { LauncherEntries } from './launcherEntryModel.js';

const IFACE = 'com.canonical.Unity.LauncherEntry';

export class LauncherEntryWatcher {
    /**
     * @param {import('./disposables.js').CleanupRegistry} cleanup
     * @param {(appId: string) => void} onChange an app's entry changed or went away
     */
    constructor(cleanup, onChange) {
        this._entries = new LauncherEntries();
        this._onChange = onChange;
        this._watches = new Map();   // sender -> watch id
        const bus = Gio.DBus.session;
        const sub = bus.signal_subscribe(null, IFACE, 'Update', null, null, Gio.DBusSignalFlags.NONE,
            (_conn, sender, _path, _iface, _signal, params) => this._update(sender, params));
        cleanup.add(() => {
            bus.signal_unsubscribe(sub);
            for (const id of this._watches.values())
                Gio.bus_unwatch_name(id);
            this._watches.clear();
            this._entries.clear();
        });
    }

    get(appId) {
        return this._entries.get(appId);
    }

    _update(sender, params) {
        let uri, props;
        try {
            [uri, props] = params.recursiveUnpack();
        } catch (e) {
            console.warn('[Guava] LauncherEntry: bad Update:', e.message);
            return;
        }
        const appId = this._entries.update(sender, uri, props);
        if (!appId)
            return;
        if (sender && !this._watches.has(sender)) {
            this._watches.set(sender, Gio.bus_watch_name_on_connection(Gio.DBus.session, sender,
                Gio.BusNameWatcherFlags.NONE, null, () => this._gone(sender)));
        }
        this._onChange(appId);
    }

    _gone(sender) {
        const id = this._watches.get(sender);
        if (id) {
            Gio.bus_unwatch_name(id);
            this._watches.delete(sender);
        }
        for (const appId of this._entries.senderGone(sender))
            this._onChange(appId);
    }
}
