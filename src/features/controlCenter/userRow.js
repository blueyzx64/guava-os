// SPDX-License-Identifier: GPL-3.0-or-later
// The footer of the Control Center: the stock system item (battery, screenshot, Settings,
// Lock, Power) with the user's avatar in front and "time left" under the battery. macOS has
// no user row, so the footer stays one quiet line of small icons: the avatar shows no name
// (the name is its accessible name).
// Replaces Guava 2.x's panel username label.
//
// Reads the stock PowerToggle (system.js): its `title` already holds the percentage and
// its `_proxy` is the UPower.Device proxy (private; present in 48-51).

import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';

import { batteryTime } from './model.js';

const AVATAR_SIZE = 24;

function _userName(user) {
    const name = user?.is_loaded ? user.get_real_name() : null;
    return name || GLib.get_real_name() || GLib.get_user_name();
}

function _timeText(gettext, time) {
    const span = time.hours > 0
        ? gettext('%d h %d min').replace('%d', time.hours).replace('%d', time.minutes)
        : gettext('%d min').replace('%d', time.minutes);
    return time.kind === 'remaining'
        ? gettext('%s left').replace('%s', span)
        : gettext('%s until full').replace('%s', span);
}

export class UserRow {
    constructor({ qs, gettext, cleanup }) {
        this._gettext = gettext;
        this._cleanup = cleanup;
        this._item = qs._system._systemItem;
        this._powerToggle = this._item.powerToggle;
        this._cluster = null;
        this._tokens = [];
        this._savedSubtitle = this._powerToggle.subtitle;
    }

    /** @param {boolean} showUser avatar and name; the time under the battery goes with it */
    enable(showUser) {
        if (!showUser)
            return;

        const user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
        this._cluster = new St.BoxLayout({
            style_class: 'guava-cc-user',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cluster.add_child(this._createAvatar(user));
        this._item.child.insert_child_at_index(this._cluster, 0);

        const rename = () => {
            this._cluster.accessible_name = _userName(user);
            // No picture: the stock avatar is an empty circle, so it stays out
            this._cluster.visible = !user.is_loaded || !!user.get_icon_file();
        };
        rename();
        const update = () => this._updateTime();
        this._tokens.push(
            this._cleanup.connect(user, 'notify::is-loaded', rename),
            this._cleanup.connect(user, 'changed', rename),
            this._cleanup.connect(this._powerToggle, 'notify::title', update),
            this._cleanup.connect(this._powerToggle, 'notify::visible', update));
        update();
    }

    _createAvatar(user) {
        try {
            const avatar = new UserWidget.Avatar(user, { iconSize: AVATAR_SIZE });
            avatar.update();
            return avatar;
        } catch (e) {
            console.error('[Guava] Control Center avatar unavailable:', e);
            return new St.Icon({ icon_name: 'avatar-default-symbolic', icon_size: AVATAR_SIZE });
        }
    }

    _updateTime() {
        const proxy = this._powerToggle._proxy;
        const time = this._powerToggle.visible && proxy
            ? batteryTime({
                state: proxy.State,
                toEmpty: proxy.TimeToEmpty,
                toFull: proxy.TimeToFull,
            })
            : null;
        this._powerToggle.subtitle = time ? _timeText(this._gettext, time) : null;
    }

    destroy() {
        this._tokens.forEach(token => this._cleanup.release(token));
        this._tokens = [];
        if (this._cluster) {
            this._cluster.destroy();
            this._cluster = null;
            this._powerToggle.subtitle = this._savedSubtitle;
        }
    }
}

/**
 * A battery percentage in the top bar that stays on at any charge ("battery-percentage-always").
 * Mirrors GNOME's own label, so it is not created while that one is on.
 */
export class PanelBattery {
    constructor({ qs, cleanup }) {
        this._qs = qs;
        this._cleanup = cleanup;
        this._label = null;
        this._token = 0;
    }

    enable(interfaceSettings) {
        const sync = () => this.sync(interfaceSettings);
        this._token = this._cleanup.connect(interfaceSettings, 'changed::show-battery-percentage', sync);
        sync();
    }

    sync(interfaceSettings) {
        const power = this._qs._system?._systemItem?.powerToggle;
        const wanted = !!power && !interfaceSettings.get_boolean('show-battery-percentage');
        if (wanted && !this._label)
            this._create(power);
        else if (!wanted)
            this._destroyLabel();
    }

    _create(power) {
        this._label = new St.Label({
            style_class: 'guava-cc-battery-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bindings = [
            power.bind_property('title', this._label, 'text', GObject.BindingFlags.SYNC_CREATE),
            power.bind_property('visible', this._label, 'visible', GObject.BindingFlags.SYNC_CREATE),
        ];
        this._qs._indicators.insert_child_above(this._label, this._qs._system);
    }

    destroy() {
        if (this._token) {
            this._cleanup.release(this._token);
            this._token = 0;
        }
        this._destroyLabel();
    }

    _destroyLabel() {
        this._bindings?.forEach(binding => binding.unbind());
        this._bindings = null;
        this._label?.destroy();
        this._label = null;
    }
}
