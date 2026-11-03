// SPDX-License-Identifier: GPL-3.0-or-later
// Launchpad preferences. Adw/Gtk/Gio only (the prefs process); prefs/pages/dock.js places them.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { shortcutRow, switchRow } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, _: Function}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('Launchpad'),
        description: _('Every app in a full-screen grid, with pages, search and folders. Drag an app onto another to make a folder. Folders and order are shared with GNOME’s app grid.'),
    });
    group.add(switchRow(settings, _('Launchpad'), _('Open it from the Dock, with the shortcut or with a pinch on the touchpad'), 'launchpad'));
    const rows = [
        shortcutRow(settings, _, { key: 'launchpad-shortcut', title: _('Shortcut'), example: '<Super>a' }),
        switchRow(settings, _('Show Launchpad in the Dock'), null, 'dock-launchpad'),
        switchRow(settings, _('Delete apps in jiggle mode'),
            _('Hold Alt, or press and hold an icon. Only Flatpak apps (through GNOME Software) can be deleted'),
            'launchpad-delete-apps'),
    ];
    for (const row of rows) {
        settings.bind('launchpad', row, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(row);
    }
    return [group];
}
