// SPDX-License-Identifier: GPL-3.0-or-later
// The emoji data Emoji & Symbols shows: IBus's emoji dictionary (CLDR names and keywords,
// Unicode groups), which Fedora ships with ibus in /usr/share/ibus/dicts/emoji-<lang>.dict.
// Guava bundles no emoji data. Read once, asynchronously, the first time the popover opens.
//
// File format (ibus src/ibusemoji.c, version 5): a GVariant "(sqv)" = ("IBusEmojiData",
// version, av); each child is an IBusEmojiData serialisation
//   (s a{sv} s:emoji u:n  s*n:annotations  s:description  s:category ...)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { dictLanguages } from './model.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const MAGIC = 'IBusEmojiData';
const BATCH = 700;      // records unpacked per main-loop turn, so the Shell never stalls

/** Every path that may hold a dictionary, best first (user data dir, then system dirs). */
export function dictionaryPaths() {
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    const langs = dictLanguages(GLib.get_language_names());
    return langs.flatMap(lang => dirs.map(d => GLib.build_filenamev([d, 'ibus', 'dicts', `emoji-${lang}.dict`])));
}

function _decodeRecord(child) {
    const a = child.get_variant().deepUnpack();
    if (a[0] !== MAGIC || typeof a[2] !== 'string' || typeof a[3] !== 'number')
        return null;
    const n = a[3];
    return {
        emoji: a[2],
        annotations: a.slice(4, 4 + n).filter(s => typeof s === 'string'),
        description: String(a[4 + n] ?? ''),
        category: String(a[5 + n] ?? ''),
    };
}

/**
 * Load the first dictionary that exists.
 *
 * @param {object} cleanup CleanupRegistry: batches run as its idles, so nothing runs after it
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<?{path: string, records: object[]}>} null when no dictionary is installed
 */
export async function loadEmojiData(cleanup, cancellable) {
    for (const path of dictionaryPaths()) {
        let bytes;
        try {
            [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return null;
            continue;       // not there: try the next one
        }
        try {
            const v = GLib.Variant.new_from_bytes(new GLib.VariantType('(sqv)'), new GLib.Bytes(bytes), false);
            if (v.get_child_value(0).get_string()[0] !== MAGIC)
                continue;
            const list = v.get_child_value(2).get_variant();
            const n = list.n_children();
            const records = [];
            for (let i = 0; i < n; i++) {
                const r = _decodeRecord(list.get_child_value(i));
                if (r)
                    records.push(r);
                if ((i + 1) % BATCH === 0) {
                    await new Promise(resolve => cleanup.idle(resolve, { name: 'emoji-data' }));
                    if (cancellable.is_cancelled())
                        return null;
                }
            }
            return { path, records };
        } catch (e) {
            console.warn(`[Guava] emoji: could not read ${path}: ${e.message}`);
        }
    }
    return null;
}
