// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshots preferences. Adw/Gtk/Gio only (runs in the prefs process, no Shell libs).
// buildPrefs() returns the Adw.PreferencesGroup[]; prefs/pages/ places them on a page.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { comboRow, shortcutRow, switchRow, watchKey } from '../../prefs/widgets.js';

const TIMERS = [0, 5, 10];

function folderRow(settings, _, window) {
    const key = 'screenshots-other-folder';
    const row = new Adw.ActionRow({ title: _('Other location'), activatable: true });
    const sync = () => {
        row.subtitle = settings.get_string(key) || _('Not chosen');
    };
    sync();
    watchKey(settings, key, row, sync);
    const choose = new Gtk.Button({ label: _('Choose…'), valign: Gtk.Align.CENTER });
    const pick = () => {
        const dialog = new Gtk.FileDialog({ title: _('Save Screenshots To'), modal: true });
        dialog.select_folder(window, null, (d, res) => {
            try {
                const file = d.select_folder_finish(res);
                if (file?.get_path()) {
                    settings.set_string(key, file.get_path());
                    settings.set_string('screenshots-save-to', 'other');
                }
            } catch {
                // Dismissed
            }
        });
    };
    choose.connect('clicked', pick);
    row.connect('activated', pick);
    row.add_suffix(choose);
    return row;
}

function timerRow(settings, _) {
    const key = 'screenshots-timer';
    const row = new Adw.ComboRow({
        title: _('Timer'),
        subtitle: _('Wait after Capture or Record in the toolbar'),
        model: Gtk.StringList.new([_('None'), _('5 seconds'), _('10 seconds')]),
    });
    const sync = () => {
        const i = TIMERS.indexOf(settings.get_int(key));
        row.selected = i < 0 ? 0 : i;
    };
    sync();
    row.connect('notify::selected', () => {
        const v = TIMERS[row.selected] ?? 0;
        if (v !== settings.get_int(key))
            settings.set_int(key, v);
    });
    watchKey(settings, key, row, sync);
    return row;
}

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, window, extension }) {
    const _ = s => extension.gettext(s);

    const main = new Adw.PreferencesGroup({
        title: _('Screenshots'),
        description: _('macOS capture shortcuts and the Shift+Super+5 toolbar, on GNOME\'s own screenshot tool. Print and GNOME\'s other shortcuts keep working.'),
    });
    main.add(switchRow(settings, _('macOS screenshots'), _('Shortcuts, toolbar and floating thumbnail'), 'screenshots'));
    main.add(shortcutRow(settings, _, { key: 'screenshots-shortcut-screen', title: _('Capture entire screen'), example: '<Shift><Super>3' }));
    main.add(shortcutRow(settings, _, { key: 'screenshots-shortcut-selection', title: _('Capture selection (Space: window)'), example: '<Shift><Super>4' }));
    main.add(shortcutRow(settings, _, { key: 'screenshots-shortcut-toolbar', title: _('Screenshot toolbar'), example: '<Shift><Super>5' }));

    const options = new Adw.PreferencesGroup({ title: _('Options') });
    options.add(comboRow(settings, {
        title: _('Save to'),
        subtitle: _('macOS saves to the Desktop; GNOME to Pictures/Screenshots'),
        key: 'screenshots-save-to',
        values: ['pictures', 'desktop', 'documents', 'clipboard', 'other'],
        labels: [_('Pictures/Screenshots'), _('Desktop'), _('Documents'), _('Clipboard only'), _('Other location')],
    }));
    options.add(folderRow(settings, _, window));
    options.add(timerRow(settings, _));
    options.add(switchRow(settings, _('Show floating thumbnail'),
        _('Saves after 5 seconds, or swipe it right. Click to open, right-click for more.'), 'screenshots-thumbnail'));
    options.add(switchRow(settings, _('Remember last selection'), '', 'screenshots-remember-selection'));
    options.add(switchRow(settings, _('Show mouse pointer'), '', 'screenshots-show-pointer'));
    options.add(switchRow(settings, _('Name files like macOS'), _('"Screenshot 2026-03-09 at 08.05.07"'), 'screenshots-macos-names'));

    const note = new Adw.PreferencesGroup({
        description: _('GNOME also copies every screenshot to the clipboard. The thumbnail cannot be dragged into apps: GNOME Shell cannot start a drag into app windows. Recordings use GNOME\'s recorder, which records no sound.'),
    });
    return [main, options, note];
}
