// SPDX-License-Identifier: GPL-3.0-or-later
// GTK exported menus provider: the menu bar (and the GTK 3 app menu) a GtkApplication exports
// with org.gtk.Menus, shown as the app's own menus (provider 3).
//
//   Meta.Window get_gtk_menubar_object_path()   '/org/example/App/menus/menubar'
//               get_gtk_app_menu_object_path()  '/org/example/App/menus/appmenu' (GTK 3)
//
// GTK 3 and 4 export them when the app calls gtk_application_set_menubar() (or a menus.ui
// 'menubar' resource), whether or not the window also draws its own menu bar.
//
// Protocol: Start(au groups) -> a(uuaa{sv}) subscribes this connection to the groups and returns
// their menus; Changed(a(uuuuaa{sv})) then reports splices; End(au) unsubscribes. Items name an
// action ('app.save', 'win.zoom') and an optional target: enabled and toggle/radio states come
// from org.gtk.Actions (the actions the GTK actions provider read, which also watches their
// Changed signal; names it skipped in a huge app are described here, MAX_DESCRIBE names at
// most), and activation goes back through org.gtk.Actions.Activate.
//
// Cost bounds: a Start reply over MAX_REPLY_BYTES is refused (the menus are not shown), and
// the walk stops at MAX_ITEMS items (nativeModel.js).
//
// One subscription per window, from its first fetch until the window goes or the provider
// stops. Nothing runs while no app with an exported menu bar is focused.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { GMenuStore, MAX_REPLY_BYTES, gmenuToMenus, gmenuActionNames } from './nativeModel.js';
import { describeNames } from './gtkActions.js';
import { WELL_KNOWN } from './model.js';

const MENUS = 'org.gtk.Menus';
const ACTIONS = 'org.gtk.Actions';
const TIMEOUT_MS = 2000;
const MAX_GROUP_ROUNDS = 4;
const MAX_DESCRIBE = 200;

// The HIG shortcut of a well-known action, for menus that carry no 'accel' attribute (GTK 4
// does not export the app's accelerators)
const WELL_KNOWN_ACCELS = new Map(WELL_KNOWN.flatMap(({ names, accel }) =>
    accel ? names.map(n => [n, accel]) : []));

function call(busName, path, iface, method, params, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(busName, path, iface, method, params,
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

// a(uuaa{sv}) or a(uuuuaa{sv}) rows with each item's attributes unpacked; a target keeps its
// GVariant type next to it so activation can rebuild it
function unpackRows(variant, withSplice) {
    const rows = [];
    const n = variant.n_children();
    for (let i = 0; i < n; i++) {
        const row = variant.get_child_value(i);
        const head = [];
        const fixed = withSplice ? 4 : 2;
        for (let k = 0; k < fixed; k++)
            head.push(row.get_child_value(k).unpack());
        const items = [];
        const list = row.get_child_value(fixed);
        for (let j = 0; j < list.n_children(); j++) {
            const dict = list.get_child_value(j);
            const attrs = {};
            for (let d = 0; d < dict.n_children(); d++) {
                const entry = dict.get_child_value(d);
                const key = entry.get_child_value(0).unpack();
                const value = entry.get_child_value(1).get_variant();
                attrs[key] = value.recursiveUnpack();
                if (key === 'target')
                    attrs['target-type'] = value.get_type_string();
            }
            items.push(attrs);
        }
        rows.push([...head, items]);
    }
    return rows;
}

export class GtkMenusProvider {
    constructor() {
        this.id = 'gtk-menus';
        this.menubar = true;
        this._host = null;
        this._windows = new Map(); // windowId -> {busName, stores: Map<path, GMenuStore>, subs, ready}
    }

    start(host) {
        this._host = host;
    }

    stop() {
        for (const windowId of [...this._windows.keys()])
            this.release(windowId);
        this._host = null;
    }

    supports(target) {
        return !!target?.gtk?.busName && !!(target.gtk.menubarPath || target.gtk.appMenuPath) &&
            target.windowId !== null;
    }

    /** @returns {Promise<{menubar: object[], menus: object[]}>} */
    async fetch(target, cancellable, { actions = [] } = {}) {
        const state = await this._subscribe(target, cancellable);
        const { busName, menubarPath, appMenuPath, appPath, windowPath } = target.gtk;
        const bar = menubarPath ? state.stores.get(menubarPath) : null;
        const appMenu = appMenuPath ? state.stores.get(appMenuPath) : null;
        // Actions the menus name that the actions provider did not read (a huge app)
        const known = new Set(actions.map(a => `${a.group}.${a.name}`));
        const missing = { app: [], win: [] };
        for (const store of [bar, appMenu].filter(Boolean)) {
            for (const full of gmenuActionNames(store)) {
                const [group, ...rest] = full.split('.');
                if (!known.has(full) && missing[group] && missing[group].length < MAX_DESCRIBE)
                    missing[group].push(rest.join('.'));
            }
        }
        const extra = await Promise.all([
            describeNames(busName, appPath, 'app', missing.app, cancellable),
            describeNames(busName, windowPath, 'win', missing.win, cancellable),
        ]);
        const all = [...actions, ...extra.flat()];
        const opts = { actions: all, provider: this.id, accels: WELL_KNOWN_ACCELS };
        const menubar = bar ? gmenuToMenus(bar, opts) : [];
        // A GTK 3 app menu has no submenus at the top: its items join Guava's App menu
        const menus = appMenu ? gmenuToMenus(appMenu, opts).filter(m => m.id === 'app') : [];
        return { menubar, menus };
    }

    activate(target, { group, name, target: value, targetType }) {
        const path = group === 'win' ? target.gtk?.windowPath : target.gtk?.appPath;
        if (!target.gtk?.busName || !path)
            return Promise.resolve(false);
        const param = value !== null && value !== undefined && targetType
            ? [new GLib.Variant(targetType, value)] : [];
        const params = new GLib.Variant('(sava{sv})', [name, param, {}]);
        return call(target.gtk.busName, path, ACTIONS, 'Activate', params, null, null)
            .then(() => true, e => {
                console.warn(`[Guava] app menus: ${group}.${name} failed: ${e.message}`);
                return false;
            });
    }

    release(windowId) {
        const state = this._windows.get(windowId);
        if (!state)
            return;
        this._windows.delete(windowId);
        for (const id of state.subs)
            Gio.DBus.session.signal_unsubscribe(id);
        for (const [path, store] of state.stores) {
            const groups = store.started;
            if (groups.length) {
                call(state.busName, path, MENUS, 'End', new GLib.Variant('(au)', [groups]), null, null)
                    .catch(() => {}); // the app may have quit already
            }
        }
    }

    // ---- internals ----------------------------------------------------------------------

    _subscribe(target, cancellable) {
        const { windowId } = target;
        const { busName, menubarPath, appMenuPath } = target.gtk;
        const known = this._windows.get(windowId);
        if (known && known.busName === busName)
            return known.ready;
        if (known)
            this.release(windowId);
        const state = { busName, stores: new Map(), subs: [], ready: null };
        this._windows.set(windowId, state);
        const changed = () => this._host?.changed(windowId, { structure: true });
        const paths = [menubarPath, appMenuPath].filter(Boolean);
        for (const path of paths) {
            const store = new GMenuStore();
            state.stores.set(path, store);
            state.subs.push(Gio.DBus.session.signal_subscribe(busName, MENUS, 'Changed', path, null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    if (store.change(unpackRows(params.get_child_value(0), true)))
                        changed();
                }));
        }
        state.ready = Promise.all(paths.map(path => this._load(busName, path, state.stores.get(path), cancellable)))
            .then(() => state, e => {
                if (this._windows.get(windowId) === state)
                    this.release(windowId);
                throw e;
            });
        return state.ready;
    }

    // Start group 0, then the groups its sections and submenus link to
    async _load(busName, path, store, cancellable) {
        let groups = [0];
        for (let round = 0; round < MAX_GROUP_ROUNDS && groups.length; round++) {
            const reply = await call(busName, path, MENUS, 'Start', new GLib.Variant('(au)', [groups]),
                '(a(uuaa{sv}))', cancellable);
            if (reply.get_size() > MAX_REPLY_BYTES)
                throw new Error(`${path}: menus too large (${reply.get_size()} bytes)`);
            store.markStarted(groups);
            store.load(unpackRows(reply.get_child_value(0), false));
            groups = store.missingGroups();
        }
    }
}
