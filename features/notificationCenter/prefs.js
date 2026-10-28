// SPDX-License-Identifier: GPL-3.0-or-later
// Prefs for the Notification Center column. Adw/Gtk/Gio only (runs in the prefs process).

import Adw from 'gi://Adw';

import { switchRow } from '../../prefs/widgets.js';

/** @returns {Adw.PreferencesGroup[]} */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('Notification Center'),
        description: _('Clicking the clock opens a column at the right with the date, your notifications grouped by app, and widgets. Banners still appear in the notch.'),
    });
    group.add(switchRow(settings, _('Notification Center'),
        _('Off: the clock opens the calendar card'), 'notification-center'));
    group.add(switchRow(settings, _('Widgets'),
        _('Show the widgets area below the notifications'), 'notification-center-widgets'));
    return [group];
}
