// SPDX-License-Identifier: GPL-3.0-or-later
// The optional Mission Control tile of the dock (dock-mission-control, off by default as on
// macOS). Its icon is drawn with St (a dark rounded square with three windows), so it sits
// among the full-colour app icons. A click opens or closes Mission Control, through the
// Mission Control feature when it runs, else GNOME's overview.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockItem } from './items.js';

export class MissionControlItem extends DockItem {
    constructor(host, spec) {
        super(host, spec, host.gettext('Mission Control'));
        const size = host.metrics.icon;
        this._icon = new St.Widget({
            style_class: 'guava-dock-mission-control',
            width: size, height: size,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._icon.set_style(`border-radius: ${Math.round(size * 0.22)}px;`);
        // Three windows: two side by side on top, a wide one below
        const unit = size / 16;
        const win = (x, y, w, h) => {
            const a = new St.Widget({ style_class: 'guava-dock-mission-control-window' });
            a.set_position(Math.round(x * unit), Math.round(y * unit));
            a.set_size(Math.round(w * unit), Math.round(h * unit));
            a.set_style(`border-radius: ${Math.max(1, Math.round(unit))}px;`);
            this._icon.add_child(a);
        };
        win(2.5, 3, 5, 4);
        win(8.5, 3, 5, 4);
        win(3.5, 8.5, 9, 4.5);
        this.content.add_child(this._icon);
    }

    get iconActor() {
        return this._icon;
    }

    activate() {
        const mc = this._host.missionControl();
        if (mc)
            mc.toggle();
        else
            Main.overview.toggle();
    }
}
