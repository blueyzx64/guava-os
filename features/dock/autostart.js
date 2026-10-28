// SPDX-License-Identifier: GPL-3.0-or-later
// Options ▸ Open at Login: an XDG autostart file, ~/.config/autostart/<app id>.
// Guava only ever removes a file it wrote, and never a symlink (marked X-Guava-Autostart=true, model.js); a file the
// user or the app made is shown as it is and left alone. Every write goes through the shared
// user-file queue (lib/fileOps.js), async.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { enqueueUserFileJob, exists, isSymlink, makeDirectory, readText, remove, writeText } from '../../lib/fileOps.js';
import { autostartState, autostartText } from './model.js';

const autostartDir = () => Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'autostart']));

/**
 * @param {string} appId e.g. 'org.gnome.Calculator.desktop'
 * @returns {Promise<{enabled: boolean, guava: boolean, editable: boolean}>}
 */
export async function readAutostart(appId) {
    return autostartState(await readText(autostartDir().get_child(appId)));
}

/**
 * Turn Open at Login on (write Guava's file) or off (remove Guava's file). Does nothing when the
 * file there is not Guava's or is a symlink.
 *
 * @param {string} appId
 * @param {?string} desktopPath the app's .desktop file
 * @param {boolean} on
 * @returns {Promise<void>}
 */
export function setAutostart(appId, desktopPath, on) {
    return enqueueUserFileJob(async () => {
        const file = autostartDir().get_child(appId);
        // A symlink there is the user's (dotfiles): written through it or deleted, it would
        // change files Guava did not make, even when it dangles
        if (await exists(file) && await isSymlink(file))
            return;
        const state = autostartState(await readText(file));
        if (!state.editable)
            return;
        if (!on) {
            if (state.guava)
                await remove(file);
            return;
        }
        const source = desktopPath ? await readText(Gio.File.new_for_path(desktopPath)) : null;
        if (!source)
            return;
        await makeDirectory(autostartDir());
        await writeText(file, autostartText(source));
    });
}
