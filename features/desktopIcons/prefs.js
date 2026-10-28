// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop icon preferences. Adw/Gtk/Gio only (runs in the prefs process).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { comboRow, switchRow, watchKey } from '../../prefs/widgets.js';
import { SORTS, dingEnabled } from './model.js';

const SHELL_SCHEMA = 'org.gnome.shell';

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);
    const group = new Adw.PreferencesGroup({
        title: _('Desktop Icons'),
        description: _('The files and folders of your Desktop folder, as large icons from the top-right corner of the desktop. Click to select, double-click to open, drag to rearrange, and right-click for Rename, Move to Trash and more.'),
    });

    // Another extension drawing the icons (Desktop Icons NG) wins: Guava steps aside and says so
    const ding = new Adw.ActionRow({
        title: _('Desktop Icons NG is enabled'),
        subtitle: _('Guava does not draw desktop icons while that extension runs. Turn it off to use Guava’s icons.'),
    });
    ding.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
    group.add(ding);

    const on = switchRow(settings, _('Show icons on the desktop'), null, 'desktop-icons');
    group.add(on);

    const size = new Adw.SpinRow({
        title: _('Icon size'),
        subtitle: _('In pixels. 64 is the macOS default.'),
        adjustment: new Gtk.Adjustment({ lower: 32, upper: 128, step_increment: 8, page_increment: 16 }),
    });
    settings.bind('desktop-icons-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(size);

    const drives = switchRow(settings, _('Show mounted drives'),
        _('USB sticks, memory cards and discs appear on the desktop. Eject them from their menu.'),
        'desktop-icons-show-drives');
    group.add(drives);

    const labels = {
        'none': _('None'), 'name': _('Name'), 'kind': _('Kind'), 'date-modified': _('Date Modified'),
        'date-created': _('Date Created'), 'size': _('Size'),
    };
    const sort = comboRow(settings, {
        title: _('Sort by'),
        subtitle: _('None keeps icons where you put them. Dragging an icon sets it back to None.'),
        key: 'desktop-icons-sort',
        values: [...SORTS],
        labels: SORTS.map(s => labels[s]),
    });
    group.add(sort);

    const shell = Gio.SettingsSchemaSource.get_default()?.lookup(SHELL_SCHEMA, true)
        ? new Gio.Settings({ schema_id: SHELL_SCHEMA }) : null;
    const sync = () => {
        const blocked = !!shell && dingEnabled(shell.get_strv('enabled-extensions'), shell.get_boolean('disable-user-extensions'));
        ding.visible = blocked;
        const enabled = settings.get_boolean('desktop-icons');
        size.sensitive = drives.sensitive = sort.sensitive = enabled && !blocked;
    };
    watchKey(settings, 'desktop-icons', group, sync);
    if (shell) {
        for (const key of ['enabled-extensions', 'disable-user-extensions'])
            watchKey(shell, key, group, sync);
    }
    sync();
    return [group];
}
