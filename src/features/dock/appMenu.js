// SPDX-License-Identifier: GPL-3.0-or-later
// The right-click menu of a dock app icon, built from model.menuEntries() each time it opens.
// Holding Alt (Option) while it is open turns Quit into Force Quit, as on macOS.
//
// Shell API: ui/popupMenu.js (PopupMenu, PopupMenuItem, PopupSubMenuMenuItem, Ornament),
// ui/boxpointer.js PopupAnimation; checked on GNOME 50.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Glass } from '../../lib/glass.js';

const ARROW_SIDE = { bottom: St.Side.BOTTOM, left: St.Side.LEFT, right: St.Side.RIGHT };
const ALT_KEYS = [Clutter.KEY_Alt_L, Clutter.KEY_Alt_R, Clutter.KEY_Meta_L, Clutter.KEY_Meta_R];

export class DockMenu extends PopupMenu.PopupMenu {
    /**
     * @param {Clutter.Actor} source the icon it points at
     * @param {string} position dock position
     */
    constructor(source, position) {
        super(source, 0.5, ARROW_SIDE[position] ?? St.Side.BOTTOM);
        this.actor.add_style_class_name('guava-dock-menu');
        Main.uiGroup.add_child(this.actor);
        this.actor.hide();
        this._glass = Glass.attachMenu(this);
    }

    destroy() {
        this._glass?.destroy();
        this._glass = null;
        super.destroy();
    }

    popup() {
        this.open(BoxPointer.PopupAnimation.FULL);
    }
}

/**
 * Fill `menu` from menu entries.
 *
 * @param {DockMenu} menu
 * @param {object[]} entries model.menuEntries()
 * @param {object} on handlers: window(id), action(id), newWindow(), open(), keepInDock(on),
 *   openAtLogin(on), showInFiles(), showAllWindows(), quit(), forceQuit()
 * @param {(s: string) => string} _ gettext
 * @returns {{setAlt: (alt: boolean) => void}} relabels the Quit item live
 */
export function fillAppMenu(menu, entries, on, _) {
    menu.removeAll();
    let quitItem = null;
    let force = false;
    const add = (label, fn, ornament = PopupMenu.Ornament.NONE, sensitive = true) => {
        const item = new PopupMenu.PopupMenuItem(label);
        item.setOrnament(ornament);
        item.setSensitive(sensitive);
        item.connect('activate', () => fn());
        menu.addMenuItem(item);
        return item;
    };
    for (const e of entries) {
        switch (e.type) {
        case 'separator':
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            break;
        case 'window': {
            // The front window has a check mark; a minimized one the diamond (here a dot)
            const ornament = e.focused ? PopupMenu.Ornament.CHECK
                : e.minimized ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE;
            add(e.title || _('Untitled Window'), () => on.window(e.id), ornament);
            break;
        }
        case 'action':
            add(e.label, () => on.action(e.id));
            break;
        case 'new-window':
            add(_('New Window'), () => on.newWindow());
            break;
        case 'open':
            add(_('Open'), () => on.open());
            break;
        case 'options': {
            const sub = new PopupMenu.PopupSubMenuMenuItem(_('Options'));
            for (const o of e.items) {
                const check = o.checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;
                const labels = {
                    'keep-in-dock': [_('Keep in Dock'), () => on.keepInDock(!o.checked)],
                    'open-at-login': [_('Open at Login'), () => on.openAtLogin(!o.checked)],
                    'show-in-files': [_('Show in Files'), () => on.showInFiles()],
                };
                const [label, fn] = labels[o.type];
                const item = new PopupMenu.PopupMenuItem(label);
                item.setOrnament(o.type === 'show-in-files' ? PopupMenu.Ornament.NONE : check);
                item.setSensitive(o.sensitive);
                item.connect('activate', () => fn());
                sub.menu.addMenuItem(item);
            }
            menu.addMenuItem(sub);
            break;
        }
        case 'stop-background':
            add(_('Stop Running in Background'), () => on.stopBackground());
        case 'show-all-windows':
            add(_('Show All Windows'), () => on.showAllWindows());
            break;
        case 'quit':
        case 'force-quit':
            force = e.type === 'force-quit';
            quitItem = add(force ? _('Force Quit') : _('Quit'), () => (force ? on.forceQuit() : on.quit()));
            break;
        }
    }
    return {
        setAlt(alt) {
            if (!quitItem || force === alt)
                return;
            force = alt;
            quitItem.label.text = alt ? _('Force Quit') : _('Quit');
        },
    };
}

/** True when a key event is an Alt (Option) key. */
export const isAltKey = event => ALT_KEYS.includes(event.get_key_symbol());

/** True when Alt is held now (the pointer's modifier state). */
export function altHeld() {
    const [, , mods] = global.get_pointer();
    return (mods & Clutter.ModifierType.MOD1_MASK) !== 0;
}
