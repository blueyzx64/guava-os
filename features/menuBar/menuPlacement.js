// SPDX-License-Identifier: GPL-3.0-or-later
// Where the bar's menus open. macOS drops a menu straight under the item that was clicked,
// its leading edge on the item's leading edge (right edge in right-to-left), and only slides
// sideways when the screen edge is in the way. GNOME centres the menu on the item, the Control
// Center, the logo and the app menus each pick their own arrow alignment, and the box pointer
// adds the item's place in its parent to the content box, so the menus sit a few pixels off
// from where the click was.
//
// Every menu of the bar goes through Main.panel.menuManager.addMenu (GNOME's indicators, the
// Control Center, the clock, Guava's logo, app menus, clipboard and the rest), so this one
// place covers them all, also the ones added later. The box pointer still clamps to the
// monitor on its own. Its class guava-bar-menu (style.css) drops the arrow's room: with no
// arrow the menu starts a small, fixed gap under the bar.
//
// Private Shell API: PopupMenuManager._menus (the menus themselves), PopupMenu._arrowAlignment,
// BoxPointer._sourceAlignment (same in 48-51).

import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { leadingAlignment } from './model.js';

const MENU_CLASS = 'guava-bar-menu';

export class MenuPlacement {
    constructor(cleanup) {
        this._cleanup = cleanup;
        this._saved = new Map();   // PopupMenu -> {source, arrow} to give back
        this._rtl = false;
    }

    start() {
        const manager = Main.panel.menuManager;
        this._rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;

        const addMenu = manager.addMenu;
        manager.addMenu = (menu, position) => {
            addMenu.call(manager, menu, position);
            this._place(menu);
        };
        this._cleanup.add(() => delete manager.addMenu);   // back to the prototype's
        for (const menu of manager._menus ?? [])
            this._place(menu);
    }

    _place(menu) {
        const pointer = menu._boxPointer;
        if (!pointer || this._saved.has(menu))
            return;
        this._saved.set(menu, { source: pointer._sourceAlignment, arrow: menu._arrowAlignment });
        // PopupMenu.open hands its own arrow alignment to the box pointer each time
        menu._arrowAlignment = this._rtl ? 1 : 0;
        pointer.add_style_class_name(MENU_CLASS);
        this._cleanup.connect(menu, 'open-state-changed', (_m, open) => open && this._align(menu));
        const forget = () => this._saved.delete(menu);
        this._cleanup.connect(menu, 'destroy', forget);
        this._cleanup.connect(pointer, 'destroy', forget);   // the owner may destroy just the actors
        // Registered after the destroy handlers: disposal runs this first, and a menu that is
        // already gone is no longer in the map
        this._cleanup.add(() => this._restore(menu));
    }

    _restore(menu) {
        const saved = this._saved.get(menu);
        if (!saved)
            return;
        this._saved.delete(menu);
        menu._arrowAlignment = saved.arrow;
        menu._boxPointer.setSourceAlignment(saved.source);
        menu._boxPointer.remove_style_class_name(MENU_CLASS);
    }

    // The item's size changes (the app name), so measure when the menu opens
    _align(menu) {
        const source = menu.sourceActor;
        const node = source?.get_theme_node?.();
        let width = 0, contentStart = 0, contentWidth = 0;
        if (node) {
            // The box pointer's own reading of the content box (boxpointer.js _reposition)
            const allocation = source.get_allocation_box();
            const box = node.get_content_box(allocation);
            width = allocation.get_width();
            contentStart = box.x1;
            contentWidth = box.x2 - box.x1;
        }
        // setSourceAlignment() clamps to 0..1, the correction lies outside
        const pointer = menu._boxPointer;
        pointer._sourceAlignment = leadingAlignment({ rtl: this._rtl, width, contentStart, contentWidth });
        pointer.queue_relayout();
    }
}
