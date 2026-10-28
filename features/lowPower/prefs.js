// SPDX-License-Identifier: GPL-3.0-or-later
// Low Power Mode preferences (macOS Battery settings). Adw/Gtk/Gio only.

import Adw from 'gi://Adw';

import { addSwitchRows } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, _: Function}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('Low Power Mode'),
        description: _("Uses GNOME's Power Saver mode (power-profiles-daemon). Choosing a power mode by hand wins until the power source changes."),
    });
    addSwitchRows(settings, group, [
        { key: 'low-power-battery', title: _('On Battery'), subtitle: _('Save energy while running on battery') },
        { key: 'low-power-adapter', title: _('On Power Adapter'), subtitle: _('Save energy while plugged in, or on a computer without a battery') },
    ]);
    return [group];
}
