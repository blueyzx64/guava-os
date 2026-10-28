// SPDX-License-Identifier: GPL-3.0-or-later
// Appearance preferences: Auto Light/Dark, accent and highlight colours (macOS System
// Settings > Appearance). Adw/Gtk only; prefs/pages/appearance.js places the groups.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { comboRow, switchRow, watchKey } from '../../prefs/widgets.js';

const N_ = s => s;

const COLOURS = [
    ['blue', N_('Blue')], ['purple', N_('Purple')], ['pink', N_('Pink')], ['red', N_('Red')],
    ['orange', N_('Orange')], ['yellow', N_('Yellow')], ['green', N_('Green')], ['graphite', N_('Graphite')],
];

/** A time of day (hours : minutes) bound to a minutes-after-midnight key. */
function _timeRow(settings, title, key, _) {
    const row = new Adw.ActionRow({ title });
    const spin = (upper, label) => {
        const b = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({ lower: 0, upper, step_increment: 1, page_increment: upper > 23 ? 10 : 1 }),
            numeric: true, wrap: true, valign: Gtk.Align.CENTER, width_chars: 2,
        });
        b.update_property([Gtk.AccessibleProperty.LABEL], [`${title}: ${label}`]);
        // Two digits, like a clock
        b.connect('output', () => {
            b.text = String(b.adjustment.value).padStart(2, '0');
            return true;
        });
        return b;
    };
    const hours = spin(23, _('hours'));
    const minutes = spin(59, _('minutes'));
    const box = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER });
    box.append(hours);
    box.append(new Gtk.Label({ label: ':' }));
    box.append(minutes);
    row.add_suffix(box);

    let syncing = false;
    const sync = () => {
        syncing = true;
        const v = settings.get_int(key);
        hours.value = Math.floor(v / 60);
        minutes.value = v % 60;
        syncing = false;
    };
    const save = () => {
        if (syncing)
            return;
        const v = hours.get_value_as_int() * 60 + minutes.get_value_as_int();
        if (settings.get_int(key) !== v)
            settings.set_int(key, v);
    };
    sync();
    hours.connect('value-changed', save);
    minutes.connect('value-changed', save);
    watchKey(settings, key, row, sync);
    return row;
}

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension?.gettext?.(s) ?? s;

    const mode = new Adw.PreferencesGroup({
        title: _('Appearance'),
        description: _('Choose Light or Dark in GNOME Settings, or let Guava switch for you like macOS Auto.'),
    });
    mode.add(switchRow(settings, _('Auto Light and Dark'),
        _('Light by day, Dark by night. Switches only while you are idle. Choosing a style yourself turns this off.'),
        'appearance-auto'));
    const schedule = comboRow(settings, {
        title: _('Schedule'),
        subtitle: _('Sunset to Sunrise uses the location Night Light last saw, else your time zone'),
        key: 'appearance-auto-schedule',
        values: ['sun', 'custom'],
        labels: [_('Sunset to Sunrise'), _('Custom')],
    });
    mode.add(schedule);
    const light = _timeRow(settings, _('Light from'), 'appearance-auto-light-minute', _);
    const dark = _timeRow(settings, _('Dark from'), 'appearance-auto-dark-minute', _);
    mode.add(light);
    mode.add(dark);
    const sync = () => {
        const auto = settings.get_boolean('appearance-auto');
        const custom = settings.get_string('appearance-auto-schedule') === 'custom';
        schedule.sensitive = auto;
        light.visible = dark.visible = custom;
        light.sensitive = dark.sensitive = auto;
    };
    sync();
    for (const key of ['appearance-auto', 'appearance-auto-schedule'])
        watchKey(settings, key, mode, sync);

    const colours = new Adw.PreferencesGroup({ title: _('Colours') });
    colours.add(comboRow(settings, {
        title: _('Accent Colour'),
        subtitle: _('Multicolor follows GNOME\'s accent colour. A colour here sets GNOME\'s while Guava runs.'),
        key: 'appearance-accent',
        values: ['multicolor', ...COLOURS.map(([v]) => v)],
        labels: [_('Multicolor'), ...COLOURS.map(([, l]) => _(l))],
    }));
    colours.add(comboRow(settings, {
        title: _('Highlight Colour'),
        subtitle: _('Text selection in Spotlight and the clipboard'),
        key: 'appearance-highlight',
        values: ['accent', ...COLOURS.map(([v]) => v)],
        labels: [_('Accent Colour'), ...COLOURS.map(([, l]) => _(l))],
    }));

    const icons = new Adw.PreferencesGroup({ title: _('Icons') });
    icons.add(comboRow(settings, {
        title: _('Icon Style'),
        subtitle: _('App icons in the dock and Spotlight. Tinted uses the accent colour.'),
        key: 'appearance-icon-style',
        values: ['default', 'dark', 'clear', 'tinted'],
        labels: [_('Default'), _('Dark'), _('Clear'), _('Tinted')],
    }));

    return [mode, colours, icons];
}
