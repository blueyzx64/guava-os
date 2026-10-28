// SPDX-License-Identifier: GPL-3.0-or-later
// Text-cursor indicator preferences (macOS Sonoma). Adw only; prefs/pages/keyboard.js places them.

import Adw from 'gi://Adw';

import { switchRow, watchKey } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = extension?.gettext?.bind(extension) ?? (s => s);
    const group = new Adw.PreferencesGroup({
        title: _('Text Cursor'),
        description: _('A small badge at the text cursor, like macOS. It shows near the pointer in apps that do not report their cursor.'),
    });
    group.add(switchRow(settings, _('Text cursor indicators'), '', 'input-indicator'));
    const caps = switchRow(settings, _('Caps Lock'),
        _('Show ⇪ when Caps Lock is turned on or off'), 'input-indicator-caps-lock');
    const source = switchRow(settings, _('Input source'),
        _('Show the new input source when you switch it'), 'input-indicator-source');
    group.add(caps);
    group.add(source);
    const sync = () => {
        caps.sensitive = source.sensitive = settings.get_boolean('input-indicator');
    };
    sync();
    watchKey(settings, 'input-indicator', group, sync);
    return [group];
}
