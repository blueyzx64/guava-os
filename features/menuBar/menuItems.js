// SPDX-License-Identifier: GPL-3.0-or-later
// Popup menu rows the logo menu and the app menus share: a label, a shortcut on the right
// (⌘ glyphs or words, see core/appMenus/model.js formatAccel) and a checkmark ornament.
// No icons, as in macOS 27 menus.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export { LazyMenu } from '../../lib/lazyMenu.js';

import { formatAccel } from '../../core/appMenus/model.js';

/**
 * @param {string} label
 * @param {object} [opts]
 * @param {?string} [opts.accel] GTK accelerator to show on the right
 * @param {{glyphs: boolean, ctrlIsCommand: boolean}} [opts.keys] how to write it
 * @param {boolean} [opts.enabled]
 * @param {?boolean} [opts.checked] true/false shows a check column; null none
 * @param {boolean} [opts.radio] a radio item: a dot instead of a checkmark
 * @param {Function} [opts.onActivate]
 * @returns {PopupMenu.PopupMenuItem}
 */
export function menuItem(label, { accel = null, keys = {}, enabled = true, checked = null, radio = false, onActivate = null } = {}) {
    const item = new PopupMenu.PopupMenuItem(label);
    item.add_style_class_name('guava-menubar-menu-item');
    const text = accel ? formatAccel(accel, keys) : '';
    if (text) {
        item.add_child(new St.Label({
            text, style_class: 'guava-menubar-accel',
            x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    if (checked !== null)
        item.setOrnament(!checked ? PopupMenu.Ornament.NONE : radio ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.CHECK);
    item.setSensitive(enabled);
    if (onActivate)
        item.connect('activate', () => onActivate());
    return item;
}

/** A small grey heading inside a menu ("Applications", "Documents"). */
export function menuHeading(text) {
    const item = new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false });
    item.add_style_class_name('guava-menubar-menu-heading');
    return item;
}
