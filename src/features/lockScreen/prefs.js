// SPDX-License-Identifier: GPL-3.0-or-later
// Lock Screen group (Preferences > General), in the order of macOS System Settings > Lock Screen.
// Adw/Gtk only (the prefs process).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { comboRow, switchRow, watchKey } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, extension: object, _: Function}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('Lock Screen'),
        description: _('How GNOME’s lock screen looks. Signing in is still GNOME’s own.'),
    });
    const master = switchRow(settings, _('Style the Lock Screen Like macOS'),
        _('Large clock, your wallpaper, and your photo and password field at the bottom'), 'lockscreen-style');
    group.add(master);

    const rows = [];
    const add = row => {
        group.add(row);
        rows.push(row);
    };
    add(comboRow(settings, {
        title: _('Show Large Clock'), key: 'lockscreen-large-clock',
        values: ['lock-screen', 'never'], labels: [_('On Lock Screen'), _('Never')],
    }));
    add(comboRow(settings, {
        title: _('Wallpaper'), subtitle: _('Sharp like macOS, or blurred and dimmed like GNOME'),
        key: 'lockscreen-wallpaper', values: ['sharp', 'blurred'], labels: [_('Sharp'), _('Blurred')],
    }));
    add(switchRow(settings, _('Show User Name and Photo'), null, 'lockscreen-show-user'));
    add(switchRow(settings, _('Show Password Hint'),
        _('After three wrong passwords, if your account has a hint'), 'lockscreen-password-hint'));
    add(switchRow(settings, _('Show Now Playing Controls'),
        _('Play, pause and skip only. No other app data'), 'lockscreen-now-playing'));
    add(comboRow(settings, {
        title: _('Notifications'), subtitle: _('Never the text of a notification'),
        key: 'lockscreen-notifications', values: ['count', 'never'],
        labels: [_('Apps and Counts'), _('Never')],
    }));
    add(switchRow(settings, _('Show Sleep, Restart and Shut Down Buttons'),
        _('Restart and Shut Down ask for a second click'), 'lockscreen-power-buttons'));

    const messageSwitch = switchRow(settings, _('Show a Message When the Screen Is Locked'),
        _('Anyone can read it without unlocking'), 'lockscreen-message-on');
    add(messageSwitch);
    const message = new Adw.EntryRow({ title: _('Message'), show_apply_button: true, max_length: 140 });
    settings.bind('lockscreen-message', message, 'text', Gio.SettingsBindFlags.DEFAULT);
    add(message);

    const sync = () => {
        const on = settings.get_boolean('lockscreen-style');
        for (const row of rows)
            row.sensitive = on;
        message.sensitive = on && settings.get_boolean('lockscreen-message-on');
    };
    watchKey(settings, 'lockscreen-style', group, sync);
    watchKey(settings, 'lockscreen-message-on', group, sync);
    sync();
    return [group];
}
