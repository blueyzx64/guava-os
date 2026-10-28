// SPDX-License-Identifier: GPL-3.0-or-later
// Prefs for the notification notch. Adw/Gtk/Gio only (runs in the prefs process).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';



/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);
    const group = new Adw.PreferencesGroup({
        title: _('Notification notch'),
        description: _('A pill at the top centre of the screen shows notifications, live activities and volume changes, and opens into Now, Tray and Widgets. The notification history stays in the calendar menu.'),
    });

    const master = new Adw.SwitchRow({
        title: _('Show the notch'),
        subtitle: _('Moves the clock to the right and shows notifications in Quick Settings'),
    });
    settings.bind('notch', master, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(master);

    const part = (title, subtitle, key) => {
        const row = new Adw.SwitchRow({ title, subtitle: subtitle ?? '' });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    };
    const notifications = part(_('Notifications'),
        _('Show banners in the notch instead of the standard banner'), 'notch-notifications');
    const activities = part(_('Live activities'),
        _('Music, timers, charging and more. Replaces the top bar media button'), 'notch-live-activities');

    const timeout = new Adw.SpinRow({
        title: _('Notification time (seconds)'),
        subtitle: _('How long a banner stays. Hovering keeps it open; urgent ones stay until dismissed'),
        adjustment: new Gtk.Adjustment({ lower: 2, upper: 30, step_increment: 1, page_increment: 5 }),
    });
    settings.bind('notch-timeout', timeout, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(timeout);

    const hover = part(_('Open on hover'),
        _('Rest the pointer on the notch to open it. A click opens it too, and keeps it open'), 'notch-hover-expand');
    const delay = new Adw.SpinRow({
        title: _('Hover delay (milliseconds)'),
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 2000, step_increment: 50, page_increment: 250 }),
    });
    settings.bind('notch-hover-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(delay);

    // Live activities, one by one
    const acts = new Adw.PreferencesGroup({
        title: _('Live Activities'),
        description: _('What the notch shows while it happens. The most important one takes the pill; the rest are listed in the Now tab.'),
    });
    const actRow = (title, subtitle, key) => {
        const row = new Adw.SwitchRow({ title, subtitle: subtitle ?? '' });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        acts.add(row);
        return row;
    };
    const actRows = [
        actRow(_('Charging and battery'), _('Charging, low battery'), 'notch-activity-battery'),
        actRow(_('Headphones'), _('Bluetooth headphones and their battery'), 'notch-activity-bluetooth'),
        actRow(_('Timers'), _('Guava timers counting down, and the timer buttons in Widgets'), 'notch-activity-timers'),
        actRow(_('Screen recording'), _('Elapsed time and a stop button'), 'notch-activity-recording'),
        actRow(_('Next event'), _('From 15 minutes before it starts'), 'notch-activity-calendar'),
        actRow(_('Downloads'), _('App progress bars and partial files in Downloads'), 'notch-activity-downloads'),
        actRow(_('Copy one-time codes'), _('A Copy button for codes found in notifications. Read only on this computer'), 'notch-copy-codes'),
    ];

    // The Tray tab
    const tray = new Adw.PreferencesGroup({
        title: _('Shelf'),
        description: _('The Tray tab keeps links to files. Copy files in Files, then use Add from Clipboard. The files themselves stay where they are.'),
    });
    const trayRow = (title, key) => {
        const row = new Adw.SwitchRow({ title });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        tray.add(row);
        return row;
    };
    const trayRows = [
        trayRow(_('Add finished downloads'), 'notch-shelf-downloads'),
        trayRow(_('Add screenshots'), 'notch-shelf-screenshots'),
    ];
    const clipboard = part(_('Show clipboard in the Tray'),
        _('Turn off to keep copied text off the screen while sharing it'), 'notch-show-clipboard');

    const rows = [notifications, activities, timeout, hover, delay, clipboard, ...trayRows];
    const sync = () => {
        const on = settings.get_boolean('notch');
        rows.forEach(row => (row.sensitive = on));
        actRows.forEach(row => (row.sensitive = on && settings.get_boolean('notch-live-activities')));
        delay.sensitive = on && settings.get_boolean('notch-hover-expand');
    };
    const ids = ['changed::notch', 'changed::notch-live-activities', 'changed::notch-hover-expand']
        .map(sig => settings.connect(sig, sync));
    sync();
    group.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));

    return [group, acts, tray];
}
