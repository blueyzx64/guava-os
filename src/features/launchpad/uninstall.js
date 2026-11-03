// SPDX-License-Identifier: GPL-3.0-or-later
// Who can remove an app from Launchpad's jiggle mode, and the D-Bus calls that ask them.
// Guava never removes anything itself; it asks the app's owner (the rules are
// model.js uninstallRule):
//
//   Flatpak apps -> GNOME Software (org.gnome.Software, a DBusActivatable GApplication):
//                   org.freedesktop.Application.ActivateAction('uninstall', [<app id>], {}).
//                   GNOME Software runs the removal (and may show its own window).
//                   Behind a capability check: nothing is offered while the name is neither
//                   owned nor activatable.
//
// Every call is async with a timeout; an absent service means "no ⓧ", never an error.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { flatpakAppId, uninstallRule } from './model.js';

const SOFTWARE = { name: 'org.gnome.Software', path: '/org/gnome/Software' };
const CALL_TIMEOUT_MS = 5000;

const cancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

function call(bus, name, path, iface, method, params, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, params, replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export class UninstallService {
    /**
     * @param {object} cleanup CleanupRegistry; cancels calls on dispose
     */
    constructor(cleanup) {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._caps = { software: false };
        cleanup.add(() => this._cancellable.cancel());
    }

    /** Which back ends are reachable now ({software}); refreshed by probe(). */
    get capabilities() {
        return { ...this._caps };
    }

    /** Look up the back ends on the bus (owned or activatable names). Call when Launchpad opens. */
    async probe() {
        try {
            const [names] = (await call(this._bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, '(as)', this._cancellable)).deepUnpack();
            const [activatable] = (await call(this._bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListActivatableNames', null, '(as)', this._cancellable)).deepUnpack();
            const has = n => names.includes(n) || activatable.includes(n);
            this._caps = { software: has(SOFTWARE.name) };
        } catch (e) {
            if (!cancelled(e))
                console.warn('[Guava] launchpad: cannot list D-Bus names:', e.message);
            this._caps = { software: false };
        }
        return this.capabilities;
    }

    /** The facts model.uninstallRule needs, read from the app's desktop entry. */
    _facts(app) {
        const info = app.get_app_info?.();
        const desktopId = app.get_id();
        let path = null, xFlatpak = null;
        try {
            path = info?.get_filename?.() ?? null;
            xFlatpak = info?.get_string?.('X-Flatpak') ?? null;
        } catch (_e) {
            // not a desktop entry (window-backed app): nobody can remove it
        }
        return {
            desktopId,
            flatpakId: flatpakAppId({ desktopId, path, xFlatpak }),
        };
    }

    /** {backend, appId} for an app that gets an ⓧ, else null. */
    ruleFor(app) {
        return uninstallRule(this._facts(app), this._caps);
    }

    /**
     * Ask the owner to remove the app. Resolves when the request was delivered.
     *
     * @param {{backend: string, appId: string}} rule
     */
    async uninstall(rule) {
        if (rule.backend === 'flatpak') {
            await call(this._bus, SOFTWARE.name, SOFTWARE.path, 'org.freedesktop.Application', 'ActivateAction',
                new GLib.Variant('(sava{sv})', ['uninstall', [new GLib.Variant('s', rule.appId)], {}]),
                null, this._cancellable);
        } else {
            throw new Error(`unknown uninstall back end ${rule.backend}`);
        }
    }
}
