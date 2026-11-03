// SPDX-License-Identifier: GPL-3.0-or-later
// Add items to the wallpaper's right-click menu (Change Background…, Display Settings, Settings).
//
//   addBackgroundMenuItems(cleanup, (menu, at) => [item, ...]);   // build() adds to `menu`, returns the items
//
// `at.front` is the top of the menu and `at.afterStock` the place after the Shell's first item
// (Change Background…), past the items other Guava features put in front, so features that add
// in either place keep their order whichever of them is added first.
//
// The Shell builds one menu per monitor and rebuilds them after a monitor change; the items are
// added again then, and removed when `cleanup` is disposed.
//
// Shell API (private, checked on 50.6): Main.layoutManager._bgManagers[i].backgroundActor
// ._backgroundMenu (js/ui/backgroundMenu.js), BackgroundManager 'changed'.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from './disposables.js';

/**
 * @param {{add: Function, connect: Function, idle: Function}} cleanup
 * @param {(menu: object, at: {front: number, afterStock: number}) => object[]} build adds its
 *   items to the PopupMenu and returns them
 */
export function addBackgroundMenuItems(cleanup, build) {
    const added = new CleanupRegistry();
    cleanup.add(() => added.dispose());
    const addAll = () => {
        added.dispose();
        for (const bgm of Main.layoutManager._bgManagers ?? []) {
            added.connect(bgm, 'changed', () => cleanup.idle(addAll, { name: 'guava-background-menu' }));
            const menu = bgm.backgroundActor?._backgroundMenu;
            if (!menu)
                continue;
            const stock = menu._getMenuItems().findIndex(i => !i._guavaBackgroundItem);
            for (const item of build(menu, { front: 0, afterStock: Math.max(0, stock) + 1 })) {
                item._guavaBackgroundItem = true;
                // The Shell destroys the menu with its background actor, and the items with it
                let gone = false;
                item.connect('destroy', () => {
                    gone = true;
                });
                added.add(() => {
                    if (!gone)
                        item.destroy();
                });
            }
        }
    };
    // The Shell rebuilds the background actors (and their menus) after a monitor change
    cleanup.connect(Main.layoutManager, 'monitors-changed', () => cleanup.idle(addAll, { name: 'guava-background-menu' }));
    addAll();
}
