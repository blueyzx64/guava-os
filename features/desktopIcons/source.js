// SPDX-License-Identifier: GPL-3.0-or-later
// Where the desktop icons come from: the files and folders of ~/Desktop (async Gio, one
// Gio.FileMonitor, debounced) and, when asked, the mounted drives. Nothing here writes.
//
// An entry is the model's entry (model.js) plus what the view and the actions need:
//   uri, file (Gio.File), gicon (Gio.Icon), thumbnail (path of a cached preview or null),
//   mount (Gio.Mount, drives only), launcher (a Gio.DesktopAppInfo, .desktop files only)
//
// Thumbnails are GNOME's own: the cache that Files fills (the `thumbnail::path` attribute). A file
// with none is handed to GNOME's thumbnailer (GnomeDesktop.DesktopThumbnailFactory), a few at a
// time, and its preview appears when it is ready.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

import { DRIVE_PREFIX, RELOAD_DEBOUNCE_MS, showsAsDrive } from './model.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype, 'generate_thumbnail_async', 'generate_thumbnail_finish');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype, 'save_thumbnail_async', 'save_thumbnail_finish');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype, 'create_failed_thumbnail_async', 'create_failed_thumbnail_finish');

const ATTRIBUTES = [
    'standard::name', 'standard::display-name', 'standard::type', 'standard::content-type',
    'standard::icon', 'standard::size', 'standard::is-hidden', 'standard::is-backup',
    'time::modified', 'time::created', 'time::changed', 'access::can-execute',
    'thumbnail::path', 'thumbnail::is-valid', 'thumbnail::failed',
].join(',');
const BATCH = 100;
/** Thumbnails generated at the same time. */
const THUMBNAIL_JOBS = 2;
const DESKTOP_ENTRY = 'application/x-desktop';

/** The folder the desktop shows, or null when there is none (the home folder is not a desktop). */
export function desktopFolder() {
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
    if (!path || path === GLib.get_home_dir())
        return null;
    return Gio.File.new_for_path(path);
}

export class DesktopSource {
    /**
     * @param {{add: Function, timeout: Function}} cleanup
     * @param {(entries: object[]) => void} onChange the entries, after every (debounced) change
     * @param {(entry: object) => void} onThumbnail an entry's preview became available
     */
    constructor(cleanup, onChange, onThumbnail) {
        this._cleanup = cleanup;
        this._onChange = onChange;
        this._onThumbnail = onThumbnail;
        this._files = [];
        this._drives = [];
        this._showDrives = true;
        this._reloadToken = 0;
        this._cancellable = new Gio.Cancellable();
        this._factory = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.LARGE);
        this._queue = [];
        this._running = 0;
        this._asked = new Set();
        this._reloading = false;
        this._again = false;
        cleanup.add(() => this._cancellable.cancel());
    }

    get entries() {
        return this._showDrives ? [...this._drives, ...this._files] : this._files;
    }

    /** The desktop folder as a Gio.File, or null. */
    get folder() {
        return this._dir;
    }

    start() {
        this._dir = desktopFolder();
        if (this._dir) {
            try {
                this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
                const id = this._monitor.connect('changed', (_m, _file, _other, event) => this._onFolderEvent(event));
                this._cleanup.add(() => {
                    this._monitor.disconnect(id);
                    this._monitor.cancel();
                });
            } catch (e) {
                console.error('[Guava] desktop icons: cannot watch the Desktop folder:', e);
            }
        }
        const volumes = Gio.VolumeMonitor.get();
        for (const signal of ['mount-added', 'mount-removed', 'mount-changed']) {
            const id = volumes.connect(signal, () => this._readDrives(true));
            this._cleanup.add(() => volumes.disconnect(id));
        }
        this._readDrives(false);
        this.reload();
    }

    setShowDrives(show) {
        if (show === this._showDrives)
            return;
        this._showDrives = show;
        this._onChange(this.entries);
    }

    // Created, deleted, renamed or moved files change the list; a finished write changes a
    // thumbnail and the date. A write in progress (CHANGED) and attribute noise do not.
    _onFolderEvent(event) {
        const E = Gio.FileMonitorEvent;
        if (event === E.CHANGED || event === E.PRE_UNMOUNT)
            return;
        this._schedule();
    }

    _schedule() {
        if (this._reloadToken)
            this._cleanup.release(this._reloadToken);
        this._reloadToken = this._cleanup.timeout(RELOAD_DEBOUNCE_MS, () => {
            this._reloadToken = 0;
            this.reload();
        }, { name: 'guava-desktop-icons-reload' });
    }

    /** Read the folder again. One read at a time; a change during a read triggers one more. */
    async reload() {
        if (!this._dir)
            return;
        if (this._reloading) {
            this._again = true;
            return;
        }
        this._reloading = true;
        try {
            this._files = await this._readFolder();
            this._onChange(this.entries);
            this._requestThumbnails(this._files);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                // A missing Desktop folder is an empty desktop, not an error
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    console.error('[Guava] desktop icons: cannot read the Desktop folder:', e.message);
                } else if (this._files.length) {
                    this._files = [];
                    this._onChange(this.entries);
                }
            }
        } finally {
            this._reloading = false;
            if (this._again && !this._cancellable.is_cancelled()) {
                this._again = false;
                this.reload();
            }
        }
    }

    async _readFolder() {
        const enumerator = await this._dir.enumerate_children_async(
            ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
        const entries = [];
        try {
            for (;;) {
                const infos = await enumerator.next_files_async(BATCH, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (!infos.length)
                    break;
                for (const info of infos) {
                    if (info.get_is_hidden() || info.get_is_backup())
                        continue;
                    entries.push(this._fileEntry(info));
                }
            }
        } finally {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
        }
        return entries;
    }

    _fileEntry(info) {
        const fileName = info.get_name();
        const file = this._dir.get_child(fileName);
        const contentType = info.get_content_type() ?? 'application/octet-stream';
        let name = info.get_display_name();
        let gicon = info.get_icon();
        let launcher = null;
        // A launcher shows the app's name and icon, as Files does
        if (contentType === DESKTOP_ENTRY && info.get_attribute_boolean('access::can-execute')) {
            launcher = Gio.DesktopAppInfo.new_from_filename(file.get_path());
            if (launcher) {
                name = launcher.get_name() ?? name;
                gicon = launcher.get_icon() ?? gicon;
            }
        }
        const valid = info.get_attribute_boolean('thumbnail::is-valid');
        return {
            key: fileName,
            name,
            kind: info.get_file_type() === Gio.FileType.DIRECTORY ? 'folder' : 'file',
            contentType,
            kindLabel: Gio.content_type_get_description(contentType),
            mtime: info.get_attribute_uint64('time::modified'),
            ctime: info.get_attribute_uint64('time::created') || info.get_attribute_uint64('time::changed'),
            size: info.get_size(),
            uri: file.get_uri(),
            file,
            gicon,
            launcher,
            thumbnail: valid ? info.get_attribute_byte_string('thumbnail::path') : null,
            thumbnailFailed: info.get_attribute_boolean('thumbnail::failed'),
        };
    }

    // ---- drives ------------------------------------------------------------------------------

    _readDrives(notify) {
        const used = new Set();
        this._drives = [];
        for (const mount of Gio.VolumeMonitor.get().get_mounts()) {
            const root = mount.get_root();
            if (!showsAsDrive({ rootPath: root.get_path(), isShadowed: mount.is_shadowed() }))
                continue;
            let key = `${DRIVE_PREFIX}${mount.get_name()}`;
            if (used.has(key))
                key = `${key}:${root.get_uri()}`;
            used.add(key);
            this._drives.push({
                key,
                name: mount.get_name(),
                kind: 'drive',
                contentType: 'inode/directory',
                kindLabel: mount.get_volume()?.get_drive()?.is_removable() ? 'Removable drive' : 'Drive',
                mtime: 0, ctime: 0, size: 0,
                uri: root.get_uri(),
                file: root,
                gicon: mount.get_icon(),
                mount,
                thumbnail: null,
            });
        }
        if (notify && this._showDrives)
            this._onChange(this.entries);
    }

    // ---- thumbnails ---------------------------------------------------------------------------

    _requestThumbnails(entries) {
        for (const e of entries) {
            const id = `${e.uri}@${e.mtime}`;
            if (e.thumbnail || e.thumbnailFailed || e.kind !== 'file' || this._asked.has(id))
                continue;
            this._asked.add(id);
            this._queue.push(e);
        }
        this._pump();
    }

    _pump() {
        while (this._running < THUMBNAIL_JOBS && this._queue.length) {
            const entry = this._queue.shift();
            this._running++;
            this._thumbnail(entry).finally(() => {
                this._running--;
                if (!this._cancellable.is_cancelled())
                    this._pump();
            });
        }
    }

    async _thumbnail(entry) {
        const f = this._factory;
        if (!f.can_thumbnail(entry.uri, entry.contentType, entry.mtime))
            return;
        try {
            if (f.has_valid_failed_thumbnail(entry.uri, entry.mtime))
                return;
            const pixbuf = await f.generate_thumbnail_async(entry.uri, entry.contentType, this._cancellable);
            await f.save_thumbnail_async(pixbuf, entry.uri, entry.mtime, this._cancellable);
            entry.thumbnail = f.lookup(entry.uri, entry.mtime);
            if (entry.thumbnail)
                this._onThumbnail(entry);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // Remember that this file has none, as Files does, so it is not tried at every start
            f.create_failed_thumbnail_async(entry.uri, entry.mtime, this._cancellable).catch(() => {});
        }
    }
}
