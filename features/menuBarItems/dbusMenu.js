// SPDX-License-Identifier: GPL-3.0-or-later
// A com.canonical.dbusmenu client: the menu of a status item (StatusNotifierItem `Menu`),
// drawn as Shell popup menu items. The layout is fetched whole (GetLayout, recursion -1) and
// again after LayoutUpdated or ItemsPropertiesUpdated (coalesced in one idle); a click sends
// Event(id, 'clicked'). AboutToShow is sent as the menu opens, as the spec asks.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { MAX_REPLY_BYTES } from '../../core/appMenus/nativeModel.js';
import { parseMenu } from './model.js';

const IFACE = 'com.canonical.dbusmenu';

export class DBusMenuClient {
    /**
     * @param {object} opts
     * @param {string} opts.bus
     * @param {string} opts.path
     * @param {CleanupRegistry} opts.cleanup the item's registry
     * @param {Gio.Cancellable} opts.cancellable
     * @param {() => void} [opts.onChanged] after a new layout arrived
     */
    constructor({ bus, path, cleanup, cancellable, onChanged = () => {} }) {
        this._bus = bus;
        this._path = path;
        this._cleanup = cleanup;
        this._cancellable = cancellable;
        this._onChanged = onChanged;
        this._tree = null;
        this._idle = 0;
        for (const signal of ['LayoutUpdated', 'ItemsPropertiesUpdated']) {
            const id = Gio.DBus.session.signal_subscribe(bus, IFACE, signal, path, null,
                Gio.DBusSignalFlags.NONE, () => this._refreshSoon());
            cleanup.add(() => Gio.DBus.session.signal_unsubscribe(id));
        }
        this.refresh();
    }

    /** The last layout (model.js parseMenu tree), or null before the first answer. */
    get tree() {
        return this._tree;
    }

    get hasItems() {
        return !!this._tree?.children.length;
    }

    _call(method, params, type, done) {
        Gio.DBus.session.call(this._bus, this._path, IFACE, method, params,
            type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                let reply = null;
                try {
                    reply = conn.call_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        done?.(null, e);
                    return;
                }
                done?.(reply, null);
            });
    }

    _refreshSoon() {
        if (this._idle)
            return;
        this._idle = this._cleanup.idle(() => {
            this._idle = 0;
            this.refresh();
        }, { name: 'status item menu refresh' });
    }

    refresh() {
        this._call('GetLayout', new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))', reply => {
            if (!reply || reply.get_size() > MAX_REPLY_BYTES)
                return;
            const [, layout] = reply.recursiveUnpack();
            this._tree = parseMenu(layout);
            this._onChanged();
        });
    }

    /** The menu is about to open: the app may update it (an answer of true refetches). */
    aboutToShow() {
        this._call('AboutToShow', new GLib.Variant('(i)', [0]), '(b)', reply => {
            if (reply?.deepUnpack()[0])
                this.refresh();
        });
    }

    activate(id) {
        this._call('Event', new GLib.Variant('(isvu)',
            [id, 'clicked', new GLib.Variant('i', 0), Math.floor(global.get_current_time() / 1000) >>> 0]), null, null);
    }

    /**
     * Put the layout into a popup menu (or a submenu's menu).
     *
     * @param {PopupMenu.PopupMenuBase} menu emptied first
     * @param {object} [node] a subtree; the root by default
     */
    fill(menu, node = this._tree) {
        menu.removeAll();
        for (const item of node?.children ?? [])
            menu.addMenuItem(this._item(item));
    }

    _item(node) {
        if (node.separator)
            return new PopupMenu.PopupSeparatorMenuItem();
        if (node.children.length) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(node.label, !!node.icon);
            if (node.icon)
                sub.icon.icon_name = node.icon;
            for (const child of node.children)
                sub.menu.addMenuItem(this._item(child));
            sub.setSensitive(node.enabled);
            return sub;
        }
        const item = node.icon
            ? new PopupMenu.PopupImageMenuItem(node.label, node.icon)
            : new PopupMenu.PopupMenuItem(node.label);
        item.add_style_class_name('guava-menubar-menu-item');
        if (node.toggle)
            item.setOrnament(node.checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        item.setSensitive(node.enabled);
        item.connect('activate', () => this.activate(node.id));
        return item;
    }
}

/** A grey, non-clickable line ("No menu"). */
export function infoItem(text) {
    const item = new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false });
    item.label.add_style_class_name('guava-menubar-items-info');
    return item;
}
