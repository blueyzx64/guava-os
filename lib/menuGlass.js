// SPDX-License-Identifier: GPL-3.0-or-later
// Faux glass on Guava's own panel menus (logo, app menus, privacy, status items), the same look the
// liquid-glass feature gives the Control Center and the calendar: Glass.attachMenu() while
// the "menus" glass surface is on, nothing otherwise.

import { Glass } from './glass.js';

export class MenuGlass {
    /** @param {CleanupRegistry} cleanup the part's registry */
    constructor(cleanup) {
        this._cleanup = cleanup;
        this._menus = new Map(); // PopupMenu -> handle | null
        cleanup.add(() => {
            for (const handle of this._menus.values())
                handle?.destroy();
            this._menus.clear();
        });
        Glass.watch(cleanup, () => this._sync());
    }

    /** Give a menu glass for as long as it lives. */
    add(menu) {
        if (this._menus.has(menu))
            return;
        this._menus.set(menu, null);
        this._cleanup.connect(menu, 'destroy', () => this._menus.delete(menu));
        this._sync();
    }

    _sync() {
        const wanted = Glass.wants('menus');
        for (const [menu, handle] of this._menus) {
            if (wanted && !handle)
                this._menus.set(menu, Glass.attachMenu(menu));
            else if (!wanted && handle) {
                handle.destroy();
                this._menus.set(menu, null);
            } else {
                handle?.refresh();
            }
        }
    }
}
