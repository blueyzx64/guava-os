// SPDX-License-Identifier: GPL-3.0-or-later
// App switcher preferences (Adw/Gtk/Gio only; prefs/pages/navigation.js places the groups).

import Adw from 'gi://Adw';

import { addSwitchRows, switchRow } from '../../prefs/widgets.js';

/** @returns {Adw.PreferencesGroup[]} */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('App Switcher'),
        description: _('Super+Tab works like Cmd-Tab: hold Super and press Tab to move, Q to quit, H to hide, Down to show the app\'s windows; release Super to switch.'),
    });
    group.add(switchRow(settings, _('macOS App Switcher'),
        _('Big app icons in the order you last used them, instead of GNOME\'s switcher'), 'app-switcher'));
    const rows = addSwitchRows(settings, group, [
        { key: 'switcher-cycle-windows', title: _('Super+` Cycles Windows of the Front App'),
            subtitle: _('Like Cmd-`: each press brings the next window of the current app forward') },
        { key: 'switcher-switch-to-space', title: _('Switch to a Space With Open Windows for the App'),
            subtitle: _('Off: an app with no window on this workspace opens a new one here') },
        { key: 'switcher-restore-minimized', title: _('Restore Minimized Windows'),
            subtitle: _('As on macOS, minimized windows stay in the Dock unless you hold Alt as you release Super') },
    ]);
    for (const row of rows)
        settings.bind('app-switcher', row, 'sensitive', 0);
    return [group];
}
