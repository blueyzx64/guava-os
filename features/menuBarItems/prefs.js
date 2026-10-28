// SPDX-License-Identifier: GPL-3.0-or-later
// Menu bar items preferences (macOS Tahoe's Menu Bar pane): app status icons, controls shown
// in the menu bar, and the order and visibility of every item. Adw/Gtk/Gio only.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { switchRow, watchKey } from '../../prefs/widgets.js';
import { PINNABLE, pinMode, setPin } from '../../lib/menuBarPins.js';
import { barOrder, moveItem, parseRegistry } from './model.js';

/**
 * @param {{settings: Gio.Settings, _: Function}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const items = new Adw.PreferencesGroup({
        title: _('Menu Bar Items'),
        description: _("Apps' status icons and Control Center controls on the right of the menu bar. When the AppIndicator extension is enabled it draws the app icons, and Guava only orders and hides them."),
    });
    items.add(switchRow(settings, _('App Status Icons'),
        _('Tray icons of apps such as Discord, Steam or Nextcloud, with their menus'), 'menubar-status-items'));
    items.add(switchRow(settings, _('Collapse When Crowded'),
        _('Items that do not fit beside the notch go behind a chevron'), 'menubar-overflow'));

    const pins = new Adw.PreferencesGroup({
        title: _('Show in Menu Bar'),
        description: _('Control Center controls that also get their own menu bar item. They open the same control as a menu.'),
    });
    for (const p of PINNABLE) {
        const values = p.active ? ['never', 'active', 'always'] : ['never', 'always'];
        const labels = p.active ? [_('Never'), _(p.active), _('Always')] : [_('Never'), _('Always')];
        const row = new Adw.ComboRow({ title: _(p.title), model: Gtk.StringList.new(labels) });
        const sync = () => {
            const i = values.indexOf(pinMode(settings.get_strv('menubar-pinned'), p.id));
            if (row.selected !== Math.max(0, i))
                row.selected = Math.max(0, i);
        };
        sync();
        row.connect('notify::selected', () => {
            const mode = values[row.selected];
            const now = settings.get_strv('menubar-pinned');
            if (mode && pinMode(now, p.id) !== mode)
                settings.set_strv('menubar-pinned', setPin(now, p.id, mode));
        });
        watchKey(settings, 'menubar-pinned', row, sync);
        pins.add(row);
    }
    pins.add(switchRow(settings, _('Battery Percentage'),
        _('Show the charge next to the Battery item'), 'menubar-battery-percentage'));

    return [items, pins, orderGroup(settings, _)];
}

/** Every item Guava has seen, in bar order, with a Show switch and move buttons. */
function orderGroup(settings, _) {
    const group = new Adw.PreferencesGroup({
        title: _('Item Order'),
        description: _('Left to right. Items appear here once they have been in the menu bar.'),
    });
    let rows = [];
    let syncing = false;
    const rebuild = () => {
        if (syncing)
            return;
        rows.forEach(r => group.remove(r));
        rows = [];
        const known = parseRegistry(settings.get_strv('menubar-item-registry'));
        const order = barOrder(settings.get_strv('menubar-item-order'), known.map(k => k.id));
        const hidden = new Set(settings.get_strv('menubar-item-hidden'));
        const titles = new Map(known.map(k => [k.id, k.title]));
        if (!order.length) {
            const empty = new Adw.ActionRow({ title: _('No items yet'), subtitle: _('Pin a control above, or start an app with a status icon') });
            group.add(empty);
            rows.push(empty);
            return;
        }
        order.forEach((id, i) => {
            const row = new Adw.SwitchRow({ title: titles.get(id) ?? id, subtitle: kindOf(id, _), active: !hidden.has(id) });
            row.connect('notify::active', () => {
                const set = new Set(settings.get_strv('menubar-item-hidden'));
                if (row.active)
                    set.delete(id);
                else
                    set.add(id);
                syncing = true;
                settings.set_strv('menubar-item-hidden', [...set]);
                syncing = false;
            });
            for (const [icon, delta, name] of [['go-up-symbolic', -1, _('Move Left')], ['go-down-symbolic', 1, _('Move Right')]]) {
                const button = new Gtk.Button({
                    icon_name: icon, valign: Gtk.Align.CENTER, tooltip_text: name,
                    sensitive: delta < 0 ? i > 0 : i < order.length - 1,
                    css_classes: ['flat'],
                });
                button.update_property([Gtk.AccessibleProperty.LABEL], [name]);
                button.connect('clicked', () => settings.set_strv('menubar-item-order', moveItem(order, id, delta)));
                row.add_prefix(button);
            }
            group.add(row);
            rows.push(row);
        });
    };
    rebuild();
    for (const key of ['menubar-item-registry', 'menubar-item-order', 'menubar-item-hidden'])
        watchKey(settings, key, group, rebuild);
    return group;
}

function kindOf(id, _) {
    if (id.startsWith('pin:'))
        return _('Control Center control');
    if (id.startsWith('stock:'))
        return _('GNOME (the input-source menu shows with two or more input sources)');
    return _('App status icon');
}
