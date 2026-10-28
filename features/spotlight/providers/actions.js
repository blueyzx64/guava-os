// SPDX-License-Identifier: GPL-3.0-or-later
// Actions: Guava's own actions (actionsModel.js) and the apps' .desktop actions, searched and run.
//
//   Show Desktop    the show-desktop feature (ctx.features), hidden while that feature is off
//   Lock Screen     Main.screenShield
//   Start Timer     the 'timer-start-requested' event; with no listener, a notification timer
//   Do Not Disturb  core/notificationRouter.js
//   Dark Mode       org.gnome.desktop.interface color-scheme, written as the user's own choice
//                   (as the Settings switch does; Appearance's Auto yields to it)
//   Empty Trash     Files' own EmptyTrash (org.gnome.Nautilus.FileOperations2), which asks
//                   first and deletes; Guava never deletes anything itself
//   Take Screenshot Main.screenshotUI

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NotificationRouter } from '../../../core/notificationRouter.js';
import { DesktopAppInfo } from '../../../lib/compat.js';
import { GUAVA_ACTIONS, actionItems, parameterItems } from '../actionsModel.js';
import { rank } from '../model.js';

const LOG = '[Guava] spotlight:';
const FILES_APP = 'org.gnome.Nautilus.desktop';
const MAX_RESULTS = 6;

export class ActionsProvider {
    /**
     * @param {object} ctx the feature context (features, events, gettext)
     * @param {object} cleanup CleanupRegistry (the fallback timers live in it)
     * @param {import('./apps.js').AppsProvider} apps
     */
    constructor(ctx, cleanup, apps) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._apps = apps;
        this._iface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._filesInstalled = null;
    }

    _available() {
        const out = new Set();
        if (this._ctx.features?.instance?.('show-desktop'))
            out.add('show-desktop');
        this._filesInstalled ??= !!DesktopAppInfo.new(FILES_APP);
        if (this._filesInstalled)
            out.add('trash');
        return out;
    }

    _state() {
        return {
            dnd: !!NotificationRouter.state().dnd,
            dark: St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK,
        };
    }

    /** Guava's actions as rows (state-dependent titles are read now). */
    guavaItems() {
        return actionItems(GUAVA_ACTIONS, this._state(), this._ctx.gettext, this._available());
    }

    /** Every action row: Guava's, then the apps' .desktop actions. */
    all() {
        return [...this.guavaItems(), ...this._apps.desktopActions()];
    }

    /** Ranked rows for a query, with a typed-parameter row ("timer 5m") first. */
    searchSync(query) {
        const _ = this._ctx.gettext;
        return [
            ...parameterItems(GUAVA_ACTIONS, query, _),
            ...rank(this.all(), query, MAX_RESULTS),
        ];
    }

    /** The row a Quick Key names ("action:show-desktop"), with the typed parameter applied. */
    itemFor(actionId, args = '') {
        if (args) {
            const [withParam] = parameterItems(GUAVA_ACTIONS, args, this._ctx.gettext, actionId);
            if (withParam)
                return withParam;
        }
        return this.guavaItems().find(i => i.actionId === actionId) ?? null;
    }

    /** Run a row of kind 'command' or 'app-action'. @returns {boolean} */
    run(item) {
        if (item.kind === 'app-action')
            return this._apps.launchAction(item);
        switch (item.actionId) {
        case 'show-desktop': {
            const sd = this._ctx.features?.instance?.('show-desktop');
            sd?.toggle();
            return !!sd;
        }
        case 'lock':
            Main.screenShield?.lock(true);
            return !!Main.screenShield;
        case 'timer':
            return this._timer(item.args?.seconds ?? 300, item.args?.label ?? '');
        case 'dnd':
            NotificationRouter.setDnd(!NotificationRouter.state().dnd);
            return true;
        case 'dark-mode':
            this._iface.set_string('color-scheme', this._state().dark ? 'prefer-light' : 'prefer-dark');
            return true;
        case 'empty-trash':
            this._emptyTrash();
            return true;
        case 'screenshot':
            Promise.resolve(Main.screenshotUI?.open()).catch(e => console.warn(`${LOG} screenshot: ${e.message}`));
            return !!Main.screenshotUI;
        default:
            return false;
        }
    }

    _timer(seconds, label) {
        const { events } = this._ctx;
        const payload = { seconds, label, source: 'spotlight' };
        if (events.listenerCount('timer-start-requested') > 0) {
            events.emit('timer-start-requested', payload);
            return true;
        }
        // Nobody owns timers yet: a plain one-shot that notifies when it ends
        const _ = this._ctx.gettext;
        this._cleanup.timeout(seconds * 1000, () => {
            Main.notify(_('Timer'), _('Your %s timer is done').replace('%s', label));
            return GLib.SOURCE_REMOVE;
        }, { name: 'spotlight-timer' });
        return true;
    }

    _emptyTrash() {
        Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
            'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
            new GLib.Variant('(ba{sv})', [true, {}]), null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    console.warn(`${LOG} Empty Trash: ${e.message}`);
                }
            });
    }
}
