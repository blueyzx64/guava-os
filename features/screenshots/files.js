// SPDX-License-Identifier: GPL-3.0-or-later
// File side of a capture, all asynchronous Gio: moving GNOME's fresh screenshot to the chosen
// folder under its macOS name, moving it to the Trash (Save to: Clipboard, or Delete), showing
// it in Files and opening it in the image viewer.
//
// Only the file GNOME has just written for this capture is ever moved or trashed; a name that
// already exists in the target folder is never overwritten (model.nameCandidates gives the
// next free one). Folders are not created: a missing target folder keeps GNOME's.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { DesktopAppInfo } from '../../lib/compat.js';
import { nameCandidates } from './model.js';

Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'trash_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const LOG = '[Guava]';
const VIEWERS = ['org.gnome.Loupe.desktop', 'org.gnome.eog.desktop'];

/** The user's folders, '' when XDG has none. */
export function userDirs() {
    return {
        desktop: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ?? '',
        documents: GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? '',
    };
}

/** A GLib.DateTime as the plain stamp model.stampedName() takes. */
export function stampOf(dt) {
    return {
        year: dt.get_year(), month: dt.get_month(), day: dt.get_day_of_month(),
        hour: dt.get_hour(), minute: dt.get_minute(), second: dt.get_second(),
    };
}

async function isDirectory(path, cancellable) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return info.get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
        return false;
    }
}

/**
 * Carry out a model.commitPlan().
 *
 * @param {Gio.File} file GNOME's screenshot
 * @param {object} plan model.commitPlan() result
 * @param {?Gio.Cancellable} [cancellable]
 * @returns {Promise<?Gio.File>} where the file is now (null when it went to the Trash)
 */
export async function commitFile(file, plan, cancellable = null) {
    if (plan.kind === 'trash') {
        await trashFile(file, cancellable);
        return null;
    }
    if (!plan.same && !await isDirectory(plan.dir, cancellable)) {
        console.warn(`${LOG} screenshot folder ${plan.dir} is missing; the file stays in ${file.get_parent()?.get_path()}`);
        return file;
    }
    for (const name of nameCandidates(plan.stem, plan.ext)) {
        const target = Gio.File.new_for_path(GLib.build_filenamev([plan.dir, name]));
        if (target.equal(file))
            return file;
        try {
            await file.move_async(target, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT,
                cancellable, null);
            return target;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
    }
    return file;
}

export async function trashFile(file, cancellable = null) {
    await file.trash_async(GLib.PRIORITY_DEFAULT, cancellable);
}

/** Open the folder in Files with the file selected (org.freedesktop.FileManager1). */
export async function showInFiles(file) {
    try {
        await Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null);
    } catch (e) {
        // No FileManager1 service: open the folder in the default file manager, as GNOME's
        // own screenshot notification does
        const app = Gio.AppInfo.get_default_for_type('inode/directory', false);
        try {
            if (!app)
                throw e;
            app.launch([file.get_parent()], global.create_app_launch_context(0, -1));
        } catch (err) {
            console.warn(`${LOG} Show in Files failed: ${err.message}`);
        }
    }
}

/** Open the file in the image viewer (Loupe), else the default app for its type. */
export function openInViewer(file) {
    const ctx = global.create_app_launch_context(0, -1);
    try {
        const app = VIEWERS.map(id => DesktopAppInfo.new(id)).find(Boolean);
        if (app)
            app.launch([file], ctx);
        else
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), ctx);
    } catch (e) {
        console.warn(`${LOG} opening the screenshot failed: ${e.message}`);
    }
}
