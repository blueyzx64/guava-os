// SPDX-License-Identifier: GPL-3.0-or-later
// The notification list in Quick Settings (features.js `quick-settings-notifications`): while
// the calendar has moved the date menu to the right without its notification column, the
// notifications are listed at the bottom of the Quick Settings menu instead (and the Control
// Center gives them a full-width row). Activating one closes the menu.
//
// Private Shell API: quickSettings.menu._grid and its layout manager, MessageList.MessageView
// and its _mediaSource / _setupMpris (48-51).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

import { whenQuickSettingsReady } from '../../lib/quickSettings.js';

/** The Quick Settings menu may grow to this share of the monitor height with the list in it. */
const MENU_MAX_HEIGHT = 0.9;

const NotificationList = GObject.registerClass(
class GuavaNotificationList extends MessageList.MessageView {
    constructor(params) {
        super(params);
        // MessageView's field initializer builds a stock MprisSource (48-51: _mediaSource), a
        // second MPRIS watcher with no stop(). Neuter it before its D-Bus proxy is ready: no
        // players and no NameOwnerChanged subscription. Guava's media lives in core/mprisWatcher.
        const source = this._mediaSource;
        if (source) {
            try {
                source._addPlayer = () => {};
                if (source._proxy)
                    source._proxy.connectSignal = () => 0;
            } catch (e) {
                console.error('[Guava] could not stop the stock MPRIS source:', e);
            }
        }
    }

    // No media rows: the notch and the Control Center show media
    _setupMpris() {}
});

const NotificationWidget = GObject.registerClass(
class GuavaNotificationWidget extends St.BoxLayout {
    constructor(_) {
        super({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'guava-notifications',
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._list = new NotificationList();
        const header = new St.BoxLayout({ style_class: 'guava-header' });
        header.add_child(new St.Label({
            text: _('Notifications'),
            style_class: 'guava-header-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        }));
        this._clear = new St.Button({
            style_class: 'message-list-clear-button button destructive-action',
            label: _('Clear'),
            accessible_name: _('Clear all notifications'),
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(this._clear);
        this.add_child(header);
        this.add_child(new St.ScrollView({
            x_expand: true,
            y_expand: true,
            child: this._list,
            style_class: 'guava-notification-scroll',
            vscrollbar_policy: St.PolicyType.EXTERNAL,
        }));

        this._clear.connectObject('clicked', () => this._list.clear(), this);
        this._list.connectObject('notify::empty', () => this._syncEmpty(), this);
        this._list.connectObject('notify::can-clear', () => this._syncClear(), this);
        this._syncEmpty();
        this._syncClear();
    }

    _syncClear() {
        const canClear = this._list.canClear;
        this._clear.reactive = canClear;
        this._clear.can_focus = canClear;
        if (canClear)
            this._clear.remove_style_class_name('disabled');
        else
            this._clear.add_style_class_name('disabled');
    }

    // The Control Center's notch handling calls this name to re-apply its own visibility
    _syncEmpty() {
        this.visible = !this._list.empty;
    }
});

export class QuickSettingsNotifications {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        whenQuickSettingsReady(this._cleanup, qs => this._build(qs), 'Notifications in Quick Settings');
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    _build(qs) {
        const cleanup = this._cleanup;
        const menuActor = qs.menu.actor;
        const style = menuActor.get_style();
        const height = Math.round(Main.layoutManager.primaryMonitor.height * MENU_MAX_HEIGHT);
        menuActor.set_style(`${style ?? ''} max-height: ${height}px;`.trim());
        cleanup.add(() => menuActor.set_style(style));

        const grid = qs.menu._grid;
        const widget = cleanup.actor(new NotificationWidget(this._ctx.gettext ?? (s => s)));
        grid.add_child(widget);
        grid.layout_manager.child_set_property(grid, widget, 'column-span', 2);

        // Activating a notification shown here closes the menu, so it does not cover (and
        // block focus of) the window it opened. Tied to the widget's lifetime.
        const close = () => {
            if (qs.menu.isOpen)
                qs.menu.close();
        };
        const watchSource = source => {
            source.connectObject('notification-added', (_s, n) => n.connectObject('activated', close, widget), widget);
            source.notifications.forEach(n => n.connectObject('activated', close, widget));
        };
        Main.messageTray.connectObject('source-added', (_t, source) => watchSource(source), widget);
        Main.messageTray.getSources().forEach(watchSource);
    }
}
