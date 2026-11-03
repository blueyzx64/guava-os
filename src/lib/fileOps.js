// SPDX-License-Identifier: GPL-3.0-or-later
// Async file helpers for the code that touches files outside the extension
// (features/appButtons/gtkTheme.js, features/dock/autostart.js, prefs/pages/loginItems.js). Never blocks the compositor: every call is the
// *_async Gio variant.
//
// Rules every caller follows: only Guava-marked content is removed, a file Guava did
// not create is never deleted (only emptied of Guava's part), and a symlink is written through,
// never replaced.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { createJobQueue } from './jobQueue.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype, 'replace_async', 'replace_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'move_async', 'move_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

const asFile = f => (typeof f === 'string' ? Gio.File.new_for_path(f) : f);
const notFound = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);

/** @returns {Promise<boolean>} true when the path exists (a dangling symlink counts) */
export async function exists(file) {
    try {
        await asFile(file).query_info_async('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, null);
        return true;
    } catch (e) {
        if (notFound(e))
            return false;
        throw e;
    }
}

/** @returns {Promise<boolean>} */
export async function isSymlink(file) {
    const info = await asFile(file).query_info_async('standard::is-symlink',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
    return info.get_is_symlink();
}

/** A file that is not valid UTF-8: rewriting its decoded text would corrupt the other bytes. */
export class NotUtf8Error extends Error {
    constructor(path) {
        super(`${path} is not valid UTF-8`);
        this.name = 'NotUtf8Error';
    }
}

const STRICT_DECODER = new TextDecoder('utf-8', { fatal: true });
const LOSSY_DECODER = new TextDecoder();

/**
 * @param {Gio.File|string} file
 * @param {{lossy?: boolean, cancellable?: ?Gio.Cancellable}} [opts] lossy: for text that is only
 *   read, never written back (invalid bytes become U+FFFD); without it a file that is not valid
 *   UTF-8 throws NotUtf8Error
 * @returns {Promise<?string>} the text, or null when the file does not exist
 */
export async function readText(file, { lossy = false, cancellable = null } = {}) {
    const f = asFile(file);
    let bytes;
    try {
        [bytes] = await f.load_contents_async(cancellable);
    } catch (e) {
        if (notFound(e))
            return null;
        throw e;
    }
    try {
        return (lossy ? LOSSY_DECODER : STRICT_DECODER).decode(bytes);
    } catch (_e) {
        throw new NotUtf8Error(f.get_path());
    }
}

/**
 * Write text. Never hands an empty buffer to GIO (that call hangs). followLinks (default)
 * writes through a symlink to its target instead of replacing the link (dotfile setups).
 */
export async function writeText(file, text, { followLinks = true, private: priv = false, cancellable = null } = {}) {
    const f = asFile(file);
    let flags = followLinks ? Gio.FileCreateFlags.NONE : Gio.FileCreateFlags.REPLACE_DESTINATION;
    if (priv)
        flags |= Gio.FileCreateFlags.PRIVATE;
    if (!text) {
        const stream = await f.replace_async(null, false, flags, GLib.PRIORITY_DEFAULT, cancellable);
        await stream.close_async(GLib.PRIORITY_DEFAULT, cancellable);
        return;
    }
    await f.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(text)),
        null, false, flags, cancellable);
}

/** Delete a file or an empty directory; a missing one is fine. */
export async function remove(file, cancellable = null) {
    try {
        await asFile(file).delete_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (!notFound(e))
            throw e;
    }
}

/** Rename without following symlinks. */
export async function move(from, to) {
    await asFile(from).move_async(asFile(to), Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_DEFAULT, null, null);
}

/** mkdir (one level); an existing directory is fine. */
export async function makeDirectory(dir) {
    try {
        await asFile(dir).make_directory_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}

/** @returns {Promise<string[]>} names in a directory ([] when it does not exist) */
export async function list(dir) {
    let enumerator;
    try {
        enumerator = await asFile(dir).enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (notFound(e))
            return [];
        throw e;
    }
    const names = [];
    try {
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (!infos.length)
                break;
            infos.forEach(i => names.push(i.get_name()));
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return names;
}

/**
 * Rewrite a text file with `edit(text) -> text`, only if it exists and the result differs.
 * When the result is empty the file is deleted only if `deleteWhenEmpty` (the caller knows
 * Guava created it) and it is not a symlink; otherwise it is emptied.
 *
 * A file that is not valid UTF-8 is left untouched (and logged): decoding it would turn the
 * odd bytes into U+FFFD and writing that back would damage the user's text. A cancelled
 * `cancellable` stops before the write.
 *
 * @returns {Promise<'missing'|'unchanged'|'written'|'deleted'|'unreadable'|'cancelled'>}
 */
export async function editText(file, edit, { deleteWhenEmpty = false, cancellable = null } = {}) {
    const f = asFile(file);
    let text;
    try {
        text = await readText(f, { cancellable });
    } catch (e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return 'cancelled';
        if (!(e instanceof NotUtf8Error))
            throw e;
        console.warn(`[Guava] ${e.message}: left untouched`);
        return 'unreadable';
    }
    if (text === null)
        return 'missing';
    const next = edit(text);
    if (next === text)
        return 'unchanged';
    if (cancellable?.is_cancelled())
        return 'cancelled';
    if (!next.trim() && deleteWhenEmpty && !await isSymlink(f)) {
        await remove(f, cancellable);
        return 'deleted';
    }
    await writeText(f, next.trim() ? next : '', { cancellable });
    return 'written';
}

/**
 * The one queue for every job that edits files in the user's home (gtk.css, environment.d,
 * Mozilla profiles): a lock drops one feature instance and the unlock makes another, and the
 * one-shot cleanup runs beside them, so their read-modify-write sequences must not overlap.
 */
export const enqueueUserFileJob = createJobQueue(e => console.error(`[Guava] user file job failed: ${e}`));
