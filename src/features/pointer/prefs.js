// SPDX-License-Identifier: GPL-3.0-or-later
// Pointer preferences, like macOS Accessibility > Display > Pointer. Adw/Gtk only;
// prefs/pages/appearance.js places them.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { comboRow, switchRow, watchKey } from '../../prefs/widgets.js';

const toHex = rgba => `#${[rgba.red, rgba.green, rgba.blue]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/** A row with a colour button bound to a '#rrggbb' string key. */
function colorRow(settings, { title, key, label }) {
    const row = new Adw.ActionRow({ title });
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({ with_alpha: false, title: label }),
        valign: Gtk.Align.CENTER,
    });
    button.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    const sync = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)) && !rgba.equal(button.rgba))
            button.rgba = rgba;
    };
    sync();
    button.connect('notify::rgba', () => {
        const hex = toHex(button.rgba);
        if (settings.get_string(key) !== hex)
            settings.set_string(key, hex);
    });
    watchKey(settings, key, row, sync);
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = extension?.gettext?.bind(extension) ?? (s => s);
    const group = new Adw.PreferencesGroup({
        title: _('Pointer'),
        description: _('Make the pointer easier to find and see, like macOS Accessibility > Display > Pointer.'),
    });
    group.add(switchRow(settings, _('Shake mouse pointer to locate'),
        _('Shake the mouse or move quickly side to side on the touchpad to make the pointer big for a moment'),
        'pointer-shake-to-locate'));
    group.add(switchRow(settings, _('Hide pointer while typing'),
        _('The pointer comes back as soon as you move the mouse. Works in apps that report their text cursor'),
        'pointer-hide-while-typing'));
    group.add(comboRow(settings, {
        title: _('Pointer size'), key: 'pointer-size',
        values: ['system', '24', '32', '48', '64', '96'],
        labels: [_('System'), _('Normal'), _('Large'), _('Larger'), _('Largest'), _('Huge')],
    }));

    const colors = new Adw.ExpanderRow({
        title: _('Custom colours'),
        subtitle: _('A recoloured copy of your cursor theme, made in your icons folder'),
        show_enable_switch: true,
    });
    settings.bind('pointer-custom-colors', colors, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    colors.add_row(colorRow(settings, {
        title: _('Pointer outline colour'), key: 'pointer-outline-color', label: _('Pointer outline colour'),
    }));
    colors.add_row(colorRow(settings, {
        title: _('Pointer fill colour'), key: 'pointer-fill-color', label: _('Pointer fill colour'),
    }));
    const reset = new Gtk.Button({ label: _('Reset'), valign: Gtk.Align.CENTER });
    reset.connect('clicked', () => {
        settings.reset('pointer-fill-color');
        settings.reset('pointer-outline-color');
    });
    const resetRow = new Adw.ActionRow({ title: _('Reset colours') });
    resetRow.add_suffix(reset);
    colors.add_row(resetRow);
    group.add(colors);
    return [group];
}
