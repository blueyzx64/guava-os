// SPDX-License-Identifier: GPL-3.0-or-later
// One app status icon (org.kde.StatusNotifierItem) as a menu bar item.
//
// Clicks follow macOS: a click opens the item's menu (its DBusMenu); an item without a menu
// gets Activate. A middle click sends SecondaryActivate, the wheel sends Scroll. The icon is
// the item's IconName (looked up in its IconThemePath first), else its IconPixmap; while it
// NeedsAttention, the attention icon. Passive items stay hidden (manager `wanted`).
//
// The SNI signals (NewIcon, NewStatus, ...) carry no values, so a burst of them refetches the
// properties once (GetAll in an idle).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { LazyMenu } from '../../lib/lazyMenu.js';
import { DBusMenuClient, infoItem } from './dbusMenu.js';
import { argbToRgba, pickPixmap, sniId, sniVisible } from './model.js';

const IFACES = ['org.kde.StatusNotifierItem', 'org.freedesktop.StatusNotifierItem'];
const ICON_SIZE = 16;
const SIGNALS = ['NewIcon', 'NewAttentionIcon', 'NewOverlayIcon', 'NewStatus', 'NewTitle',
    'NewToolTip', 'NewMenu', 'NewIconThemePath'];

const SniButton = GObject.registerClass(
class GuavaStatusItemButton extends PanelMenu.Button {
    _init(owner) {
        super._init(0.5, owner.title, false);
        this._owner = owner;
        this.setMenu(new LazyMenu(this, menu => owner.fillMenu(menu)));
        this.add_style_class_name('guava-menubar-status-item');
        this.icon = new St.Icon({ style_class: 'system-status-icon', icon_size: ICON_SIZE });
        this.add_child(this.icon);
    }

    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.SCROLL) {
            this._owner.scroll(event);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const button = type === Clutter.EventType.BUTTON_PRESS ? event.get_button() : 1;
            if (button === Clutter.BUTTON_MIDDLE) {
                this._owner.call('SecondaryActivate', event);
                return Clutter.EVENT_STOP;
            }
            if (!this._owner.hasMenu) {
                this._owner.call('Activate', event);
                return Clutter.EVENT_STOP;
            }
        }
        return super.vfunc_event(event);
    }
});

export class SniItem {
    /**
     * @param {object} opts
     * @param {string} opts.bus
     * @param {string} opts.path
     * @param {Function} opts.gettext
     * @param {(item: SniItem) => void} opts.onReady the first properties arrived
     * @param {(item: SniItem) => void} opts.onChanged
     */
    constructor({ bus, path, gettext, onReady, onChanged }) {
        this.bus = bus;
        this.path = path;
        this._ = gettext;
        this._onReady = onReady;
        this._onChanged = onChanged;
        this._cleanup = new CleanupRegistry();
        this._cancellable = new Gio.Cancellable();
        this._cleanup.add(() => this._cancellable.cancel());
        this._props = {};
        this._iface = IFACES[0];
        this._menu = null;
        this._menuPath = null;
        this._idle = 0;
        this._iconKey = '';
        this.button = null;
        this.id = null;
    }

    get title() {
        return this._props.Title || this._props.Id || this.bus;
    }

    get wanted() {
        return sniVisible(this._props.Status);
    }

    get hasMenu() {
        return !!this._menu && (this._menu.hasItems || this._props.ItemIsMenu);
    }

    get container() {
        return this.button?.container ?? null;
    }

    start() {
        this._fetch(0);
    }

    destroy() {
        this._cleanup.dispose();
        this.button?.destroy();
        this.button = null;
    }

    gicon() {
        return this.button?.icon.gicon ?? null;
    }

    // ---- D-Bus ---------------------------------------------------------------------------

    _fetch(ifaceIndex) {
        const iface = IFACES[ifaceIndex];
        Gio.DBus.session.call(this.bus, this.path, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [iface]), new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE,
            -1, this._cancellable, (conn, res) => {
                let props;
                try {
                    [props] = conn.call_finish(res).recursiveUnpack();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // Some apps only answer for the freedesktop name of the interface
                    if (ifaceIndex + 1 < IFACES.length && !this.button) {
                        this._fetch(ifaceIndex + 1);
                        return;
                    }
                    console.warn(`[Guava] status item ${this.bus}${this.path}: ${e.message}`);
                    return;
                }
                if (!props || (!Object.keys(props).length && ifaceIndex + 1 < IFACES.length && !this.button)) {
                    this._fetch(ifaceIndex + 1);
                    return;
                }
                this._iface = iface;
                this._props = props;
                this._apply();
            });
    }

    _refetchSoon() {
        if (this._idle)
            return;
        this._idle = this._cleanup.idle(() => {
            this._idle = 0;
            this._fetch(IFACES.indexOf(this._iface));
        }, { name: 'status item refresh' });
    }

    _apply() {
        const first = !this.button;
        if (first) {
            this.id = sniId(this._props.Id, this._props.Title, this.bus);
            this.button = new SniButton(this);
            for (const signal of SIGNALS) {
                const sid = Gio.DBus.session.signal_subscribe(this.bus, this._iface, signal, this.path, null,
                    Gio.DBusSignalFlags.NONE, () => this._refetchSoon());
                this._cleanup.add(() => Gio.DBus.session.signal_unsubscribe(sid));
            }
        }
        this.button.accessible_name = this.title;
        this._syncMenu();
        this._syncIcon();
        if (first)
            this._onReady(this);
        else
            this._onChanged(this);
    }

    _syncMenu() {
        const path = typeof this._props.Menu === 'string' && this._props.Menu !== '/' ? this._props.Menu : null;
        if (path === this._menuPath)
            return;
        this._menuPath = path;
        this._menuCleanup?.dispose();
        this._menuCleanup = null;
        this._menu = null;
        if (!path)
            return;
        this._menuCleanup = new CleanupRegistry();
        this._cleanup.add(() => this._menuCleanup?.dispose());
        this._menu = new DBusMenuClient({
            bus: this.bus, path, cleanup: this._menuCleanup, cancellable: this._cancellable,
            onChanged: () => {
                if (this.button?.menu.isOpen)
                    this.fillMenu(this.button.menu);
            },
        });
    }

    fillMenu(menu) {
        if (this._menu?.hasItems) {
            if (menu === this.button?.menu && !menu.isOpen)
                this._menu.aboutToShow();
            this._menu.fill(menu);
        } else {
            menu.removeAll();
            menu.addMenuItem(infoItem(this.title));
        }
    }

    /** Activate / SecondaryActivate at the pointer (the app places its window there). */
    call(method, event) {
        const [x, y] = event?.get_coords?.() ?? global.get_pointer();
        Gio.DBus.session.call(this.bus, this.path, this._iface, method,
            new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]), null, Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    // Activate is optional in the spec: fall back to the menu, if any
                    if (method === 'Activate' && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) && this._menu)
                        this.button?.menu.open();
                }
            });
    }

    /** "Activate" for the overflow chevron: the menu if there is one, else Activate. */
    activate() {
        if (this.hasMenu)
            this.button?.menu.open();
        else
            this.call('Activate', null);
    }

    scroll(event) {
        const dir = event.get_scroll_direction();
        let delta = 0;
        let orientation = 'vertical';
        if (dir === Clutter.ScrollDirection.UP)
            delta = -1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            delta = 1;
        else if (dir === Clutter.ScrollDirection.LEFT || dir === Clutter.ScrollDirection.RIGHT) {
            delta = dir === Clutter.ScrollDirection.LEFT ? -1 : 1;
            orientation = 'horizontal';
        } else {
            const [dx, dy] = event.get_scroll_delta();
            orientation = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
            delta = Math.round((orientation === 'vertical' ? dy : dx) * 10);
        }
        if (!delta)
            return;
        Gio.DBus.session.call(this.bus, this.path, this._iface, 'Scroll',
            new GLib.Variant('(is)', [delta, orientation]), null, Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_e) {
                    // Scroll is optional
                }
            });
    }

    // ---- icon ------------------------------------------------------------------------------

    _syncIcon() {
        const p = this._props;
        const attention = p.Status === 'NeedsAttention';
        const name = (attention && p.AttentionIconName) || p.IconName || '';
        const pixmaps = (attention && p.AttentionIconPixmap?.length ? p.AttentionIconPixmap : p.IconPixmap) ?? [];
        const themePath = p.IconThemePath || '';
        const key = `${name}|${themePath}|${pixmaps.length}|${pixmaps[0]?.[0] ?? 0}|${attention}`;
        if (key === this._iconKey && !pixmaps.length)
            return;
        this._iconKey = key;
        if (name.startsWith('/')) {
            this._setGicon(new Gio.FileIcon({ file: Gio.File.new_for_path(name) }));
        } else if (name && themePath) {
            this._findInThemePath(name, themePath, pixmaps);
        } else if (name) {
            this._setGicon(new Gio.ThemedIcon({ name }));
        } else {
            this._setPixmap(pixmaps);
        }
    }

    _setGicon(gicon) {
        if (!this.button)
            return;
        this.button.icon.gicon = gicon;
        this._onChanged(this);
    }

    /** Electron apps ship their icon as <IconThemePath>/<IconName>.png. */
    _findInThemePath(name, themePath, pixmaps) {
        const candidates = ['png', 'svg'].flatMap(ext => [
            `${themePath}/${name}.${ext}`,
            `${themePath}/hicolor/${ICON_SIZE}x${ICON_SIZE}/apps/${name}.${ext}`,
            `${themePath}/hicolor/scalable/apps/${name}.${ext}`,
        ]);
        const next = i => {
            if (i >= candidates.length) {
                // Not in its own folder: the icon theme, else the pixmap
                if (pixmaps.length)
                    this._setPixmap(pixmaps);
                else
                    this._setGicon(new Gio.ThemedIcon({ name }));
                return;
            }
            const file = Gio.File.new_for_path(candidates[i]);
            file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
                this._cancellable, (f, res) => {
                    try {
                        f.query_info_finish(res);
                    } catch (e) {
                        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            next(i + 1);
                        return;
                    }
                    this._setGicon(new Gio.FileIcon({ file: f }));
                });
        };
        next(0);
    }

    _setPixmap(pixmaps) {
        if (!this.button)
            return;
        const list = pixmaps.map(([width, height, bytes]) => ({ width, height, bytes }));
        const index = pickPixmap(list, ICON_SIZE * (St.ThemeContext.get_for_stage(global.stage).scale_factor || 1));
        if (index < 0) {
            this._setGicon(new Gio.ThemedIcon({ name: 'image-missing-symbolic' }));
            return;
        }
        const { width, height, bytes } = list[index];
        const data = argbToRgba(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        try {
            const content = St.ImageContent.new_with_preferred_size(width, height);
            const context = global.stage.context.get_backend().get_cogl_context();
            content.set_bytes(context, new GLib.Bytes(data), Cogl.PixelFormat.RGBA_8888, width, height, width * 4);
            // St.ImageContent is a GIcon: St.Icon draws it at the icon size
            this.button.icon.gicon = content;
            this._onChanged(this);
        } catch (e) {
            console.warn(`[Guava] status item ${this.title}: pixmap failed: ${e.message}`);
            this._setGicon(new Gio.ThemedIcon({ name: 'image-missing-symbolic' }));
        }
    }
}
