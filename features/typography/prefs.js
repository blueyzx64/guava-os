// SPDX-License-Identifier: GPL-3.0-or-later
// Typography preferences: macOS text rendering and the macOS font (System Settings shows no
// such choice on a Mac; here it says which font is used and offers Inter when none is).
// Adw/Gtk only; prefs/pages/appearance.js places the group.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { switchRow } from '../../prefs/widgets.js';
import { INTER_PACKAGE, MONO_FAMILIES, UI_FAMILIES, pickFamily } from './model.js';

// GNOME Software's session service: it asks before installing anything
const PK_NAME = 'org.freedesktop.PackageKit';
const PK_PATH = '/org/freedesktop/PackageKit';
const PK_IFACE = 'org.freedesktop.PackageKit.Modify';

function installedFamilies(widget) {
    return widget.get_pango_context().list_families().map(f => f.get_name());
}

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension?.gettext?.(s) ?? s;

    const group = new Adw.PreferencesGroup({
        title: _('Text'),
        description: _('Fonts and text rendering for the whole desktop, like macOS. Your own choices come back when these go off.'),
    });
    group.add(switchRow(settings, _('macOS Text Rendering'),
        _('Smooth, unhinted letters with grayscale antialiasing, as on a Mac'),
        'macos-text-rendering'));
    const font = switchRow(settings, _('macOS Font'), '', 'macos-font');
    group.add(font);

    const install = new Adw.ActionRow({
        title: _('Install Inter'),
        subtitle: _('The open typeface drawn after San Francisco. SF Pro is used instead when you install it yourself.'),
    });
    const button = new Gtk.Button({ label: _('Install'), valign: Gtk.Align.CENTER });
    button.add_css_class('suggested-action');
    install.add_suffix(button);
    install.activatable_widget = button;
    group.add(install);

    const sync = () => {
        const families = installedFamilies(group);
        const ui = pickFamily(families, UI_FAMILIES);
        const mono = pickFamily(families, MONO_FAMILIES);
        font.subtitle = ui
            ? (mono ? _('Uses %s, and %s for code').replace('%s', ui).replace('%s', mono) : _('Uses %s').replace('%s', ui))
            : _('Needs SF Pro or Inter: install one to use it');
        install.visible = !ui;
    };
    sync();
    // The font list comes from the style context: refresh once the window is shown
    group.connect('map', sync);

    button.connect('clicked', () => {
        button.sensitive = false;
        const xid = 0;
        Gio.DBus.session.call(PK_NAME, PK_PATH, PK_IFACE, 'InstallPackageNames',
            new GLib.Variant('(uass)', [xid, [INTER_PACKAGE], 'show-confirm-install,show-progress,hide-finished']),
            null, Gio.DBusCallFlags.NONE, GLib.MAXINT32, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    // Cancelled in the dialog, or no GNOME Software: the row stays
                    console.warn(`[Guava] prefs: Inter was not installed: ${e.message}`);
                }
                button.sensitive = true;
                // Fontconfig picks the new files up; GTK reloads its font list shortly after
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    sync();
                    return GLib.SOURCE_REMOVE;
                });
            });
    });

    return [group];
}
