// SPDX-License-Identifier: GPL-3.0-or-later
// What the user can do with a desktop icon. These are the only things Guava does to the files on
// the desktop, each one a direct user action: open, show in Files, rename, move to the Trash,
// create a folder, eject a drive. Nothing is ever deleted, overwritten or moved anywhere else.
// All async Gio; a failure is reported to the user, never thrown into the Shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.File.prototype, 'set_display_name_async');
Gio._promisify(Gio.File.prototype, 'trash_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.Mount.prototype, 'eject_with_operation');
Gio._promisify(Gio.Mount.prototype, 'unmount_with_operation');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const FILE_MANAGER = {
    name: 'org.freedesktop.FileManager1',
    path: '/org/freedesktop/FileManager1',
    iface: 'org.freedesktop.FileManager1',
};

const isCancelled = e => e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

export class DesktopOps {
    /**
     * @param {(s: string) => string} gettext
     * @param {Gio.Cancellable} cancellable cancelled when the feature stops
     */
    constructor(gettext, cancellable) {
        this._ = gettext;
        this._cancellable = cancellable;
    }

    _fail(title, e) {
        if (isCancelled(e))
            return;
        console.error(`[Guava] desktop icons: ${title}:`, e.message);
        Main.notifyError(title, e.message);
    }

    /** Open an icon with its default app; a drive opens its root; an executable launcher runs. */
    open(entry) {
        try {
            if (entry.launcher) {
                entry.launcher.launch([], global.create_app_launch_context(global.get_current_time(), -1));
                return;
            }
            Gio.AppInfo.launch_default_for_uri_async(
                entry.uri, global.create_app_launch_context(global.get_current_time(), -1), this._cancellable,
                (_o, res) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(res);
                    } catch (e) {
                        this._fail(this._('Could not open “%s”').format(entry.name), e);
                    }
                });
        } catch (e) {
            this._fail(this._('Could not open “%s”').format(entry.name), e);
        }
    }

    /** Show the icons in Files, selected in their folder (org.freedesktop.FileManager1). */
    async showInFiles(entries) {
        const uris = entries.map(e => e.uri);
        try {
            await Gio.DBus.session.call(FILE_MANAGER.name, FILE_MANAGER.path, FILE_MANAGER.iface, 'ShowItems',
                new GLib.Variant('(ass)', [uris, '']), null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            // No file manager on the bus: open the folder instead
            this.open({ uri: entries[0].file.get_parent().get_uri(), name: entries[0].name });
        }
    }

    /** @returns {Promise<boolean>} true when renamed */
    async rename(entry, newName) {
        try {
            await entry.file.set_display_name_async(newName, GLib.PRIORITY_DEFAULT, this._cancellable);
            return true;
        } catch (e) {
            this._fail(this._('Could not rename “%s”').format(entry.name), e);
            return false;
        }
    }

    /** Move to the Trash (never a delete). */
    async trash(entries) {
        for (const entry of entries) {
            try {
                await entry.file.trash_async(GLib.PRIORITY_DEFAULT, this._cancellable);
            } catch (e) {
                this._fail(this._('Could not move “%s” to the Trash').format(entry.name), e);
            }
        }
    }

    /** @returns {Promise<boolean>} true when the folder was made */
    async newFolder(folder, name) {
        try {
            await folder.get_child(name).make_directory_async(GLib.PRIORITY_DEFAULT, this._cancellable);
            return true;
        } catch (e) {
            this._fail(this._('Could not create the folder'), e);
            return false;
        }
    }

    /** Eject (or unmount) a drive. */
    async eject(entry) {
        const mount = entry.mount;
        if (!mount)
            return;
        try {
            const op = new Gio.MountOperation();
            if (mount.can_eject())
                await mount.eject_with_operation(Gio.MountUnmountFlags.NONE, op, this._cancellable);
            else
                await mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, op, this._cancellable);
        } catch (e) {
            this._fail(this._('Could not eject “%s”').format(entry.name), e);
        }
    }
}
