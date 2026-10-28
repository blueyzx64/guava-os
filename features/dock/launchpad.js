// SPDX-License-Identifier: GPL-3.0-or-later
// The Launchpad tile at the start of the dock (macOS). A click asks for Launchpad through the
// 'launchpad-requested' event (features/launchpad listens); the dock knows nothing else of it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { IconStyle } from '../../lib/iconStyle.js';
import { DockItem } from './items.js';

// Guava's own icon in icons/: a rounded square with a 3x3 grid of coloured app dots
const ICON = 'guava-launchpad.svg';

export class LaunchpadItem extends DockItem {
    constructor(host, spec) {
        super(host, spec, host.gettext('Launchpad'));
        const file = host.iconFile(ICON);
        this._icon = new St.Icon({
            gicon: file ? new Gio.FileIcon({ file }) : null,
            fallback_icon_name: 'view-app-grid-symbolic',
            icon_size: host.metrics.icon,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this.content.add_child(this._icon);
        const style = IconStyle.apply(this._icon);
        this.cleanup.add(() => style.destroy());
    }

    get iconActor() {
        return this._icon;
    }

    activate() {
        this._host.requestLaunchpad();
    }
}
