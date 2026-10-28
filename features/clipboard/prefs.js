// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard preferences. Adw/Gtk/Gio only (runs in the prefs process, no Shell libs).
// buildPrefs() returns the Adw.PreferencesGroup[]; prefs/pages/ places them on a page.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { shortcutRow, switchRow } from '../../prefs/widgets.js';






function _sizeRow(settings, _) {
    const row = new Adw.SpinRow({
        title: _('History size'),
        subtitle: _('Entries kept. Pinned items do not count and never expire.'),
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 500, step_increment: 1, page_increment: 5 }),
    });
    settings.bind('clipboard-history-size', row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function _excludedRow(settings, _) {
    const key = 'clipboard-excluded-apps';
    const row = new Adw.EntryRow({ title: _('Also ignore copies from these apps') });
    const parse = text => text.split(',').map(s => s.trim()).filter(Boolean);
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    row.text = settings.get_strv(key).join(', ');
    row.connect('changed', () => {
        const list = parse(row.text);
        if (!same(list, settings.get_strv(key)))
            settings.set_strv(key, list);
    });
    // Changed elsewhere (dconf, another window): show it, unless it is what we just typed
    const id = settings.connect(`changed::${key}`, () => {
        const list = settings.get_strv(key);
        if (!same(list, parse(row.text)))
            row.text = list.join(', ');
    });
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = extension?.gettext?.bind(extension) ?? (s => s);

    const main = new Adw.PreferencesGroup({
        title: _('Clipboard History'),
        description: _('Keeps what you copy so you can paste it again. Open it from the top bar or with the shortcut.'),
    });
    main.add(switchRow(settings, _('Clipboard history'),
        _('Record text, links, colours and images that you copy.'), 'clipboard-history'));
    main.add(switchRow(settings, _('Recording'),
        _('Turn off to pause without losing the history.'), 'clipboard-recording'));
    main.add(switchRow(settings, _('Show in the top bar'), '', 'clipboard-panel-icon'));
    main.add(switchRow(settings, _('Keep images'),
        _('Images over 5 MB are never kept.'), 'clipboard-images'));
    main.add(_sizeRow(settings, _));
    main.add(shortcutRow(settings, _, {
        key: 'clipboard-shortcut', title: _('Quick Paste shortcut'), example: '<Super><Shift>v',
        suggestion: { accel: '<Super><Shift>v', label: _('Use Super+Shift+V') },
    }));

    const privacy = new Adw.PreferencesGroup({
        title: _('Privacy'),
        description: _('Nothing is recorded while the screen is locked.'),
    });
    privacy.add(switchRow(settings, _('Save history to disk'),
        _('Kept in ~/.local/share/guava/clipboard/, readable only by you. Needed to keep history across lock and log out.'),
        'clipboard-persist'));
    privacy.add(switchRow(settings, _('Ignore passwords'),
        _('Skip copies marked as secret and copies from password managers.'), 'clipboard-ignore-sensitive'));
    privacy.add(_excludedRow(settings, _));

    return [main, privacy];
}
