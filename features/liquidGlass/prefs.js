// SPDX-License-Identifier: GPL-3.0-or-later
// Liquid Glass preferences (Adw/Gtk/Gio only: the prefs process). buildPrefs() returns the
// groups; prefs/pages/appearance.js places them. Order and wording follow macOS: System
// Settings > Appearance (Liquid Glass Clear/Tinted, wallpaper tinting) and Accessibility >
// Display (Reduce Transparency, Increase Contrast, Show Borders).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
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
function _tintRow(settings, _) {
    const row = new Adw.ActionRow({
        title: _('Liquid Glass'),
        subtitle: _('Clear is more see-through. Tinted is more opaque and easier to read.'),
    });
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1, page_increment: 10 }),
        draw_value: false,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 220,
    });
    scale.add_mark(0, Gtk.PositionType.BOTTOM, _('Clear'));
    scale.add_mark(100, Gtk.PositionType.BOTTOM, _('Tinted'));
    scale.update_property([Gtk.AccessibleProperty.LABEL], [_('Liquid Glass: Clear to Tinted')]);
    settings.bind('glass-tint', scale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

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

    const look = new Adw.PreferencesGroup({
        title: _('Liquid Glass'),
        description: _('One glass look for every Guava surface: a tint with a soft sheen, a thin rim and a shadow. No blur, so it costs almost nothing. App windows keep their own look.'),
    });
    look.add(switchRow(settings, _('Glass'), _('Off gives every surface its solid theme colour'), 'liquid-glass'));
    const tint = _tintRow(settings, _);
    look.add(tint);
    const wallpaper = switchRow(settings, _('Allow Wallpaper Tinting'),
        _('A little of the wallpaper\'s colour shows through the glass'), 'glass-wallpaper-tint');
    look.add(wallpaper);
    const grain = switchRow(settings, _('Frosted Grain'),
        _('A faint grain instead of the top-to-bottom sheen'), 'glass-noise');
    look.add(grain);
    if (BMS_DIRS.some(dir => GLib.file_test(dir, GLib.FileTest.IS_DIR))) {
        const notice = new Adw.ActionRow({
            title: _('Blur my Shell is installed'),
            subtitle: _('Its blur and its own Liquid Glass effect overlap with Guava\'s glass. Use one of them for each surface. Guava never changes Blur my Shell.'),
        });
        notice.add_prefix(new Gtk.Image({ icon_name: 'dialog-information-symbolic' }));
        look.add(notice);
    }

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

    const where = new Adw.PreferencesGroup({ title: _('Glass Surfaces') });
    for (const [surface, title] of SURFACES)
        where.add(_surfaceRow(settings, surface, _(title)));

    // macOS greys the Liquid Glass choice out while Reduce Transparency or Increase Contrast
    // is on; everything here depends on the Glass switch
    const sync = () => {
        const on = settings.get_boolean('liquid-glass');
        const opaque = settings.get_boolean('glass-reduce-transparency') ||
            settings.get_boolean('glass-increase-contrast');
        for (const row of [tint, wallpaper, grain])
            row.sensitive = on && !opaque;
        access.sensitive = on;
        where.sensitive = on;
    };
    sync();
    for (const key of ['liquid-glass', 'glass-reduce-transparency', 'glass-increase-contrast'])
        watchKey(settings, key, look, sync);

    return [look, access, where];
}
