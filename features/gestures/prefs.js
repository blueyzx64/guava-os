// SPDX-License-Identifier: GPL-3.0-or-later
// Trackpad gesture preferences (Adw/Gtk/Gio only; prefs/pages/navigation.js places them).

import Adw from 'gi://Adw';

import { addSwitchRows, switchRow } from '../../prefs/widgets.js';

/** @returns {Adw.PreferencesGroup[]} */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('Trackpad Gestures'),
        description: _('The macOS gestures with three and four fingers. Opening the Notification Center with two fingers from the right edge is not possible on GNOME: two-finger motion always scrolls the app under the pointer. Click the clock or use a hot corner instead.'),
    });
    group.add(switchRow(settings, _('Trackpad Gestures'),
        _('App Exposé, Launchpad and Show Desktop gestures'), 'gestures'));
    const rows = addSwitchRows(settings, group, [
        { key: 'gestures-mission-control', title: _('Mission Control'),
            subtitle: _('Swipe up with three or four fingers') },
        { key: 'gestures-app-expose', title: _('App Exposé'),
            subtitle: _('Swipe down with four fingers') },
        { key: 'gestures-spaces', title: _('Swipe Between Spaces'),
            subtitle: _('Swipe left or right with three or four fingers') },
        { key: 'gestures-launchpad', title: _('Launchpad'),
            subtitle: _('Pinch with thumb and three fingers') },
        { key: 'gestures-show-desktop', title: _('Show Desktop'),
            subtitle: _('Spread with thumb and three fingers') },
    ]);
    for (const row of rows)
        settings.bind('gestures', row, 'sensitive', 0);
    return [group];
}
