// SPDX-License-Identifier: GPL-3.0-or-later
// Guava's Do Not Disturb (features.js `dnd-button`, key custom-dnd-button): a moon button in the
// Quick Settings footer and a moon among the top-bar icons while it is on, in place of GNOME's
// own toggle and indicators (dndSuppression.js). The state is the one NotificationRouter shares
// with the notch (org.gnome.desktop.notifications show-banners). Off while the Control Center
// runs: it has its own Do Not Disturb tile (conflictsWith in features.js).
//
// Private Shell API: quickSettings._system._systemItem.child, ._indicators (48-51).

import Gio from 'gi://Gio';
import St from 'gi://St';

import { NotificationRouter } from '../../core/notificationRouter.js';
import { whenQuickSettingsReady } from '../../lib/quickSettings.js';
import { hideDateMenuIndicator, suppressDndIndicator, suppressDndToggle } from './dndSuppression.js';

const ICON = 'icons/moon-fill-symbolic.svg';
const ICON_SIZE = 16;

export class DndButton {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ = ctx.gettext ?? (s => s);
        this._button = null;
        this._moon = null;
    }

    enable() {
        whenQuickSettingsReady(this._cleanup, qs => this._build(qs), 'Do Not Disturb button');
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    _gicon() {
        return Gio.FileIcon.new(this._ctx.extension.dir.get_child(ICON));
    }

    _build(qs) {
        const cleanup = this._cleanup;
        for (const undo of [suppressDndToggle(), suppressDndIndicator(), hideDateMenuIndicator()]) {
            if (undo)
                cleanup.add(undo);
        }

        // The footer button copies the look of its neighbours
        const footer = qs._system._systemItem.child;
        const template = footer.get_children().find(b => b.style_class);
        const iconStyle = template?.get_children().find(c => c instanceof St.Icon)?.style_class ?? 'system-status-icon';
        this._button = cleanup.actor(new St.Button({
            style_class: `${template?.style_class ?? 'system-menu-action'} guava-dnd-button`,
            can_focus: true,
            track_hover: true,
            toggle_mode: true,
            accessible_name: this._('Do Not Disturb'),
            child: new St.Icon({ gicon: this._gicon(), icon_size: ICON_SIZE, style_class: `${iconStyle} guava-dnd-icon` }),
        }));
        cleanup.connect(this._button, 'clicked', () => NotificationRouter.setDnd(!NotificationRouter.state().dnd));
        const lock = footer.get_children().find(c => c.constructor.name === 'LockItem');
        if (lock)
            footer.insert_child_below(this._button, lock);
        else
            footer.add_child(this._button);

        this._moon = cleanup.actor(new St.Icon({
            gicon: this._gicon(),
            style_class: 'system-status-icon guava-dnd-indicator',
            visible: false,
            accessible_name: this._('Do Not Disturb Indicator'),
        }));
        qs._indicators.add_child(this._moon);

        NotificationRouter.connect(cleanup, state => this._sync(state));
        this._sync(NotificationRouter.state());
    }

    _sync({ dnd }) {
        if (this._button && this._button.checked !== dnd)
            this._button.checked = dnd;
        if (this._moon)
            this._moon.visible = dnd;
    }
}
