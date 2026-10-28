// SPDX-License-Identifier: GPL-3.0-or-later
// Show Desktop preferences. Adw/Gtk/Gio only (runs in the prefs process, no Shell libs).
// buildPrefs() returns the Adw.PreferencesGroup[]; prefs/pages/ places them on a page.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { comboRow, shortcutRow } from '../../prefs/widgets.js';



const KEY_SHORTCUT = 'show-desktop-shortcut';
const SPEEDS = ['fast', 'normal', 'slow'];



/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);

    const main = new Adw.PreferencesGroup({
        title: _('Show Desktop'),
        description: _('Slide every window to the nearest screen edge to see the desktop. Press again, or click a window, to bring them back.'),
    });
    const button = new Adw.SwitchRow({
        title: _('Show the top bar button'),
        subtitle: _('A small button next to the system menu'),
    });
    settings.bind('show-desktop-button', button, 'active', Gio.SettingsBindFlags.DEFAULT);
    main.add(button);
    main.add(shortcutRow(settings, _, { key: KEY_SHORTCUT, title: _('Shortcut'), example: '<Super>d' }));

    const speed = new Adw.ComboRow({
        title: _('Animation speed'),
        model: Gtk.StringList.new([_('Fast'), _('Normal'), _('Slow')]),
    });
    const syncSpeed = () => {
        const i = SPEEDS.indexOf(settings.get_string('show-desktop-speed'));
        speed.selected = i < 0 ? 1 : i;
    };
    syncSpeed();
    speed.connect('notify::selected', () => {
        const value = SPEEDS[speed.selected];
        if (value && value !== settings.get_string('show-desktop-speed'))
            settings.set_string('show-desktop-speed', value);
    });
    const id = settings.connect('changed::show-desktop-speed', syncSpeed);
    speed.connect('destroy', () => settings.disconnect(id));
    main.add(speed);
    main.add(comboRow(settings, {
        title: _('Click wallpaper to reveal desktop'),
        subtitle: _('Clicking empty wallpaper moves the windows aside to show the desktop'),
        key: 'click-wallpaper-reveals-desktop', values: ['always', 'stage-manager', 'never'],
        labels: [_('Always'), _('Only in Stage Manager'), _('Never')],
    }));

    const note = new Adw.PreferencesGroup({
        description: _('GNOME\'s own "Hide all normal windows" shortcut, if you set one in Settings, plays the same animation while Guava runs. Guava never changes it. With Stage Manager on, Stage Manager handles Show Desktop.'),
    });
    return [main, note];
}
