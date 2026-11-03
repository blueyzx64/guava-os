// SPDX-License-Identifier: GPL-3.0-or-later
// App Menus setup helpers (preferences process only; Adw/Gtk/Gio): two switches per app that
// change how an app starts so its menus can reach the menu bar. Both are reversible and write
// only what the switch says. Pure logic: core/appMenus/setupModel.js.
//   - Chromium and Electron apps: "Use X11" writes a marked line to ~/.config/<app>-flags.conf.
//   - Flatpak apps: `flatpak override --user --talk-name=com.canonical.AppMenu.Registrar <id>`.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    detectFlagApps, execProgram, flatpakOverrideArgv, hasX11Flag, overrideAllows, parseFlatpakList,
    withX11Flag, withoutX11Flag,
} from '../core/appMenus/setupModel.js';

function run(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                p.get_successful() ? resolve(out ?? '') : reject(new Error(`${argv[0]} failed`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readText(file) {
    try {
        const [bytes] = await file.load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw e;
    }
}

async function writeText(file, text) {
    try {
        file.get_parent().make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
    await file.replace_contents_async(new TextEncoder().encode(text), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function switchRow(title, subtitle, active, onToggle) {
    const row = new Adw.ActionRow({ title, subtitle });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER, active });
    row.add_suffix(sw);
    row.set_activatable_widget(sw);
    let busy = false;
    sw.connect('state-set', (_w, state) => {
        if (busy)
            return false;
        busy = true;
        sw.sensitive = false;
        onToggle(state).then(ok => {
            if (!ok)
                sw.active = !state;
        }).finally(() => {
            busy = false;
            sw.sensitive = true;
        });
        return false;
    });
    // Show the current state without running the toggle action
    const show = on => {
        busy = true;
        sw.active = on;
        busy = false;
    };
    return { row, show };
}

/**
 * @param {Function} _ gettext
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildSetupGroups(_) {
    const x11 = new Adw.PreferencesGroup({
        title: _('Chromium and Electron Apps'),
        description: _('These apps only share their menus when they run through X11 (XWayland). Turning an app on writes one line to its flags file and takes effect the next time the app starts. The cost: XWayland windows can look softer on fractional scaling and lose some Wayland input features. Turning it off removes only that line.'),
    });
    const flags = Gio.File.new_for_path(GLib.get_user_config_dir());
    const found = detectFlagApps(Gio.AppInfo.get_all()
        .map(info => execProgram(info.get_commandline?.() ?? '')));
    if (found.length === 0) {
        x11.add(new Adw.ActionRow({
            title: _('No Chromium or Electron app found'),
            subtitle: _('Installed Flatpak apps are listed below'),
        }));
    }
    for (const app of found) {
        const file = flags.get_child(app.file);
        const { row, show } = switchRow(_(app.name), _('Use X11 so the menus show in the menu bar'), false,
            async state => {
                try {
                    const text = await readText(file);
                    await writeText(file, state ? withX11Flag(text) : withoutX11Flag(text));
                    return true;
                } catch (e) {
                    console.warn(`[Guava] prefs: cannot write ${file.get_path()}: ${e.message}`);
                    return false;
                }
            });
        readText(file).then(text => {
            show(hasX11Flag(text));
        }, () => {});
        x11.add(row);
    }

    const flat = new Adw.PreferencesGroup({
        title: _('Flatpak Apps'),
        description: _('A Flatpak app can only share its menus if its sandbox may talk to Guava’s menu service. Allowing it changes that one app’s permissions (flatpak override --user); turning it off takes the permission away again. Restart the app afterwards.'),
    });
    const placeholder = new Adw.ActionRow({ title: _('Looking for Flatpak apps…') });
    flat.add(placeholder);
    run(['flatpak', 'list', '--app', '--columns=application']).then(out => {
        flat.remove(placeholder);
        const ids = parseFlatpakList(out);
        if (ids.length === 0) {
            flat.add(new Adw.ActionRow({ title: _('No Flatpak apps installed') }));
            return;
        }
        for (const id of ids) {
            const { row, show } = switchRow(id, _('Allow the menu service'), false, async state => {
                const argv = flatpakOverrideArgv(id, state);
                try {
                    await run(argv);
                    return true;
                } catch (e) {
                    console.warn(`[Guava] prefs: ${argv?.join(' ')}: ${e.message}`);
                    return false;
                }
            });
            run(['flatpak', 'override', '--user', '--show', id]).then(
                shown => {
                    show(overrideAllows(shown));
                }, () => {});
            flat.add(row);
        }
    }, () => {
        flat.remove(placeholder);
        flat.add(new Adw.ActionRow({ title: _('Flatpak is not installed') }));
    });
    return [x11, flat];
}
