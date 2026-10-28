// SPDX-License-Identifier: GPL-3.0-or-later
// Colour filters, like macOS Accessibility > Display > Colour Filters. Adw/Gtk only.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { comboRow, watchKey } from '../../prefs/widgets.js';

function scaleRow(settings, { title, subtitle, key, upper, label }) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle ?? '' });
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({ lower: 0, upper, step_increment: 1, page_increment: 10 }),
        draw_value: false, hexpand: true, valign: Gtk.Align.CENTER, width_request: 200,
    });
    scale.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    settings.bind(key, scale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

/**
 * The Colour Filters row: a switch that expands to the type, intensity and hue. The Appearance
 * page puts it in the Accessibility group, as on macOS (Accessibility > Display).
 *
 * @param {{settings: Gio.Settings, _: Function}} args
 * @returns {Adw.ExpanderRow}
 */
export function buildRow({ settings, _ }) {
    const filters = new Adw.ExpanderRow({
        title: _('Colour Filters'),
        subtitle: _('Tell colours apart, or reduce colour on the whole screen'),
        show_enable_switch: true,
    });
    settings.bind('color-filter', filters, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    filters.add_row(comboRow(settings, {
        title: _('Filter Type'), key: 'color-filter-kind',
        values: ['greyscale', 'protanopia', 'deuteranopia', 'tritanopia', 'tint'],
        labels: [_('Greyscale'), _('Red/Green Filter (Protanopia)'), _('Green/Red Filter (Deuteranopia)'),
            _('Blue/Yellow Filter (Tritanopia)'), _('Colour Tint')],
    }));
    filters.add_row(scaleRow(settings, {
        title: _('Intensity'), key: 'color-filter-intensity', upper: 100, label: _('Colour filter intensity'),
    }));
    const hue = scaleRow(settings, {
        title: _('Hue'), key: 'color-filter-hue', upper: 359, label: _('Colour tint hue'),
    });
    const syncHue = () => (hue.visible = settings.get_string('color-filter-kind') === 'tint');
    syncHue();
    watchKey(settings, 'color-filter-kind', hue, syncHue);
    filters.add_row(hue);
    return filters;
}
