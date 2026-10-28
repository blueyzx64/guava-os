// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop widget preferences. Adw/Gtk/Gio only (runs in the prefs process).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { comboRow, switchRow, watchKey } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);
    const group = new Adw.PreferencesGroup({
        title: _('Desktop Widgets'),
        description: _('Widgets sit on the desktop above the wallpaper and below your windows. Right-click the desktop and choose Edit Widgets… to add them, drag them to place them, and right-click a widget to resize or remove it.'),
    });
    group.add(switchRow(settings, _('Show widgets on the desktop'), null, 'widgets'));
    const style = comboRow(settings, {
        title: _('Widget style'),
        subtitle: _('Automatic dims the widgets to monochrome while a window is in front'),
        key: 'widgets-style',
        values: ['automatic', 'monochrome', 'full-color'],
        labels: [_('Automatic'), _('Monochrome'), _('Full colour')],
    });
    group.add(style);

    const clear = new Adw.ActionRow({
        title: _('Remove all widgets'),
        subtitle: _('The gallery offers Add Default Widgets when the desktop is empty'),
    });
    const button = new Gtk.Button({ label: _('Remove All'), valign: Gtk.Align.CENTER });
    button.add_css_class('destructive-action');
    button.connect('clicked', () => settings.set_string('widgets-layout', ''));
    clear.add_suffix(button);
    group.add(clear);

    const sync = () => {
        const on = settings.get_boolean('widgets');
        style.sensitive = clear.sensitive = on;
        button.sensitive = settings.get_string('widgets-layout') !== '';
    };
    watchKey(settings, 'widgets', group, sync);
    watchKey(settings, 'widgets-layout', group, sync);
    sync();
    return [group];
}
