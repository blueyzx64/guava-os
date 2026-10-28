// SPDX-License-Identifier: GPL-3.0-or-later
// Tiles the Control Center adds to the stock grid.
//
// - The Guava module: one full-width card with a tile per Guava feature (notch, Stage Manager,
//   window buttons, clipboard, Spotlight, Liquid Glass), each bound to its key.
// - On GNOME 48 there is no stock Do Not Disturb toggle (49 moved it into Quick Settings),
//   so the Control Center builds one with the same binding GNOME 49 uses.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { QuickToggle } from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { guavaTiles } from './model.js';

const ICON_SIZE = 16;

/** An icon by name; Guava's own icons ship in icons/ (the Shell's icon theme does not know them). */
export function guavaGicon(name, extensionDir) {
    if (name.startsWith('guava-') && extensionDir)
        return new Gio.FileIcon({ file: extensionDir.get_child('icons').get_child(`${name}.svg`) });
    return new Gio.ThemedIcon({ name });
}

function _icon(name, extensionDir) {
    return new St.Icon({
        gicon: guavaGicon(name, extensionDir),
        fallback_icon_name: 'window-maximize-symbolic',
        icon_size: ICON_SIZE,
    });
}

/**
 * One Guava feature tile: an icon in a small circle, filled with the accent while the
 * feature's key is on. The button toggles the key both ways and never calls the feature:
 * the feature registry reacts to the key. Its name shows in the module header on hover or
 * keyboard focus (`onHint`).
 */
function _createTile({ settings, tile, gettext, extensionDir, onHint }) {
    const name = gettext(tile.label);
    const button = new St.Button({
        style_class: 'guava-cc-guava-tile',
        accessible_name: name,
        accessible_role: Atk.Role.TOGGLE_BUTTON,
        can_focus: true,
        track_hover: true,
        toggle_mode: true,
        x_align: Clutter.ActorAlign.CENTER,
        child: _icon(tile.icon, extensionDir),
    });
    settings.bind(tile.key, button, 'checked', Gio.SettingsBindFlags.DEFAULT);
    const hint = () => onHint(button.hover || button.has_key_focus() ? button : null, name);
    button.connect('notify::hover', hint);
    button.connect('key-focus-in', hint);
    button.connect('key-focus-out', hint);
    button.connect('notify::checked', hint);
    button.connect('destroy', () => {
        try {
            Gio.Settings.unbind(button, 'checked');
        } catch (_e) {
            // Already unbound with the object
        }
    });
    return button;
}

/**
 * The "Guava" module: a full-width rounded card, a caption and one row of icon circles, one
 * per Guava feature that can be switched on and off (see GUAVA_TOGGLES). The caption names
 * the feature under the pointer, so the row itself needs no labels. Null when the schema
 * has none of the keys.
 *
 * @param {object} opts
 * @param {Gio.Settings} opts.settings Guava settings
 * @param {Function} opts.gettext
 * @param {Gio.File} [opts.extensionDir] for Guava's own icons
 * @returns {St.Widget|null}
 */
export function createGuavaModule({ settings, gettext, extensionDir }) {
    const schema = settings.settings_schema;
    const tiles = guavaTiles(key => !!schema?.has_key(key));
    if (!tiles.length)
        return null;

    const head = new St.BoxLayout({ style_class: 'guava-cc-guava-head', x_expand: true });
    head.add_child(new St.Label({ style_class: 'guava-cc-module-title', text: 'Guava', x_expand: true }));
    const hintLabel = new St.Label({
        style_class: 'guava-cc-guava-hint',
        y_align: Clutter.ActorAlign.CENTER,
    });
    hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    head.add_child(hintLabel);
    let hinted = null;
    const onHint = (button, name) => {
        if (!button && hinted && (hinted.hover || hinted.has_key_focus()))
            return;
        hinted = button;
        hintLabel.text = button
            ? `${name} · ${button.checked ? gettext('On') : gettext('Off')}`
            : '';
    };

    const layout = new Clutter.GridLayout({
        column_homogeneous: true,
        column_spacing: 2,
        row_spacing: 8,
    });
    const grid = new St.Widget({
        style_class: 'guava-cc-guava-grid',
        layout_manager: layout,
        x_expand: true,
    });
    for (const tile of tiles) {
        layout.attach(_createTile({ settings, tile, gettext, extensionDir, onHint }),
            tile.column, tile.row, 1, 1);
    }

    const module = new St.BoxLayout({
        style_class: 'guava-cc-module guava-cc-guava',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });
    module.add_child(head);
    module.add_child(grid);
    return module;
}

/** GNOME 49's Do Not Disturb toggle, for GNOME 48. Checked means banners are off. */
export function createDndToggle(gettext) {
    const notifications = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
    const toggle = new QuickToggle({
        title: gettext('Do Not Disturb'),
        iconName: 'notifications-disabled-symbolic',
        toggleMode: true,
    });
    notifications.bind('show-banners', toggle, 'checked', Gio.SettingsBindFlags.INVERT_BOOLEAN);
    toggle.connect('destroy', () => {
        try {
            Gio.Settings.unbind(toggle, 'checked');
        } catch (_e) {
            // Already unbound with the object
        }
    });
    return toggle;
}
