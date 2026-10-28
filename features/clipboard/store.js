// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history on disk: ~/.local/share/guava/clipboard/ (dir 0700, files 0600).
//   history.json            index (text inline, images by file name)
//   images/<sha256>.<ext>   one file per image
//   history.json.bad-<ms>   the last index that could not be read, kept aside (never parsed)
// Async Gio only, except one mkdir in prepare(). Guava only ever deletes files it wrote
// itself: history.json, history.json.bad-*, and image files matching the store's pattern.
// If guava/clipboard or its images/ folder is a symlink, the store refuses to persist.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    checkDimensions, imageDimensions, isStoreFileName, parseHistoryChecked, serializeHistory,
} from './model.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'set_display_name_async', 'set_display_name_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

const LOG = '[Guava]';
const INDEX = 'history.json';
const BAD_RE = /^history\.json\.bad-\d+$/;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;      // refuse to parse a runaway file (text budget is 4 MiB)

export function defaultDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'guava', 'clipboard']);
}

export class ClipboardStore {
    /** @param {string} [dir] store folder (tests pass a temp dir) */
    constructor(dir = defaultDir()) {
        this._dir = Gio.File.new_for_path(dir);
        this._images = this._dir.get_child('images');
        this._index = this._dir.get_child(INDEX);
        this._ready = null;
        this._refused = false;          // a folder is a symlink: nothing is read or written
        this._queue = Promise.resolve();
    }

    get path() {
        return this._dir.get_path();
    }

    /** File for an image entry, or null for a name the store did not write. */
    imageFile(name) {
        return isStoreFileName(name) ? this._images.get_child(name) : null;
    }

    /** Run jobs one after another; a failed job is logged and does not stop the next. */
    _enqueue(job) {
        // Errors are logged here and never reach the caller: writes are fire and forget
        this._queue = this._queue.then(() => this._refused ? undefined : job())
            .catch(e => console.warn(`${LOG} clipboard store: ${e.message}`));
        return this._queue;
    }

    /**
     * 'ok' when guava/clipboard and images/ are real folders, 'missing' when either is not
     * there, 'unsafe' when either is a symlink or not a folder.
     */
    async _inspect() {
        for (const dir of [this._dir, this._images]) {
            let info;
            try {
                info = await dir.query_info_async('standard::type,standard::is-symlink',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    return 'missing';
                throw e;
            }
            if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.DIRECTORY)
                return 'unsafe';
        }
        return 'ok';
    }

    _refuse() {
        if (!this._refused)
            console.warn(`${LOG} ${this.path} or its images folder is a symlink; clipboard history is not saved`);
        this._refused = true;
    }

    /**
     * Create the folders and repair the mode of the store's own folders (guava/clipboard and
     * images/, never guava/ itself, which other Guava parts may share). One small sync mkdir,
     * allowed in enable: it creates the folders with the right mode in one step.
     *
     * @returns {Promise<void>} rejects when the store refuses to persist
     */
    prepare() {
        this._ready ??= (async () => {
            const parent = this._dir.get_parent().get_path();
            if (GLib.mkdir_with_parents(parent, 0o755) !== 0 ||
                GLib.mkdir_with_parents(this._images.get_path(), 0o700) !== 0)
                throw new Error(`cannot create ${this._images.get_path()}`);
            if (await this._inspect() !== 'ok') {
                this._refuse();
                throw new Error('store folder is a symlink');
            }
            for (const dir of [this._dir, this._images]) {
                const info = await dir.query_info_async(
                    'unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
                if ((info.get_attribute_uint32('unix::mode') & 0o777) === 0o700)
                    continue;
                const fix = new Gio.FileInfo();
                fix.set_attribute_uint32('unix::mode', 0o700);
                await dir.set_attributes_async(fix, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    GLib.PRIORITY_DEFAULT, null);
            }
        })().catch(e => {
            if (!this._refused)
                this._ready = null;
            throw e;
        });
        return this._ready;
    }

    _ensure() {
        return this.prepare();
    }

    /**
     * Read the saved history.
     *
     * @param {object} [limits] see model DEFAULTS
     * @returns {Promise<{entries: object[], intact: boolean}>} `intact: false` means the index
     *   was there but could not be used (moved aside as history.json.bad-<ms>) or the folder is
     *   unsafe. The caller must then not sweep image files: they may belong to that index.
     */
    async load(limits = {}) {
        try {
            const state = await this._inspect();
            if (state === 'unsafe') {
                this._refuse();
                return { entries: [], intact: false };
            }
            if (state === 'missing')
                return { entries: [], intact: true };
        } catch (e) {
            console.warn(`${LOG} clipboard folder not readable: ${e.message}`);
            return { entries: [], intact: false };
        }
        let bytes;
        try {
            [bytes] = await this._index.load_contents_async(null);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return { entries: [], intact: true };
            console.warn(`${LOG} clipboard history not loaded: ${e.message}`);
            return { entries: [], intact: false };
        }
        const parsed = bytes && bytes.length <= MAX_INDEX_BYTES
            ? parseHistoryChecked(new TextDecoder().decode(bytes), limits)
            : { ok: false, entries: [] };
        if (!parsed.ok) {
            await this._quarantine();
            return { entries: [], intact: false };
        }
        const keep = [];
        for (const e of parsed.entries) {
            // An image whose file is gone, unreadable or too big to decode is dropped
            if (e.kind === 'image' && !await this._imageUsable(e, limits))
                continue;
            keep.push(e);
        }
        return { entries: keep, intact: true };
    }

    /** Move an unusable index aside, keeping only the newest such copy. */
    async _quarantine() {
        const name = `${INDEX}.bad-${Date.now()}`;
        try {
            await this._index.set_display_name_async(name, GLib.PRIORITY_DEFAULT, null);
            console.warn(`${LOG} clipboard history could not be read; kept as ${name}`);
        } catch (e) {
            console.warn(`${LOG} could not move the unreadable clipboard history aside: ${e.message}`);
            return;
        }
        const old = (await this._listNames(this._dir)).filter(n => BAD_RE.test(n) && n !== name);
        await this._deleteAll(old.map(n => this._dir.get_child(n)));
    }

    async _imageUsable(entry, limits) {
        if (!await this._hasFile(entry.file))
            return false;
        if (entry.width && entry.height)
            return true;       // parseHistory already checked stored sizes
        // Saved before sizes were recorded: read the header (no decoding)
        const bytes = await this.readImage(entry.file);
        const dim = bytes ? imageDimensions(bytes.toArray()) : null;
        if (checkDimensions(dim, limits) !== 'ok')
            return false;
        entry.width = dim.width;
        entry.height = dim.height;
        return true;
    }

    async _hasFile(name) {
        const file = this.imageFile(name);
        if (!file)
            return false;
        try {
            await file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, null);
            return true;
        } catch (_e) {
            return false;
        }
    }

    /** Write history.json (replaces atomically, mode 0600). */
    saveIndex(history) {
        const text = serializeHistory(history);        // snapshot now, write later
        return this._enqueue(async () => {
            await this._ensure();
            await this._index.replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(text)), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        });
    }

    /** Write an image file (same hash means same bytes, so rewriting is harmless). */
    writeImage(name, bytes) {
        const file = this.imageFile(name);
        if (!file)
            return Promise.resolve();
        return this._enqueue(async () => {
            await this._ensure();
            await file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        });
    }

    /** Read an image file back. @returns {Promise<GLib.Bytes|null>} */
    async readImage(name) {
        const file = this.imageFile(name);
        if (!file)
            return null;
        try {
            const [bytes] = await file.load_contents_async(null);
            return new GLib.Bytes(bytes);
        } catch (_e) {
            return null;
        }
    }

    deleteImages(names) {
        const files = names.map(n => this.imageFile(n)).filter(Boolean);
        if (!files.length)
            return Promise.resolve();
        return this._enqueue(async () => {
            if (await this._inspect() === 'ok')
                await this._deleteAll(files);
        });
    }

    async _deleteAll(files) {
        for (const f of files) {
            try {
                await f.delete_async(GLib.PRIORITY_DEFAULT, null);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`${LOG} could not delete ${f.get_basename()}: ${e.message}`);
            }
        }
    }

    async _listNames(dir) {
        const out = [];
        let en;
        try {
            en = await dir.enumerate_children_async(
                Gio.FILE_ATTRIBUTE_STANDARD_NAME, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, null);
        } catch (_e) {
            return out;
        }
        for (;;) {
            const infos = await en.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (!infos.length)
                break;
            out.push(...infos.map(i => i.get_name()));
        }
        return out;
    }

    /** File names in images/ (only ones the store itself would have written). */
    async listImages() {
        return (await this._listNames(this._images)).filter(isStoreFileName);
    }

    /** Delete image files nothing references (left by a crash or an eviction that failed). */
    sweep(history, orphanFiles) {
        return this._enqueue(async () => {
            if (await this._inspect() !== 'ok')
                return;
            const names = orphanFiles(await this.listImages(), history);
            await this._deleteAll(names.map(n => this.imageFile(n)));
        });
    }

    /** Delete everything the store wrote: the index and every image file. */
    clearAll() {
        return this._enqueue(async () => {
            if (await this._inspect() !== 'ok')
                return;
            const names = await this.listImages();
            await this._deleteAll([...names.map(n => this.imageFile(n)), this._index]);
        });
    }

    /** Resolves when every queued write has finished. */
    flush() {
        return this._queue;
    }
}
