// SPDX-License-Identifier: GPL-3.0-or-later
// Emoji & Symbols preferences. Adw only; prefs/pages/keyboard.js places them.

import Adw from 'gi://Adw';

import { shortcutRow, switchRow } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = extension?.gettext?.bind(extension) ?? (s => s);
    const group = new Adw.PreferencesGroup({
        title: _('Emoji & Symbols'),
        description: _('A searchable emoji popover at the text cursor. The emoji is typed into the app you were in. Uses the emoji names IBus provides.'),
    });
    group.add(switchRow(settings, _('Emoji & Symbols'), '', 'emoji-picker'));
    group.add(shortcutRow(settings, _, {
        key: 'emoji-shortcut', title: _('Shortcut'), example: '<Control><Super>space',
        suggestion: { accel: '<Control><Super>space', label: _('Use Ctrl+Super+Space') },
    }));
    return [group];
}
