// SPDX-License-Identifier: GPL-3.0-or-later
// Dock preferences (macOS "Desktop & Dock"). Adw/Gtk/Gio only (the prefs process).
// buildPrefs() returns the groups; prefs/pages/dock.js places them on the Dock page.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { comboRow, switchRow, watchKey } from '../../prefs/widgets.js';

/** A spin row bound to an integer key. */
function spinRow(settings, { key, title, subtitle, lower, upper, step }) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step, page_increment: step * 4 }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A slider bound to an integer key, with the values at both ends as marks. */
function scaleRow(settings, { key, title, subtitle, lower, upper, labels }) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle ?? '' });
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: 4, page_increment: 16 }),
        draw_value: false, hexpand: true, valign: Gtk.Align.CENTER, width_request: 220,
    });
    scale.add_mark(lower, Gtk.PositionType.BOTTOM, labels[0]);
    scale.add_mark(upper, Gtk.PositionType.BOTTOM, labels[1]);
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

/** Folder stacks: the folders kept in the dock, with Add and Remove. */
function foldersGroup(settings, _) {
    const group = new Adw.PreferencesGroup({
        title: _('Folder Stacks'),
        description: _('Folders kept on the right side of the Dock, beside Downloads. You can also drag a folder from a stack onto that side.'),
    });
    const add = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Add Folder…') });
    add.add_css_class('flat');
    add.update_property([Gtk.AccessibleProperty.LABEL], [_('Add Folder…')]);
    group.set_header_suffix(add);
    let rows = [];
    const sync = () => {
        rows.forEach(r => group.remove(r));
        rows = settings.get_strv('dock-folders').map(path => {
            const row = new Adw.ActionRow({ title: GLib.path_get_basename(path), subtitle: path });
            row.add_prefix(new Gtk.Image({ icon_name: 'folder-symbolic' }));
            const remove = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Remove from Dock') });
            remove.add_css_class('flat');
            remove.update_property([Gtk.AccessibleProperty.LABEL], [_('Remove from Dock')]);
            remove.connect('clicked', () =>
                settings.set_strv('dock-folders', settings.get_strv('dock-folders').filter(p => p !== path)));
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
    };
    add.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({ title: _('Add Folder to the Dock') });
        dialog.select_folder(add.get_root(), null, (d, res) => {
            let folder = null;
            try {
                folder = d.select_folder_finish(res);
            } catch (_e) {
                return;   // dismissed
            }
            const path = folder?.get_path();
            const folders = settings.get_strv('dock-folders');
            if (path && !folders.includes(path))
                settings.set_strv('dock-folders', [...folders, path]);
        });
    });
    watchKey(settings, 'dock-folders', group, sync);
    sync();
    return group;
}

/**
 * @param {{settings: Gio.Settings, _: Function}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const dock = new Adw.PreferencesGroup({
        title: _('Dock'),
        description: _('Pinned apps are your GNOME favourites. Dash to Dock is turned off while Guava’s dock runs and turned back on when it stops.'),
    });
    dock.add(switchRow(settings, _('Show the Dock'), _('Guava’s own dock with your apps, Downloads and the Trash'), 'dock'));
    dock.add(spinRow(settings, {
        key: 'dock-icon-size', title: _('Size'), subtitle: _('Icon size in pixels'), lower: 24, upper: 128, step: 4,
    }));
    const magnification = switchRow(settings, _('Magnification'), _('Icons under the pointer grow'), 'dock-magnification');
    dock.add(magnification);
    const magnifiedSize = scaleRow(settings, {
        key: 'dock-magnification-size', title: _('Magnified size'), lower: 24, upper: 160,
        labels: [_('Small'), _('Large')],
    });
    settings.bind('dock-magnification', magnifiedSize, 'sensitive', Gio.SettingsBindFlags.GET);
    dock.add(magnifiedSize);
    dock.add(comboRow(settings, {
        title: _('Position on screen'), key: 'dock-position',
        values: ['left', 'bottom', 'right'], labels: [_('Left'), _('Bottom'), _('Right')],
    }));
    dock.add(comboRow(settings, {
        title: _('Minimize windows using'), key: 'dock-minimize-effect',
        subtitle: _('With Reduce Motion on, windows fade instead'),
        values: ['genie', 'scale', 'gnome'], labels: [_('Genie Effect'), _('Scale Effect'), _('GNOME Effect')],
    }));

    const behaviour = new Adw.PreferencesGroup({ title: _('Behaviour') });
    const autohide = switchRow(settings, _('Automatically hide and show the Dock'),
        _('Rest the pointer on the screen edge, or push against it, to show the dock'), 'dock-autohide');
    behaviour.add(autohide);
    const delay = spinRow(settings, {
        key: 'dock-autohide-delay', title: _('Reveal delay'), subtitle: _('Milliseconds the pointer rests on the edge'),
        lower: 0, upper: 2000, step: 50,
    });
    settings.bind('dock-autohide', delay, 'sensitive', Gio.SettingsBindFlags.GET);
    behaviour.add(delay);
    behaviour.add(switchRow(settings, _('Animate opening applications'), _('The icon bounces while the app starts'), 'dock-launch-animation'));
    behaviour.add(switchRow(settings, _('Bounce when apps need attention'), null, 'dock-attention-bounce'));
    behaviour.add(switchRow(settings, _('Show indicators for open applications'), null, 'dock-running-dots'));
    behaviour.add(switchRow(settings, _('Show apps running in the background'),
        _('A grey indicator for apps with no window that keep running'), 'dock-background-apps'));
    behaviour.add(switchRow(settings, _('Show badges on app icons'),
        _('Counts and progress that apps publish'), 'dock-badges'));
    behaviour.add(switchRow(settings, _('Show suggested and recent apps in Dock'),
        _('Up to three recent apps that are not pinned, in their own section'), 'dock-show-recents'));
    behaviour.add(switchRow(settings, _('Minimize windows into application icon'),
        _('Off: each minimized window gets its own tile beside the Downloads stack'), 'dock-minimize-to-app'));

    const downloads = new Adw.PreferencesGroup({ title: _('Downloads Stack') });
    downloads.add(switchRow(settings, _('Show Downloads in the Dock'), _('Your newest downloads, before the Trash'), 'dock-downloads'));
    const view = comboRow(settings, {
        title: _('View content as'), key: 'dock-downloads-view',
        values: ['automatic', 'fan', 'grid', 'list'], labels: [_('Automatic'), _('Fan'), _('Grid'), _('List')],
    });
    settings.bind('dock-downloads', view, 'sensitive', Gio.SettingsBindFlags.GET);
    downloads.add(view);

    return [dock, behaviour, downloads, foldersGroup(settings, _)];
}
