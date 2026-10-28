// SPDX-License-Identifier: GPL-3.0-or-later
// Login Items (macOS System Settings > General > Login Items & Extensions): the apps that open
// at login (XDG autostart, the user's and the system's) and the apps allowed to run in the
// background (the portal permission store), with the rules of lib/loginItemsModel.js. Only
// Guava's own autostart files (the dock's Open at Login) can be removed here; everything else is
// shown as it is, with GNOME Settings > Apps for the background permission. Adw/Gtk/Gio only.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { DesktopAppInfo } from '../../lib/gioCompat.js';
import { list, readText } from '../../lib/fileOps.js';
import { GUAVA_MARK, backgroundItems, loginItems } from '../../lib/loginItemsModel.js';
import { setAutostart } from '../../features/dock/autostart.js';

export const PAGE = { id: 'login-items', icon: 'system-run-symbolic' };

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const userDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'autostart']);
const systemDirs = () => GLib.get_system_config_dirs().map(d => GLib.build_filenamev([d, 'autostart']));

/** The fields loginItemsModel wants, from one .desktop file (null when it is not one). */
function readFields(fileName, text) {
    const kf = new GLib.KeyFile();
    try {
        kf.load_from_data(text, -1, GLib.KeyFileFlags.NONE);
    } catch (_e) {
        return null;
    }
    const str = key => {
        try {
            return kf.get_string('Desktop Entry', key);
        } catch (_e) {
            return null;
        }
    };
    const localized = key => {
        try {
            return kf.get_locale_string('Desktop Entry', key, null);
        } catch (_e) {
            return null;
        }
    };
    const strv = key => (str(key) ?? '').split(';').filter(Boolean);
    return {
        fileName, name: localized('Name'), icon: str('Icon'), hidden: str('Hidden'),
        gnomeEnabled: str('X-GNOME-Autostart-enabled'), guava: str(GUAVA_MARK),
        onlyShowIn: strv('OnlyShowIn'), notShowIn: strv('NotShowIn'),
    };
}

async function readDir(dir) {
    const out = [];
    for (const name of (await list(dir)).filter(n => n.endsWith('.desktop')).sort()) {
        const text = await readText(GLib.build_filenamev([dir, name])).catch(() => null);
        const fields = text ? readFields(name, text) : null;
        if (fields)
            out.push(fields);
    }
    return out;
}

async function readBackground() {
    try {
        const reply = await Gio.DBus.session.call('org.freedesktop.impl.portal.PermissionStore',
            '/org/freedesktop/impl/portal/PermissionStore', 'org.freedesktop.impl.portal.PermissionStore',
            'Lookup', new GLib.Variant('(ss)', ['background', 'background']), new GLib.VariantType('(a{sas}v)'),
            Gio.DBusCallFlags.NONE, 3000, null);
        return backgroundItems(reply.recursiveUnpack()[0]);
    } catch (_e) {
        // No portal, or no app ever asked (the table does not exist yet)
        return [];
    }
}

function appIcon(name) {
    return new Gtk.Image({ icon_name: name || 'application-x-executable-symbolic', pixel_size: 32 });
}

function openGnomeSettingsApps() {
    try {
        Gio.AppInfo.create_from_commandline('gnome-control-center applications', null, Gio.AppInfoCreateFlags.NONE)
            .launch([], null);
    } catch (e) {
        console.warn('[Guava] prefs: cannot open GNOME Settings:', e.message);
    }
}

export function build({ _ }) {
    const page = new Adw.PreferencesPage({ title: _('Login Items'), icon_name: PAGE.icon });

    const atLogin = new Adw.PreferencesGroup({
        title: _('Open at Login'),
        description: _('These items open when you log in. Add an app from its Dock menu: Options › Open at Login. Items Guava added can be removed here; the others belong to their apps.'),
    });
    page.add(atLogin);
    const background = new Adw.PreferencesGroup({
        title: _('Allow in the Background'),
        description: _('Apps that asked to keep running after their windows close. Change this in GNOME Settings.'),
    });
    const settingsButton = new Gtk.Button({ label: _('Open Settings…'), valign: Gtk.Align.CENTER, css_classes: ['flat'] });
    settingsButton.connect('clicked', openGnomeSettingsApps);
    background.set_header_suffix(settingsButton);
    page.add(background);

    let rows = [];
    let generation = 0;
    const clear = () => {
        rows.forEach(([group, row]) => group.remove(row));
        rows = [];
    };
    const add = (group, row) => {
        group.add(row);
        rows.push([group, row]);
    };

    const refresh = async () => {
        const mine = ++generation;
        const [user, system, allowed] = await Promise.all([
            readDir(userDir()).catch(() => []),
            Promise.all(systemDirs().map(d => readDir(d).catch(() => []))).then(lists => lists.flat()),
            readBackground(),
        ]);
        if (mine !== generation)
            return;
        clear();
        const items = loginItems(user, system);
        if (!items.length)
            add(atLogin, new Adw.ActionRow({ title: _('No items open at login') }));
        for (const item of items) {
            const subtitle = [
                item.enabled ? null : _('Turned off'),
                item.guava ? _('Added by Guava') : item.origin === 'system' ? _('Installed for everyone') : null,
            ].filter(Boolean).join(' · ');
            const row = new Adw.ActionRow({ title: GLib.markup_escape_text(item.name, -1), subtitle });
            row.add_prefix(appIcon(item.icon));
            if (item.removable) {
                const remove = new Gtk.Button({
                    icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                    tooltip_text: _('Remove from Login Items'),
                });
                remove.update_property([Gtk.AccessibleProperty.LABEL], [_('Remove %s from Login Items').replace('%s', item.name)]);
                remove.connect('clicked', () => {
                    remove.sensitive = false;
                    setAutostart(item.id, null, false).catch(e => console.error('[Guava] prefs: removing a login item failed:', e))
                        .finally(refresh);
                });
                row.add_suffix(remove);
            }
            add(atLogin, row);
        }
        if (!allowed.length)
            add(background, new Adw.ActionRow({ title: _('No app has asked to run in the background') }));
        for (const { appId, state } of allowed) {
            let info = null;
            try {
                info = DesktopAppInfo.new(`${appId}.desktop`);
            } catch (_e) {
                info = null;
            }
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(info?.get_name() ?? appId, -1),
                subtitle: { yes: _('Allowed'), no: _('Not allowed'), ask: _('Asks each time') }[state],
            });
            row.add_prefix(info?.get_icon() ? new Gtk.Image({ gicon: info.get_icon(), pixel_size: 32 }) : appIcon(null));
            add(background, row);
        }
    };

    // Kept current while the page exists: the dock (in the Shell) can add an item meanwhile
    try {
        const monitor = Gio.File.new_for_path(userDir()).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        const id = monitor.connect('changed', () => refresh());
        page.connect('destroy', () => {
            monitor.disconnect(id);
            monitor.cancel();
        });
    } catch (e) {
        console.warn('[Guava] prefs: cannot watch the autostart folder:', e.message);
    }
    refresh();
    return page;
}
