// SPDX-License-Identifier: GPL-3.0-or-later
// The file shelf (Tray tab): links to files, kept in the Guava key `notch-shelf`, newest first.
// The files themselves are never copied, moved or deleted.
//
// How files get here on GNOME 50 / Wayland (docs/features/notch.md, "File shelf"):
//   - dropped on the notch from an app (drop.js reads the drag's DND selection);
//   - "Add from Clipboard": files copied in Files (x-special/gnome-copied-files or
//     text/uri-list) or a copied path;
//   - finished downloads (notch-shelf-downloads) and new screenshots (notch-shelf-screenshots).
// Dragging out of the Shell into an app is not possible for a Shell actor (it cannot start a
// Wayland drag). With the separate guava-shelf-helper package installed, shelfHelper.js puts the
// helper's window over the tiles and the drag starts there. Either way items also give
// themselves back with Open, Show in Files, Copy (a text/uri-list on the clipboard, which Files
// and GTK apps paste as the file) and Remove.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { addToShelf, removeFromShelf, CLIPBOARD_FILE_TYPES, displayName } from './model.js';

const KEY = 'notch-shelf';
const INFO_ATTRS = 'standard::display-name,standard::icon,standard::content-type';

export class Shelf {
    /**
     * @param {CleanupRegistry} cleanup
     * @param {GuavaSettings} ks
     * @param {() => void} onChange the list, an item's info or the clipboard offer changed
     */
    constructor(cleanup, ks, onChange) {
        this._ks = ks;
        this._onChange = onChange;
        this._info = new Map();     // uri -> {name, gicon, missing}
        this._cancellable = new Gio.Cancellable();
        this._clipboardHasFiles = false;
        this._alive = true;
        cleanup.add(() => {
            this._alive = false;
            this._cancellable.cancel();
        });
        ks.watch(KEY, () => this._changed());

        // Is there something to add? Follow the clipboard owner (no reads until the button)
        const selection = global.display.get_selection();
        cleanup.connect(selection, 'owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._syncClipboardOffer();
        });
        this._syncClipboardOffer();

        cleanup.connect(Main.screenshotUI, 'screenshot-taken', (_ui, file) => {
            if (ks.bool('notch-shelf-screenshots') && file)
                this.add([file.get_uri()]);
        });
    }

    /** @returns {string[]} the links, newest first */
    get uris() {
        return this._ks.strv(KEY);
    }

    get clipboardHasFiles() {
        return this._clipboardHasFiles;
    }

    /** Display info of one item (loaded once, asynchronously; onChange fires when it lands) */
    info(uri) {
        const known = this._info.get(uri);
        if (known)
            return known;
        const entry = { name: displayName(uri), gicon: null, missing: false };
        this._info.set(uri, entry);
        Gio.File.new_for_uri(uri).query_info_async(INFO_ATTRS, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable, (f, res) => {
                try {
                    const i = f.query_info_finish(res);
                    entry.name = i.get_display_name() || entry.name;
                    entry.gicon = i.get_icon();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    entry.missing = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ?? false;
                }
                if (this._alive)
                    this._onChange();
            });
        return entry;
    }

    add(uris) {
        const next = addToShelf(this.uris, uris);
        if (JSON.stringify(next) !== JSON.stringify(this.uris))
            this._ks.setStrv(KEY, next);
    }

    remove(uri) {
        this._ks.setStrv(KEY, removeFromShelf(this.uris, uri));
    }

    clear() {
        this._ks.setStrv(KEY, []);
    }

    /**
     * Read files from the clipboard in the best format offered. Meta.Selection, not
     * St.Clipboard.get_content (which crashed Shell 50 in the harness).
     * @returns {Promise<number>} how many were added
     */
    addFromClipboard() {
        const selection = global.display.get_selection();
        const type = Meta.SelectionType.SELECTION_CLIPBOARD;
        const offered = selection.get_mimetypes(type) ?? [];
        const pick = CLIPBOARD_FILE_TYPES.find(([mime]) => offered.includes(mime));
        if (!pick)
            return Promise.resolve(0);
        const [mime, parse] = pick;
        const out = Gio.MemoryOutputStream.new_resizable();
        return new Promise((resolve, reject) => {
            selection.transfer_async(type, mime, -1, out, this._cancellable, (sel, res) => {
                try {
                    sel.transfer_finish(res);
                    out.close(null);
                    const uris = parse(new TextDecoder().decode(out.steal_as_bytes().toArray()));
                    if (this._alive && uris.length)
                        this.add(uris);
                    resolve(uris.length);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        resolve(0);
                    else
                        reject(e);
                }
            });
        });
    }

    open(uri) {
        Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1),
            this._cancellable, (_o, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (e) {
                    console.warn(`[Guava] notch shelf: cannot open ${uri}: ${e.message}`);
                }
            });
    }

    /** Show the file selected in the file manager (org.freedesktop.FileManager1) */
    reveal(uri) {
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    console.warn(`[Guava] notch shelf: cannot show ${uri}: ${e.message}`);
                }
            });
    }

    /** Put the file on the clipboard, so it pastes into Files or a GTK app */
    copy(uri) {
        const source = Meta.SelectionSourceMemory.new('text/uri-list',
            new GLib.Bytes(new TextEncoder().encode(`${uri}\r\n`)));
        global.display.get_selection().set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    _changed() {
        const keep = new Set(this.uris);
        for (const uri of this._info.keys()) {
            if (!keep.has(uri))
                this._info.delete(uri);
        }
        this._onChange();
    }

    _syncClipboardOffer() {
        const offered = global.display.get_selection().get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        const has = CLIPBOARD_FILE_TYPES.slice(0, 2).some(([mime]) => offered.includes(mime));
        if (has !== this._clipboardHasFiles) {
            this._clipboardHasFiles = has;
            this._onChange();
        }
    }
}
