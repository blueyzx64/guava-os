// SPDX-License-Identifier: GPL-3.0-or-later
// Prefs for the window buttons of app titlebars. Adw/Gtk/Gio only (runs in the prefs process).
// The group goes on the Windows page (prefs/pages/windows.js). Window buttons always stay on the
// app's own titlebar; Guava draws none in the top bar.

import Adw from 'gi://Adw';

import { comboRow } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);
    const group = new Adw.PreferencesGroup({
        title: _('Window Buttons'),
        description: _('Close, minimize and maximize stay in each app\'s own titlebar. Guava sets the GNOME button ' +
            'layout and restores yours when Guava is turned off. Log out to apply a new look across all apps.'),
    });

    group.add(comboRow(settings, {
        title: _('Side'),
        subtitle: _('Right is the GNOME side. Left is the macOS side'),
        key: 'window-controls-side',
        values: ['right', 'left'],
        labels: [_('Right'), _('Left')],
    }));

    group.add(comboRow(settings, {
        title: _('Buttons'),
        subtitle: _('Close only is the stock Fedora layout'),
        key: 'app-buttons-set',
        values: ['all', 'close'],
        labels: [_('Close, minimize and maximize'), _('Close only')],
    }));

    const style = comboRow(settings, {
        title: _('Look'),
        subtitle: _('macOS shows the traffic lights; GNOME keeps the stock look. Open apps pick up a new look when restarted'),
        key: 'app-buttons-style',
        values: ['macos', 'gnome'],
        labels: [_('macOS'), _('GNOME')],
    });
    group.add(style);

    group.add(comboRow(settings, {
        title: _('Traffic light size'),
        subtitle: _('Size of the macOS traffic lights'),
        key: 'button-size',
        values: ['small', 'normal'],
        labels: [_('Small'), _('Normal')],
    }));

    return [group];
}
