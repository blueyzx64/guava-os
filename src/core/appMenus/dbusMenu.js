// SPDX-License-Identifier: GPL-3.0-or-later
// DBusMenu provider: the menu bars of Qt, Electron/Chromium, LibreOffice and other X11 apps
// running under Xwayland (provider 4).
//
// Those apps look for com.canonical.AppMenu.Registrar on the session bus. When it is there,
// they hide their in-window menu bar and register it: RegisterWindow(u xid, o path) from their
// own bus name. The menu itself is com.canonical.dbusmenu at that path.
//
//   Registrar   owned by Guava while app menus run, only if nobody else owns it (DO_NOT_QUEUE:
//               Guava never takes the name from another registrar, it reads that one instead
//               through GetMenuForWindow). Registrations go when the app's bus name vanishes.
//   Window      Meta.Window -> X11 window id (lib/compat.js x11WindowId); Wayland clients have
//               none, so a native Wayland Qt app is not covered (it has no registrar protocol
//               on GNOME).
//   Menu        AboutToShow on the top-level menus (apps fill them lazily), GetLayout(0, -1),
//               Event(id, 'clicked') to activate. LayoutUpdated and ItemsPropertiesUpdated
//               mark the window stale (and refresh an open menu).
//   Bounds      a layout over MAX_REPLY_BYTES is refused; at most MAX_ITEMS items are built;
//               every call has a 2 s timeout and a failure keeps the result stale.
//
// What users need (docs/features/app-menus.md): Qt 5/6 apps export through the platform theme
// when the registrar is present at their start (QT_QPA_PLATFORMTHEME unset or 'gnome'/'gtk3'
// with appmenu support, or the appmenu-qt5 plugin); Chromium and Electron only when running
// on X11 (--ozone-platform=x11). Guava never sets these variables.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { MAX_REPLY_BYTES, dbusmenuSubmenuIds, dbusmenuToMenus } from './nativeModel.js';

const REGISTRAR = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';
const DBUSMENU = 'com.canonical.dbusmenu';
const TIMEOUT_MS = 2000;

const REGISTRAR_XML = `<node>
  <interface name="${REGISTRAR}">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg type="a(uso)" name="menus" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg type="u" name="windowId"/>
      <arg type="s" name="service"/>
      <arg type="o" name="menuObjectPath"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg type="u" name="windowId"/>
    </signal>
  </interface>
</node>`;

function call(dest, path, iface, method, params, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(dest, path, iface, method, params,
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

/**
 * com.canonical.AppMenu.Registrar: who registered a menu for which X11 window.
 * `onChange(xid)` runs when a window registers or unregisters.
 */
export class AppMenuRegistrar {
    constructor(onChange) {
        this._onChange = onChange;
        this._windows = new Map(); // xid -> {service, path}
        this._owned = false;
        this._ownerId = 0;
        this._vanishId = 0;
        this._object = null;
    }

    /** True while Guava owns the name (else another registrar answers). */
    get owned() {
        return this._owned;
    }

    start() {
        this._object = Gio.DBusExportedObject.wrapJSObject(REGISTRAR_XML, this);
        this._ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session, REGISTRAR,
            Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
            () => {
                this._owned = true;
                this._object.export(Gio.DBus.session, REGISTRAR_PATH);
            },
            () => {
                // Another registrar has it (or we lost the bus): read that one instead
                this._unexport();
                this._owned = false;
            });
        this._vanishId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!newOwner && name.startsWith(':'))
                    this._dropService(name);
            });
    }

    stop() {
        if (this._vanishId)
            Gio.DBus.session.signal_unsubscribe(this._vanishId);
        this._vanishId = 0;
        if (this._ownerId)
            Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
        this._unexport();
        this._object = null;
        this._owned = false;
        this._windows.clear();
    }

    /** @returns {Promise<?{service, path}>} the menu of an X11 window */
    async lookup(xid, cancellable) {
        if (this._owned)
            return this._windows.get(xid) ?? null;
        try {
            const reply = await call(REGISTRAR, REGISTRAR_PATH, REGISTRAR, 'GetMenuForWindow',
                new GLib.Variant('(u)', [xid]), '(so)', cancellable);
            const [service, path] = reply.deepUnpack();
            return service && path && path !== '/' ? { service, path } : null;
        } catch {
            return null;
        }
    }

    // ---- com.canonical.AppMenu.Registrar ------------------------------------------------

    RegisterWindowAsync([windowId, path], invocation) {
        const service = invocation.get_sender();
        this._windows.set(windowId, { service, path });
        invocation.return_value(null);
        this._object?.emit_signal('WindowRegistered', new GLib.Variant('(uso)', [windowId, service, path]));
        this._onChange(windowId);
    }

    UnregisterWindowAsync([windowId], invocation) {
        const known = this._windows.get(windowId);
        if (known?.service === invocation.get_sender())
            this._unregister(windowId);
        invocation.return_value(null);
    }

    GetMenuForWindow(windowId) {
        const hit = this._windows.get(windowId);
        return hit ? [hit.service, hit.path] : ['', '/'];
    }

    GetMenus() {
        // One out argument: the value itself
        return [...this._windows].map(([xid, { service, path }]) => [xid, service, path]);
    }

    // ---- internals ----------------------------------------------------------------------

    _unregister(windowId) {
        this._windows.delete(windowId);
        this._object?.emit_signal('WindowUnregistered', new GLib.Variant('(u)', [windowId]));
        this._onChange(windowId);
    }

    _dropService(name) {
        for (const [xid, { service }] of [...this._windows]) {
            if (service === name)
                this._unregister(xid);
        }
    }

    _unexport() {
        if (this._object && this._owned)
            this._object.unexport();
    }
}

export class DBusMenuProvider {
    constructor() {
        this.id = 'dbusmenu';
        this.menubar = true;
        this._host = null;
        this._registrar = null;
        this._byXid = new Map(); // xid -> windowId (the windows asked for)
        this._windows = new Map(); // windowId -> {service, path, subs}
    }

    start(host) {
        this._host = host;
        this._registrar = new AppMenuRegistrar(xid => {
            const windowId = this._byXid.get(xid);
            if (windowId !== undefined) {
                this._unwatch(windowId);
                this._host?.changed(windowId, { structure: true });
            }
        });
        this._registrar.start();
    }

    stop() {
        for (const windowId of [...this._windows.keys()])
            this._unwatch(windowId);
        this._byXid.clear();
        this._registrar?.stop();
        this._registrar = null;
        this._host = null;
    }

    /** The registrar (tests, the harness). */
    get registrar() {
        return this._registrar;
    }

    supports(target) {
        return !!this._registrar && target?.xid !== null && target?.xid !== undefined &&
            target.windowId !== null;
    }

    async fetch(target, cancellable) {
        this._byXid.set(target.xid, target.windowId);
        const menu = await this._registrar.lookup(target.xid, cancellable);
        if (!menu)
            return { menubar: [] };
        this._watch(target.windowId, menu);
        let layout = await this._layout(menu, cancellable);
        // Apps fill their menus when told they are about to show
        const ids = dbusmenuSubmenuIds(layout, 1);
        if (ids.length && await this._aboutToShow(menu, ids, cancellable))
            layout = await this._layout(menu, cancellable);
        return { menubar: dbusmenuToMenus(layout, { provider: this.id }) };
    }

    activate(target, { id }) {
        const menu = this._windows.get(target.windowId);
        if (!menu)
            return Promise.resolve(false);
        const params = new GLib.Variant('(isvu)', [id, 'clicked', new GLib.Variant('i', 0),
            global.get_current_time()]);
        return call(menu.service, menu.path, DBUSMENU, 'Event', params, null, null)
            .then(() => true, e => {
                console.warn(`[Guava] app menus: DBusMenu item ${id} failed: ${e.message}`);
                return false;
            });
    }

    release(windowId) {
        this._unwatch(windowId);
        for (const [xid, id] of [...this._byXid]) {
            if (id === windowId)
                this._byXid.delete(xid);
        }
    }

    // ---- internals ----------------------------------------------------------------------

    async _layout({ service, path }, cancellable) {
        const reply = await call(service, path, DBUSMENU, 'GetLayout',
            new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))', cancellable);
        if (reply.get_size() > MAX_REPLY_BYTES)
            throw new Error(`${service}${path}: menu too large (${reply.get_size()} bytes)`);
        return reply.get_child_value(1).recursiveUnpack();
    }

    // @returns {boolean} true when the app changed a menu (the layout must be read again)
    async _aboutToShow({ service, path }, ids, cancellable) {
        try {
            const reply = await call(service, path, DBUSMENU, 'AboutToShowGroup',
                new GLib.Variant('(ai)', [ids]), '(aiai)', cancellable);
            const [updates] = reply.deepUnpack();
            return updates.length > 0;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
        // Older libdbusmenu: one call per menu
        const replies = await Promise.all(ids.map(id => call(service, path, DBUSMENU, 'AboutToShow',
            new GLib.Variant('(i)', [id]), '(b)', cancellable).then(r => r.deepUnpack()[0], () => false)));
        return replies.some(Boolean);
    }

    _watch(windowId, { service, path }) {
        const known = this._windows.get(windowId);
        if (known?.service === service && known.path === path)
            return;
        this._unwatch(windowId);
        // A new layout may bring or drop menus; property updates change labels and states
        const subs = [['LayoutUpdated', true], ['ItemsPropertiesUpdated', false]].map(([signal, structure]) =>
            Gio.DBus.session.signal_subscribe(service, DBUSMENU, signal, path, null,
                Gio.DBusSignalFlags.NONE, () => this._host?.changed(windowId, { structure })));
        this._windows.set(windowId, { service, path, subs });
    }

    _unwatch(windowId) {
        const known = this._windows.get(windowId);
        if (!known)
            return;
        this._windows.delete(windowId);
        for (const id of known.subs)
            Gio.DBus.session.signal_unsubscribe(id);
    }
}
