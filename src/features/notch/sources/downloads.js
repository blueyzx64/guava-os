// SPDX-License-Identifier: GPL-3.0-or-later
// Download progress, from two places:
//   - app progress bars: com.canonical.Unity.LauncherEntry 'Update' signals (progress 0..1,
//     progress-visible), which browsers, installers and file copies send for their dock icon;
//   - partial files in the Downloads folder (.part, .crdownload, ...), whose size grows.
// A partial file renamed to its final name is a finished download: onFinished(uri) gets it
// (the shelf takes it when notch-shelf-downloads is on).
//
// What shows and when it goes is decided by ../downloadsModel.js (DownloadTracker): a bar
// goes with the bus name that sent it, and anything that stops moving for STALE_MS goes
// dormant, so a cancelled or interrupted download never lingers (B8).
//
// Event driven: a directory monitor, a D-Bus signal and one name watch per sender. Only while
// a live partial file exists, its size is re-read at most once a second (one async query per
// file); one timeout runs the next expiry.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { PARTIAL_FILE } from '../model.js';
import { DownloadTracker } from '../downloadsModel.js';

const SIZE_REFRESH_MS = 1000;
const ENUMERATE_BATCH = 200;

const nowMs = () => Math.floor(GLib.get_monotonic_time() / 1000);

/**
 * @param {CleanupRegistry} cleanup
 * @param {{activity: Function}} sink
 * @param {(uri: string) => void} onFinished
 */
export function watchDownloads(cleanup, sink, onFinished) {
    const cancellable = new Gio.Cancellable();
    const tracker = new DownloadTracker();
    const watches = new Map();   // sender -> name watch id
    let refresh = 0;
    let expiry = 0;
    let alive = true;

    const scheduleExpiry = () => {
        if (expiry)
            cleanup.release(expiry);
        expiry = 0;
        const at = tracker.nextExpiry();
        if (at === null)
            return;
        expiry = cleanup.timeout(Math.max(1, at - nowMs()), () => {
            expiry = 0;
            if (tracker.prune(nowMs()))
                publish();
            else
                scheduleExpiry();
            return GLib.SOURCE_REMOVE;
        }, { name: 'notch download expiry' });
    };

    const publish = () => {
        if (!alive)
            return;
        sink.activity('download', 'download', tracker.summary());
        scheduleExpiry();
    };

    // ---- LauncherEntry
    const unwatch = sender => {
        const id = watches.get(sender);
        if (id) {
            Gio.bus_unwatch_name(id);
            watches.delete(sender);
        }
    };
    const watchSenders = () => {
        const held = new Set(tracker.senders());
        for (const sender of [...watches.keys()]) {
            if (!held.has(sender))
                unwatch(sender);
        }
        for (const sender of held) {
            if (watches.has(sender))
                continue;
            // Called at once if the name is already gone
            watches.set(sender, Gio.bus_watch_name_on_connection(bus, sender, Gio.BusNameWatcherFlags.NONE,
                null, () => {
                    unwatch(sender);
                    if (tracker.senderGone(sender))
                        publish();
                }));
        }
    };
    const bus = Gio.DBus.session;
    const sub = bus.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
        Gio.DBusSignalFlags.NONE, (_c, sender, _p, _i, _n, params) => {
            let uri, props;
            try {
                [uri, props] = params.recursiveUnpack();
            } catch (e) {
                console.warn('[Guava] notch downloads: bad LauncherEntry Update:', e.message);
                return;
            }
            const changed = tracker.appUpdate(sender, uri, props, nowMs());
            watchSenders();
            if (changed)
                publish();
        });

    // ---- the Downloads folder
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    const dir = path && path !== GLib.get_home_dir() ? Gio.File.new_for_path(path) : null;

    const readSizes = () => {
        for (const name of tracker.livePartials()) {
            dir.get_child(name).query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW, cancellable, (f, res) => {
                    try {
                        if (tracker.partialSize(name, f.query_info_finish(res).get_size(), nowMs()))
                            publish();
                    } catch (_e) {
                        // Gone between the event and the query; the monitor removes it.
                    }
                });
        }
    };
    const scheduleSizes = () => {
        if (refresh || !tracker.livePartials().length)
            return;
        refresh = cleanup.timeout(SIZE_REFRESH_MS, () => {
            refresh = 0;
            readSizes();
            scheduleSizes();
            return GLib.SOURCE_REMOVE;
        }, { name: 'notch download sizes' });
    };
    const seen = (name, bytes, ageMs = 0) => {
        if (tracker.partialSeen(name, bytes, nowMs(), ageMs))
            publish();
        scheduleSizes();
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
                    const was = tracker.partialGone(name);
                    const to = type === E.RENAMED && other ? other.get_basename() : null;
                    if (to && PARTIAL_FILE.test(to))
                        seen(to, undefined);
                    else if (to && was && PARTIAL_FILE.test(name))
                        onFinished(other.get_uri());
                    if (was)
                        publish();
                } else if ((type === E.CREATED || type === E.MOVED_IN) && PARTIAL_FILE.test(name)) {
                    seen(name, 0);
                } else if (type === E.CHANGED && PARTIAL_FILE.test(name)) {
                    // Written to: alive (a paused download resumed brings a dormant one back)
                    seen(name, undefined);
                }
            });
            cleanup.add(() => monitor.cancel());
        }
        // Partial files already there (a download running across a lock). One left behind by
        // an interrupted download is older than the expiry and starts dormant.
        dir.enumerate_children_async('standard::name,standard::size,time::modified', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable, (d, res) => {
                let en;
                try {
                    en = d.enumerate_children_finish(res);
                } catch (_e) {
                    return;
                }
                const wallNow = GLib.get_real_time() / 1000;
                const next = () => en.next_files_async(ENUMERATE_BATCH, GLib.PRIORITY_LOW, cancellable, (e2, r2) => {
                    let infos;
                    try {
                        infos = e2.next_files_finish(r2);
                    } catch (_e) {
                        infos = [];
                    }
                    for (const info of infos) {
                        const name = info.get_name();
                        if (!PARTIAL_FILE.test(name))
                            continue;
                        const mtime = info.get_modification_date_time()?.to_unix() ?? null;
                        const age = mtime === null ? 0 : Math.max(0, wallNow - mtime * 1000);
                        if (tracker.partialSeen(name, info.get_size(), nowMs(), age))
                            publish();
                    }
                    if (infos.length && alive) {
                        next();
                        return;
                    }
                    e2.close_async(GLib.PRIORITY_LOW, null, null);
                    scheduleSizes();
                });
                next();
            });
    }

    cleanup.add(() => {
        alive = false;
        cancellable.cancel();
        bus.signal_unsubscribe(sub);
        for (const id of watches.values())
            Gio.bus_unwatch_name(id);
        watches.clear();
        tracker.clear();
        sink.activity('download', 'download', null);
    });
}
