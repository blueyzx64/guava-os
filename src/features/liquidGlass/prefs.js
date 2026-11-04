// SPDX-License-Identifier: GPL-3.0-or-later
// Liquid Glass preferences (Adw/Gtk/Gio only: the prefs process). buildPrefs() returns the
// groups; prefs/pages/appearance.js places them. Order and wording follow macOS: System
// Settings > Appearance (Liquid Glass Clear/Tinted, wallpaper tinting) and Accessibility >
// Display (Reduce Transparency, Increase Contrast, Show Borders).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { switchRow, watchKey } from '../../prefs/widgets.js';

const N_ = s => s;

const SURFACES = [
    ['panel', N_('Menu bar')],
    ['menus', N_('Menus, Control Center and calendar')],
    ['dock', N_('Dock')],
    ['overlays', N_('Spotlight, clipboard and the Stage Manager floor')],
];

const BMS_DIRS = [
    GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'blur-my-shell@aunetx']),
    '/usr/share/gnome-shell/extensions/blur-my-shell@aunetx',
];

/** The Clear <-> Tinted slider, with the two ends named under it like macOS. */
function _surfaceRow(settings, surface, title) {
    const row = new Adw.SwitchRow({ title });
    const key = 'liquid-glass-surfaces';
    const sync = () => {
        const on = settings.get_strv(key).includes(surface);
        if (row.active !== on)
            row.active = on;
    };
    sync();
    row.connect('notify::active', () => {
        const list = settings.get_strv(key).filter(s => s !== surface);
        if (row.active)
            list.push(surface);
        // keep the canonical order so equal sets compare equal
        const ordered = SURFACES.map(([s]) => s).filter(s => list.includes(s));
        if (ordered.join() !== settings.get_strv(key).join())
            settings.set_strv(key, ordered);
    });
    watchKey(settings, key, row, sync);
    return row;
}

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension?.gettext?.(s) ?? s;

    const access = new Adw.PreferencesGroup({
        title: _('Accessibility'),
        name: 'accessibility',     // prefs/pages/appearance.js adds the colour filters here
        description: _('Like macOS Accessibility > Display. GNOME\'s High Contrast also makes Guava\'s surfaces solid with strong borders.'),
    });
    access.add(switchRow(settings, _('Reduce Transparency'),
        _('Opaque surfaces, without the wallpaper tint'), 'glass-reduce-transparency'));
    access.add(switchRow(settings, _('Increase Contrast'),
        _('Opaque, flat surfaces with strong borders'), 'glass-increase-contrast'));
    access.add(switchRow(settings, _('Show Borders'),
        _('A clear border around every surface and Control Center module'), 'glass-show-borders'));

    const where = new Adw.PreferencesGroup({
        title: _('Blurred Surfaces'),
        description: _('A surface switched off keeps its solid theme colour. Reduce Transparency makes the rest opaque.'),
    });
    for (const [surface, title] of SURFACES)
        where.add(_surfaceRow(settings, surface, _(title)));

    // Liquid Glass (liquid-glass) is off and has no row: its tint, wallpaper tint and grain went with
    // it. The feature's code stays (features/liquidGlass, lib/glassParams.js 'glass' style).
    if (BMS_DIRS.some(dir => GLib.file_test(dir, GLib.FileTest.IS_DIR))) {
        const notice = new Adw.ActionRow({
            title: _('Blur my Shell is installed'),
            subtitle: _('Its blur overlaps with Guava\'s. Use one of them for each surface. Guava never changes Blur my Shell.'),
        });
        notice.add_prefix(new Gtk.Image({ icon_name: 'dialog-information-symbolic' }));
        where.add(notice);
    }

    return [access, where];
}
