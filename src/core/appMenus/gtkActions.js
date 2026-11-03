// SPDX-License-Identifier: GPL-3.0-or-later
// GTK actions provider: the app.* and win.* actions a GtkApplication exports on the session
// bus (org.gtk.Actions), found from the window's GTK D-Bus properties.
//
//   Meta.Window get_gtk_unique_bus_name()          ':1.53'
//               get_gtk_application_object_path()  '/org/gnome/TextEditor'       -> app.*
//               get_gtk_window_object_path()       '/org/gnome/TextEditor/window/1' -> win.*
//
// GTK 3 and 4 set them on Wayland through gtk_shell1 for every GtkApplicationWindow. Apps that
// install their actions on widgets (gtk_widget_class_install_action) export nothing for the
// window, so libadwaita apps often have app.* only.
//
// Cost bounds (the reply is parsed on the Shell's main loop):
//   - DescribeAll replies are walked without unpacking: only the name, the enabled flag, the
//     parameter type and a basic-typed state (boolean, string, number) are read;
//   - a reply with more than MAX_DESCRIBE_ALL actions is not walked: the provider asks only for
//     the names it needs (the well-known ones, model.js wellKnownNames) with Describe;
//   - a timed-out or failed call rejects, so the service keeps the result stale and the next
//     menu open asks again; an object without actions (UnknownObject/UnknownMethod) is empty.
//
// Live states: while a window's actions are known, org.gtk.Actions Changed (an action enabled,
// disabled or toggled) marks it stale through host.changed(windowId, {structure: false}); the
// menu bar re-reads an open menu then, and closed menus on their next open.
//
// Provider interface (core/appMenus/service.js).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { MAX_DESCRIBE_ALL, parseDescribeAll, wellKnownNames } from './model.js';

const IFACE = 'org.gtk.Actions';
const TIMEOUT_MS = 2000;
const BASIC_STATE = new Set(['b', 's', 'i', 'u', 'x', 't', 'd', 'n', 'q', 'y']);

function call(busName, path, method, params, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(busName, path, IFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT_MS, cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// An object that is not there or exports no actions: a real, empty answer
function isAbsent(e) {
    return e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) ||
        e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_OBJECT) ||
        e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_INTERFACE);
}

// (bgav) -> [enabled, paramType, [state]] without unpacking anything else
function readDescription(tuple) {
    const enabled = tuple.get_child_value(0).get_boolean();
    const paramType = tuple.get_child_value(1).unpack();
    const states = tuple.get_child_value(2);
    const state = [];
    if (states.n_children() === 1) {
        const inner = states.get_child_value(0).get_variant();
        if (BASIC_STATE.has(inner.get_type_string()))
            state.push(inner.unpack());
    }
    return [enabled, paramType, state];
}

/**
 * The actions of one group, read cheaply.
 *
 * @param {string} busName
 * @param {?string} path
 * @param {'app'|'win'} group
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<object[]>} parseDescribeAll() rows; rejects on timeouts and errors
 */
export async function describeGroup(busName, path, group, cancellable) {
    if (!path)
        return [];
    let reply;
    try {
        reply = await call(busName, path, 'DescribeAll', null, '(a{s(bgav)})', cancellable);
    } catch (e) {
        if (isAbsent(e))
            return [];
        throw e;
    }
    const dict = reply.get_child_value(0);
    const n = dict.n_children();
    if (n > MAX_DESCRIBE_ALL)
        return describeNames(busName, path, group, wellKnownNames(group), cancellable);
    const plain = {};
    for (let i = 0; i < n; i++) {
        const entry = dict.get_child_value(i);
        plain[entry.get_child_value(0).get_string()[0]] = readDescription(entry.get_child_value(1));
    }
    return parseDescribeAll(plain, group);
}

/**
 * Describe a few actions by name (an app with too many actions for DescribeAll, or the
 * actions a menu names). Missing names are left out.
 *
 * @returns {Promise<object[]>}
 */
export async function describeNames(busName, path, group, names, cancellable) {
    if (!path || !names.length)
        return [];
    const plain = {};
    await Promise.all(names.map(name =>
        call(busName, path, 'Describe', new GLib.Variant('(s)', [name]), '((bgav))', cancellable)
            .then(r => {
                plain[name] = readDescription(r.get_child_value(0));
            }, e => {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            })));
    return parseDescribeAll(plain, group);
}

export class GtkActionsProvider {
    constructor() {
        this.id = 'gtk';
        this._host = null;
        this._watched = new Map(); // windowId -> {busName, subs}
    }

    start(host) {
        this._host = host;
    }

    stop() {
        for (const windowId of [...this._watched.keys()])
            this.release(windowId);
        this._host = null;
    }

    supports(target) {
        return !!target?.gtk?.busName && !!(target.gtk.appPath || target.gtk.windowPath);
    }

    /** @returns {Promise<{actions: object[]}>} */
    async fetch(target, cancellable) {
        const { busName, appPath, windowPath } = target.gtk;
        this._watch(target);
        const [app, win] = await Promise.all([
            describeGroup(busName, appPath, 'app', cancellable),
            describeGroup(busName, windowPath, 'win', cancellable),
        ]);
        return { actions: [...app, ...win] };
    }

    /** Activate one action: org.gtk.Actions.Activate(s name, av parameter, a{sv} platform data). */
    activate(target, { group, name }) {
        const path = group === 'win' ? target.gtk?.windowPath : target.gtk?.appPath;
        if (!target.gtk?.busName || !path)
            return Promise.resolve(false);
        const params = new GLib.Variant('(sava{sv})', [name, [], {}]);
        return call(target.gtk.busName, path, 'Activate', params, null, null)
            .then(() => true, e => {
                console.warn(`[Guava] app menus: ${group}.${name} failed: ${e.message}`);
                return false;
            });
    }

    release(windowId) {
        const known = this._watched.get(windowId);
        if (!known)
            return;
        this._watched.delete(windowId);
        for (const id of known.subs)
            Gio.DBus.session.signal_unsubscribe(id);
    }

    // org.gtk.Actions Changed on the window's two objects marks it stale
    _watch(target) {
        const { windowId } = target;
        const { busName, appPath, windowPath } = target.gtk;
        if (windowId === null || !this._host)
            return;
        if (this._watched.get(windowId)?.busName === busName)
            return;
        this.release(windowId);
        const changed = () => this._host?.changed(windowId, { structure: false });
        const subs = [appPath, windowPath].filter(Boolean).map(path =>
            Gio.DBus.session.signal_subscribe(busName, IFACE, 'Changed', path, null,
                Gio.DBusSignalFlags.NONE, changed));
        this._watched.set(windowId, { busName, subs });
    }
}
