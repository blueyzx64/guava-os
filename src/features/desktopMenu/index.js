// SPDX-License-Identifier: GPL-3.0-or-later
// The desktop's right-click menu: "Show Desktop Icons" and "Show Widgets" switches. Both features
// are off by default and have no Preferences rows; this is where they are turned on and off.
// Always running (no setting): the switches must be there while both features are off.
//
// Shell API: lib/backgroundMenu.js (the wallpaper's menu), PopupMenu.PopupSwitchMenuItem.

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { addBackgroundMenuItems } from '../../lib/backgroundMenu.js';

const TOGGLES = [
    { key: 'desktop-icons', label: 'Show Desktop Icons' },
    { key: 'widgets', label: 'Show Widgets' },
];

export class DesktopMenu {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        const { settings, gettext: _ } = this._ctx;
        addBackgroundMenuItems(this._cleanup, menu => {
            const items = [new PopupMenu.PopupSeparatorMenuItem()];
            for (const { key, label } of TOGGLES) {
                const item = new PopupMenu.PopupSwitchMenuItem(_(label), settings.get_boolean(key));
                item.connect('toggled', (_i, state) => settings.set_boolean(key, state));
                // Changed elsewhere (another monitor's menu, gsettings): follow it
                const id = settings.connect(`changed::${key}`, () => item.setToggleState(settings.get_boolean(key)));
                item.connect('destroy', () => settings.disconnect(id));
                items.push(item);
            }
            // At the end of the menu, after the Shell's Display Settings and Settings
            for (const item of items)
                menu.addMenuItem(item);
            return items;
        });
    }

    disable() {
        // Everything is in the cleanup registry (lib/backgroundMenu.js removes the items)
    }
}
