// SPDX-License-Identifier: GPL-3.0-or-later
// Rounded corners preferences. Adw/Gtk/Gio only (runs in the prefs process, no Shell libs).
// buildPrefs() returns the Adw.PreferencesGroup[]; prefs/pages/ places them on a page.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { RADIUS_MAX, RADIUS_MIN, WHICH_DEFAULT, WHICH_VALUES, normalizeId } from './model.js';



const KEY_LIST = 'rounded-corners-blacklist';
const KEY_WHICH = 'rounded-corners-which';

function _whichRow(settings, _, connect) {
    // Same order as WHICH_VALUES
    const labels = [_('Top corners only'), _('All four corners')];
    const row = new Adw.ComboRow({
        title: _('Rounded corners'),
        subtitle: _('Top only keeps the bottom edge square'),
        model: Gtk.StringList.new(labels),
    });
    const sync = () => {
        const i = WHICH_VALUES.indexOf(settings.get_string(KEY_WHICH));
        const want = i >= 0 ? i : WHICH_VALUES.indexOf(WHICH_DEFAULT);
        if (row.selected !== want)
            row.selected = want;
    };
    sync();
    row.connect('notify::selected', () => {
        const v = WHICH_VALUES[row.selected];
        if (v && settings.get_string(KEY_WHICH) !== v)
            settings.set_string(KEY_WHICH, v);
    });
    connect(KEY_WHICH, sync);
    settings.bind('rounded-corners', row, 'sensitive', Gio.SettingsBindFlags.GET);
    return row;
}

function _excludedGroup(settings, _, connect) {
    const group = new Adw.PreferencesGroup({
        title: _('Excluded Apps'),
        description: _('These apps keep square corners. Use the WM_CLASS or app id, for example "org.gnome.Terminal" or "firefox".'),
    });
    const entry = new Adw.EntryRow({ title: _('Add an app id or WM_CLASS'), show_apply_button: true });
    group.add(entry);
    let rows = [];

    const rebuild = () => {
        rows.forEach(r => group.remove(r));
        rows = settings.get_strv(KEY_LIST).map(id => {
            const row = new Adw.ActionRow({ title: id });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'], tooltip_text: _('Remove'),
            });
            remove.connect('clicked', () =>
                settings.set_strv(KEY_LIST, settings.get_strv(KEY_LIST).filter(x => x !== id)));
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
    };
    entry.connect('apply', () => {
        const id = entry.text.trim();
        const list = settings.get_strv(KEY_LIST);
        if (id && !list.some(x => normalizeId(x) === normalizeId(id)))
            settings.set_strv(KEY_LIST, [...list, id]);
        entry.text = '';
    });
    connect(KEY_LIST, rebuild);
    rebuild();
    return group;
}

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, window, extension }) {
    const _ = s => extension.gettext(s);
    const handlers = [];
    const connect = (key, fn) => handlers.push(settings.connect(`changed::${key}`, fn));
    window.connect('close-request', () => {
        handlers.splice(0).forEach(id => settings.disconnect(id));
        return false;
    });

    const main = new Adw.PreferencesGroup({
        title: _('Rounded Corners'),
        description: _('Round the top corners of app windows, or all four. Maximized, tiled and fullscreen windows stay square.'),
    });
    const enabled = new Adw.SwitchRow({ title: _('Round window corners') });
    settings.bind('rounded-corners', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    main.add(enabled);
    main.add(_whichRow(settings, _, connect));

    const radius = new Adw.SpinRow({
        title: _('Corner radius'),
        subtitle: _('In pixels'),
        adjustment: new Gtk.Adjustment({ lower: RADIUS_MIN, upper: RADIUS_MAX, step_increment: 1, page_increment: 4 }),
    });
    settings.bind('rounded-corners-radius', radius, 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('rounded-corners', radius, 'sensitive', Gio.SettingsBindFlags.GET);
    main.add(radius);

    return [main, _excludedGroup(settings, _, connect)];
}
