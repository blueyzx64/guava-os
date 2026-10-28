// SPDX-License-Identifier: GPL-3.0-or-later
// A panel popup menu filled as it opens (the menu bar's menus, the status items).

import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * A popup menu that is filled just before it opens: PopupMenu.open() refuses an empty menu,
 * and the items are built only when needed (a closed menu bar holds no items).
 */
export class LazyMenu extends PopupMenu.PopupMenu {
    constructor(source, fill) {
        super(source, 0.0, St.Side.TOP);
        this._fillMenu = fill;
    }

    open(animate) {
        if (!this.isOpen)
            this._fillMenu(this);
        super.open(animate);
    }
}
