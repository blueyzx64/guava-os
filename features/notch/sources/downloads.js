// SPDX-License-Identifier: GPL-3.0-or-later
// Download progress, from two places:
//   - app progress bars: com.canonical.Unity.LauncherEntry 'Update' signals (progress 0..1,
//     progress-visible), which browsers, installers and file copies send for their dock icon;
//   - partial files in the Downloads folder (.part, .crdownload, ...), whose size grows.
// A partial file renamed to its final name is a finished download: onFinished(uri) gets it
// (the shelf takes it when notch-shelf-downloads is on).
//
// Event driven: a directory monitor and a D-Bus signal. Only while a partial file exists,
// its size is re-read at most once a second (one async query per file).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { downloadSummary, PARTIAL_FILE } from '../model.js';

const SIZE_REFRESH_MS = 1000;

/**
 * @param {CleanupRegistry} cleanup
 * @param {{activity: Function}} sink
 * @param {(uri: string) => void} onFinished
 */
export function watchDownloads(cleanup, sink, onFinished) {
    const cancellable = new Gio.Cancellable();
    const apps = new Map();      // app uri -> progress
    const partials = new Map();  // name -> bytes
    let refresh = 0;
    let alive = true;

    const publish = () => {
        if (!alive)
            return;
        const s = downloadSummary(
            [...apps].map(([appId, progress]) => ({ appId: appId.replace(/^application:\/\//, '').replace(/\.desktop$/, ''), progress })),
            [...partials].map(([name, bytes]) => ({ name, bytes })));
        sink.activity('download', 'download', s);
    };

    // ---- LauncherEntry
    const bus = Gio.DBus.session;
    const sub = bus.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
        Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
            const [appUri, props] = params.deepUnpack();
            const get = k => (props[k] instanceof GLib.Variant ? props[k].deepUnpack() : props[k]);
            const visible = get('progress-visible');
            const progress = get('progress');
            if (visible === false)
                apps.delete(appUri);
            else if (Number.isFinite(progress))
                apps.set(appUri, Math.max(0, Math.min(1, progress)));
            else
                return;
            publish();
        });

    // ---- the Downloads folder
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    const dir = path && path !== GLib.get_home_dir() ? Gio.File.new_for_path(path) : null;

    const readSizes = () => {
        for (const name of partials.keys()) {
            dir.get_child(name).query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW, cancellable, (f, res) => {
                    try {
                        const size = f.query_info_finish(res).get_size();
                        if (partials.has(name) && partials.get(name) !== size) {
                            partials.set(name, size);
                            publish();
                        }
                    } catch (_e) {
                        // Gone between the event and the query; the monitor removes it.
                    }
                });
        }
    };
    const scheduleSizes = () => {
        if (refresh || !partials.size)
            return;
        refresh = cleanup.timeout(SIZE_REFRESH_MS, () => {
            refresh = 0;
            readSizes();
            scheduleSizes();
            return GLib.SOURCE_REMOVE;
        }, { name: 'notch download sizes' });
    };

    if (dir) {
        let monitor = null;
        try {
            monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, cancellable);
        } catch (e) {
            console.warn(`[Guava] notch: cannot watch Downloads: ${e.message}`);
        }
        if (monitor) {
            cleanup.connect(monitor, 'changed', (_m, file, other, type) => {
                const name = file.get_basename();
                const E = Gio.FileMonitorEvent;
                if (type === E.RENAMED || type === E.MOVED_OUT || type === E.DELETED) {
                    const was = partials.delete(name);
                    if (type === E.RENAMED && other) {
                        const to = other.get_basename();
                        if (PARTIAL_FILE.test(to))
                            partials.set(to, partials.get(to) ?? 0);
                        else if (was)
                            onFinished(other.get_uri());
                    }
                    publish();
                } else if ((type === E.CREATED || type === E.MOVED_IN) && PARTIAL_FILE.test(name)) {
                    partials.set(name, 0);
                    publish();
                    scheduleSizes();
                }
                if (type === E.RENAMED && other && PARTIAL_FILE.test(other.get_basename()))
                    scheduleSizes();
            });
            cleanup.add(() => monitor.cancel());
        }
        // Partial files already there (a download running across a lock)
        dir.enumerate_children_async('standard::name,standard::size', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable, (d, res) => {
                let en;
                try {
                    en = d.enumerate_children_finish(res);
                } catch (_e) {
                    return;
                }
                en.next_files_async(200, GLib.PRIORITY_LOW, cancellable, (e2, r2) => {
                    try {
                        for (const info of e2.next_files_finish(r2)) {
                            if (PARTIAL_FILE.test(info.get_name()))
                                partials.set(info.get_name(), info.get_size());
                        }
                    } catch (_e) {
                        return;
                    } finally {
                        e2.close_async(GLib.PRIORITY_LOW, null, null);
                    }
                    publish();
                    scheduleSizes();
                });
            });
    }

    cleanup.add(() => {
        alive = false;
        cancellable.cancel();
        bus.signal_unsubscribe(sub);
        sink.activity('download', 'download', null);
    });
}
