// SPDX-License-Identifier: GPL-3.0-or-later
// Where volume and brightness changes show (osd-location). Adw/Gtk only (the prefs process).

import Adw from 'gi://Adw';

import { comboRow } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const group = new Adw.PreferencesGroup({
        title: _('Volume and Brightness'),
        description: _('macOS 26 shows them in a glass pill under the Control Center; with a notch they show in the notch'),
    });
    group.add(comboRow(settings, {
        title: _('Show Volume and Brightness In'),
        subtitle: _('The notch while it is on, or a glass pill under the menu bar like macOS'),
        key: 'osd-location', values: ['notch', 'menu-bar', 'system'],
        labels: [_('Notch'), _('Menu Bar'), _('Standard Pop-up')],
    }));
    return [group];
}
