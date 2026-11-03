// SPDX-License-Identifier: GPL-3.0-or-later
// The calendar (features.js `calendar`): the date menu moves to the right end of the top bar,
// macOS-style, and is restyled as a calendar card. Its notification column moves to Quick
// Settings (notificationList.js) unless keep-notification-panel is on. A dot next to the
// Quick Settings icons (or the clock) shows that notifications are waiting.
//
// Private Shell API: Main.panel._centerBox/_rightBox, dateMenu._messageList, ._calendar,
// ._clocksItem, ._weatherItem, quickSettings._indicators (same in 48-51).

import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NotificationRouter } from '../../core/notificationRouter.js';
import { Glass } from '../../lib/glass.js';
import { keepHidden } from '../../lib/keepHidden.js';
import { GuavaSettings } from '../../lib/settings.js';
import { indicatorStyle, menuWidth } from './model.js';

// The macOS-like calendar card: style.css restyles the date menu under these classes
const CARD_CLASS = 'guava-datemenu';
const CARD_CALM_CLASS = 'guava-datemenu-calm';      // not under high contrast
const CARD_LIGHT_CLASS = 'guava-datemenu-light';
const DOT_ICON = 'icons/message-indicator-symbolic.svg';

export class Calendar {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._dot = null;
    }

    enable() {
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(cleanup);
        const dateMenu = Main.panel.statusArea.dateMenu;

        this._moveDateMenu(dateMenu);
        if (!ks.bool('keep-notification-panel'))
            this._hideMessageList(dateMenu);
        this._styleCard(dateMenu);

        // Banner position belongs to NotificationRouter (the notch may take the banners over).
        // Pinned top-right in both modes, under the clock.
        NotificationRouter.pinBanners(cleanup);

        this._addDot(dateMenu, ks.bool('keep-notification-panel'));
        ks.watch('notification-indicator-style', () => this._styleDot(ks));
        this._styleDot(ks);
        // The dot follows the shared notification state: no polling, no per-source handlers
        NotificationRouter.connect(cleanup, state => this._syncDot(state));
        this._syncDot(NotificationRouter.state());
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // Date menu to the end of the right box; back to its old place on cleanup
    _moveDateMenu(dateMenu) {
        const container = dateMenu.container;
        const parent = container.get_parent();
        if (parent !== Main.panel._centerBox)
            return;
        const index = parent.get_children().indexOf(container);
        parent.remove_child(container);
        Main.panel._rightBox.add_child(container);
        this._cleanup.add(() => {
            container.get_parent()?.remove_child(container);
            parent.insert_child_at_index(container, Math.min(index, parent.get_n_children()));
        });
    }

    // The notification column is shown in Quick Settings instead; the menu shrinks to the
    // calendar. min-width keeps natural growth.
    _hideMessageList(dateMenu) {
        const box = dateMenu.menu.box;
        const style = box.style;
        this._cleanup.add(keepHidden(dateMenu._messageList));
        const [, natural] = dateMenu._calendar.get_preferred_width(-1);
        box.style = `min-width: ${menuWidth(natural)}px;`;
        this._cleanup.add(() => (box.style = style));
    }

    /**
     * The calendar card: a month grid, a minimal header and the events. World clocks and
     * weather are hidden (macOS has neither here, and both read "Add world clocks…" /
     * "Select weather location…" when unset); their own sync gets the last word on restore.
     */
    _styleCard(dateMenu) {
        const box = dateMenu.menu.box;
        const toggle = (name, on) => (on ? box.add_style_class_name(name) : box.remove_style_class_name(name));
        box.add_style_class_name(CARD_CLASS);
        this._cleanup.add(() => {
            for (const name of [CARD_CLASS, CARD_CALM_CLASS, CARD_LIGHT_CLASS])
                box.remove_style_class_name(name);
        });
        Glass.watch(this._cleanup, ({ env }) => {
            toggle(CARD_CALM_CLASS, !env.highContrast);
            toggle(CARD_LIGHT_CLASS, !env.dark);
        });
        for (const item of [dateMenu._clocksItem, dateMenu._weatherItem]) {
            if (item)
                this._cleanup.add(keepHidden(item, { resync: a => a._sync?.() }));
        }
    }

    // The dot sits after the Quick Settings icons, or after the clock when the notification
    // panel is kept. Indicators added later go before it, so it is put back last in an idle.
    _addDot(dateMenu, besideClock) {
        const parent = besideClock ? Main.panel._rightBox : Main.panel.statusArea.quickSettings._indicators;
        this._besideClock = besideClock;
        const dot = new St.Icon({
            gicon: Gio.FileIcon.new(this._ctx.extension.dir.get_child(DOT_ICON)),
            style_class: 'notification-badge',
            visible: false,
        });
        this._dot = this._cleanup.actor(dot);
        this._cleanup.connect(dot, 'destroy', () => (this._dot = null));
        const place = () => {
            if (!this._dot || this._dot.get_parent() !== parent)
                return;
            const after = besideClock ? parent.get_children().indexOf(dateMenu.container) : -1;
            const index = after >= 0 ? after + 1 : parent.get_n_children() - 1;
            if (parent.get_children().indexOf(this._dot) !== index)
                parent.set_child_at_index(this._dot, index);
        };
        parent.add_child(dot);
        place();
        let idleToken = 0;
        this._cleanup.connect(parent, 'child-added', (_p, child) => {
            if (child === this._dot || idleToken)
                return;
            idleToken = this._cleanup.idle(() => {
                idleToken = 0;
                place();
            }, { name: 'calendar dot placement' });
        });
    }

    _styleDot(ks) {
        if (this._dot)
            this._dot.style = indicatorStyle(ks.string('notification-indicator-style'), this._besideClock);
    }

    _syncDot(state) {
        // Every notification still in the list counts (acknowledged ones stay there), plus
        // queued banners
        if (this._dot)
            this._dot.visible = state.count > 0;
    }
}
