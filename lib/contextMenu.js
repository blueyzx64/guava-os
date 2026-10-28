// SPDX-License-Identifier: GPL-3.0-or-later
// A context menu at a pointer position, with Guava's glass look, that cleans up after itself.
//
//   this._menu = openContextMenu(cleanup, {
//       source: layer.actor,                 // the actor that owns the menu (its PopupMenuManager)
//       coords: event.get_coords(),
//       styleClass: 'guava-widgets-menu',
//       build: menu => { menu.addAction(_('Open'), () => ...); },
//   });
//   this._menu.dispose();                    // closes it (also called when it closes by itself)
//
// Shell API: Main.layoutManager.dummyCursor, PopupMenu.PopupMenu, PopupMenuManager.

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { CleanupRegistry } from './disposables.js';
import { Glass } from './glass.js';

/**
 * @param {{idle: Function}} cleanup the owner's registry (the menu closing schedules its teardown here)
 * @param {{source: Clutter.Actor, coords: number[], styleClass: string, build: (menu: PopupMenu.PopupMenu) => void,
 *   onClosed?: (reg: CleanupRegistry) => void}} spec
 * @returns {CleanupRegistry} dispose() destroys the menu
 */
export function openContextMenu(cleanup, { source, coords: [x, y], styleClass, build, onClosed = () => {} }) {
    Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
    const menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
    menu.actor.add_style_class_name(styleClass);
    Main.uiGroup.add_child(menu.actor);
    const manager = new PopupMenu.PopupMenuManager(source);
    manager.addMenu(menu);
    const glass = Glass.attachMenu(menu);
    const reg = new CleanupRegistry();
    reg.add(() => {
        glass.destroy();
        menu.destroy();
    });
    build(menu);
    // Teardown after the click that closed it is handled
    reg.connect(menu, 'open-state-changed', (_m, open) => {
        if (!open)
            cleanup.idle(() => onClosed(reg), { name: 'guava-context-menu' });
    });
    menu.open(true);
    return reg;
}
