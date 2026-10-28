// SPDX-License-Identifier: GPL-3.0-or-later
// Menu bar items: the right side of the macOS menu bar before Control Center and the clock.
//
//   manager.js  the item manager: order, hidden items, overflow chevron (menubar-item-order,
//               menubar-item-hidden, menubar-overflow); GNOME's input-source menu and the
//               AppIndicator extension's icons are managed too
//   host.js     the StatusNotifierItem host (menubar-status-items): apps' tray icons with
//               their DBusMenu menus (sniItem.js, dbusMenu.js); defers to the AppIndicator
//               extension when that is enabled
//   pinned.js   Control Center controls pinned to the bar (menubar-pinned)
//
// Every part puts what it makes into this feature's cleanup registry.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { MenuGlass } from '../../lib/menuGlass.js';
import { whenQuickSettingsReady } from '../../lib/quickSettings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { StatusItemHost } from './host.js';
import { BarManager } from './manager.js';
import { PinnedControls } from './pinned.js';

export class MenuBarItems {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._manager = null;
        this._host = null;
        this._pinned = null;
        this._handles = new Map();   // SniItem -> manager handle
    }

    /** The parts (tests, the harness). */
    get manager() {
        return this._manager;
    }

    get host() {
        return this._host;
    }

    get pinned() {
        return this._pinned;
    }

    enable() {
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(cleanup);

        this._manager = new BarManager(this._ctx, cleanup);
        this._manager.start();

        const glass = new MenuGlass(cleanup);
        this._host = new StatusItemHost(this._ctx, cleanup, {
            added: item => {
                let id = item.id;
                for (let n = 2; this._manager.item(id); n++)
                    id = `${item.id}-${n}`;
                item.id = id;
                Main.panel.addToStatusArea(`guava-sni-${item.bus}${item.path}`, item.button, 0, 'right');
                glass.add(item.button.menu);
                this._handles.set(item, this._manager.add(item));
            },
            changed: item => this._handles.get(item)?.changed(),
            removed: item => {
                this._handles.get(item)?.remove();
                this._handles.delete(item);
            },
            // The AppIndicator extension's icons come and go with the mode
            modeChanged: () => this._manager.queue(true),
        });
        this._host.start(ks.bool('menubar-status-items'));
        ks.watch('menubar-status-items', () => this._host.setEnabled(ks.bool('menubar-status-items')));

        this._pinned = new PinnedControls(this._ctx, cleanup, this._manager);
        whenQuickSettingsReady(cleanup, qs => this._pinned.start(qs), 'menu bar pinned controls');
        // Disposed first (newest first): no layout pass while the parts go
        cleanup.add(() => this._manager.stop());
    }

    disable() {
        // The cleanup registry stops the host, the pinned items and the manager (newest first)
    }
}
