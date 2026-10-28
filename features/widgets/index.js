// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop widgets (Sonoma): widgets on the desktop, above the wallpaper and below windows.
//
// - One DesktopLayer (layer.js) per monitor in global.window_group, stacked by
//   core/desktopLayers.js above the wallpaper (and above the desktop icons, Guava's or DING's).
//   The cards' rectangles are published there, so Guava's desktop icons flow around them.
// - Drag a widget to place it on the snapping grid (Ctrl loosens it); right-click for its
//   size, its options and Remove; "Edit Widgets…" (the wallpaper's menu, or editWidgets()
//   for the Notification Center) opens the gallery (gallery.js).
// - Widget style (widgets-style): automatic dims them to monochrome while an app window is
//   in front and gives full colour when the desktop is (nothing focused: a wallpaper click,
//   Show Desktop, Stage Manager's desktop); monochrome always; full-color never.
// - Data runs only while the widgets can be seen: not in the overview and not under a
//   maximized or full-screen window (features/widgets/model.js widgetsLive). With no widget
//   placed nothing runs at all.
// - The layout is JSON in widgets-layout (core/widgets/model.js), keyed per monitor, so a
//   second screen's widgets come back with it. Nothing is placed by default (as Sonoma);
//   the gallery and the prefs offer "Add Default Widgets".
//
// Shell API (private, checked on 50.6): the wallpaper menu (lib/backgroundMenu.js),
// global.backend.get_monitor_manager() for connector names.

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { addBackgroundMenuItems } from '../../lib/backgroundMenu.js';
import { openContextMenu } from '../../lib/contextMenu.js';
import { GuavaSettings } from '../../lib/settings.js';
import { DesktopLayers } from '../../core/desktopLayers.js';
import { Widgets } from '../../core/widgets/index.js';
import {
    DEFAULT_WIDGETS, addItem, fitItems, gridFor, moveItem, monitorKey, parseLayout, rectOf,
    removeItem, resizeItem, serializeLayout, setConfig, snap, nearestFree,
} from '../../core/widgets/model.js';
import { DesktopLayer } from './layer.js';
import { Gallery } from './gallery.js';
import { widgetLook, widgetsLive, windowInFront } from './model.js';

const KEY_LAYOUT = 'widgets-layout';
const KEY_STYLE = 'widgets-style';
const SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large', extraLarge: 'Extra Large' };

export class DesktopWidgets {
    constructor(ctx, cleanup) {
        this.ctx = ctx;
        this._cleanup = cleanup;
        this._ = s => ctx.gettext(s);
        this.host = null;
        this.items = [];
        this._layers = new Map(); // monitor index -> DesktopLayer
        this._written = null;
        this._editing = false;
        this._menu = null;
    }

    enable() {
        const cleanup = this._cleanup;
        const ctx = this.ctx;
        this._ks = new GuavaSettings(ctx.settings);
        this._ks.attach(cleanup);
        this.host = Widgets.acquire(cleanup, ctx.gettext);
        this._desktop = ctx.desktop.acquire(cleanup);
        this._layout = ctx.layout.acquire(cleanup);
        this.desktopLayers = DesktopLayers.acquire(cleanup);
        this._reserve = this.desktopLayers.reserve(cleanup, 'widgets');
        this._gallery = new Gallery(this, cleanup);
        cleanup.add(() => this.closeGallery());
        cleanup.add(() => this._closeMenu());

        this._ks.watch([KEY_LAYOUT], () => this._loadLayout());
        this._ks.watch([KEY_STYLE], () => this._syncLook());
        const sync = () => this._syncState();
        for (const e of ['window-focused', 'window-changed', 'window-added', 'window-removed', 'workspaces-changed'])
            ctx.events.on(e, sync, cleanup);
        ctx.events.on('monitors-changed', () => this._rebuild(), cleanup);
        ctx.events.on('work-area-changed', () => this._syncLayers(), cleanup);
        cleanup.connect(Main.overview, 'showing', sync);
        cleanup.connect(Main.overview, 'hidden', sync);
        cleanup.connect(St.Settings.get(), 'notify::high-contrast', () => this._syncLook());

        cleanup.add(() => this._destroyLayers());
        this._rebuild();
        this._addBackgroundMenus(cleanup);
    }

    disable() {
        // Everything is in the cleanup registry
    }

    // ---- public (Notification Center, prefs probes) ---------------------------------------------

    /** Open the gallery in edit mode ("Edit Widgets…"). */
    editWidgets() {
        if (this._gallery.isOpen)
            return;
        this._editing = true;
        // The desktop comes forward while editing, as on macOS (Show Desktop, when it runs)
        const sd = this.ctx.features?.instance?.('show-desktop');
        this._revealed = false;
        if (sd && !sd.shown && this._desktop.model.focusedWindow) {
            try {
                sd.toggle();
                this._revealed = true;
            } catch (e) {
                console.error('[Guava] widgets: Show Desktop failed:', e);
            }
        }
        this._gallery.open();
        this._syncState();
    }

    closeGallery() {
        if (!this._gallery?.isOpen)
            return;
        this._gallery.close();
        this._editing = false;
        if (this._revealed) {
            this._revealed = false;
            const sd = this.ctx.features?.instance?.('show-desktop');
            if (sd?.shown)
                sd.toggle();
        }
        this._syncState();
    }

    get editing() {
        return this._editing;
    }

    /** Add a widget on the primary monitor. @returns {boolean} false when there is no room */
    add(kind, size) {
        const index = Main.layoutManager.primaryIndex;
        const key = this._keyOf(index);
        const r = addItem(this.items, { kind, size, monitor: key }, this._gridOf(index));
        if (!r.item) {
            Main.notify(this._('No room for the widget'), this._('Remove or move a widget first.'));
            return false;
        }
        this._commit(r.items);
        return true;
    }

    /** Place the default set ("Add Default Widgets"). */
    addDefaults() {
        for (const d of DEFAULT_WIDGETS)
            this.add(d.kind, d.size);
    }

    remove(id) {
        this._commit(removeItem(this.items, id));
    }

    resize(id, size) {
        const item = this.items.find(i => i.id === id);
        const index = this._indexOfKey(item?.monitor);
        if (index < 0)
            return false;
        const next = resizeItem(this.items, id, size, this._gridOf(index), this.host.registry.sizesFor(item.kind));
        if (!next)
            return false;
        this._commit(next);
        return true;
    }

    // ---- layer callbacks ------------------------------------------------------------------

    /** Where a dragged widget would land (px rect), for the snap outline. */
    previewMove(id, px, py, loose) {
        const item = this.items.find(i => i.id === id);
        const index = this._indexOfKey(item?.monitor);
        if (index < 0)
            return null;
        const grid = this._gridOf(index);
        const here = this.items.filter(i => i.monitor === item.monitor);
        const want = snap(px, py, item.size, grid, { loose });
        const pos = nearestFree(want.x, want.y, item.size, here, grid, { loose, self: id });
        return pos ? rectOf({ ...pos, size: item.size }, grid) : null;
    }

    moved(id, px, py, loose) {
        const item = this.items.find(i => i.id === id);
        const index = this._indexOfKey(item?.monitor);
        const next = index < 0 ? null : moveItem(this.items, id, px, py, this._gridOf(index), { loose });
        if (next)
            this._commit(next);
        else
            this._layers.get(index)?.replace(id);
    }

    openMenu(layer, card, coords) {
        this._closeMenu();
        const _ = this._;
        const { item, view } = card;
        this._menu = openContextMenu(this._cleanup, {
            source: layer.actor,
            coords,
            styleClass: 'guava-widgets-menu',
            onClosed: reg => this._closeMenu(reg),
            build: menu => {
                for (const s of this.host.registry.sizesFor(item.kind)) {
                    const mi = menu.addAction(_(SIZE_LABELS[s]), () => this.resize(item.id, s));
                    mi.setOrnament(s === item.size ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                }
                const options = view.menuItems();
                if (options.length) {
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    for (const o of options) {
                        const mi = menu.addAction(o.label, () => this._commit(setConfig(this.items, item.id, o.apply())));
                        mi.setOrnament(o.active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                    }
                }
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                menu.addAction(_('Edit Widgets…'), () => this.editWidgets());
                menu.addAction(_('Remove Widget'), () => this.remove(item.id));
            },
        });
    }

    _closeMenu(reg = this._menu) {
        if (!reg || reg !== this._menu)
            return;
        this._menu = null;
        reg.dispose();
    }

    // ---- monitors and grids ---------------------------------------------------------------------

    /** The usable area of a monitor: the work area Guava's layout service computes. */
    workArea(index) {
        return this._layout.workArea(index);
    }

    _gridOf(index) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return gridFor(this.workArea(index), scale);
    }

    // Stable monitor keys: connector + vendor/product/serial (Meta.Monitor), else the index
    _readKeys() {
        const keys = new Map();
        try {
            const mm = global.backend.get_monitor_manager();
            for (const m of mm.get_monitors?.() ?? []) {
                const connector = m.get_connector();
                const index = mm.get_monitor_for_connector(connector);
                if (index >= 0 && !keys.has(index)) {
                    keys.set(index, monitorKey({
                        connector, vendor: m.get_vendor?.(), product: m.get_product?.(), serial: m.get_serial?.(),
                    }));
                }
            }
        } catch (e) {
            console.error('[Guava] widgets: could not read monitor names:', e);
        }
        Main.layoutManager.monitors.forEach((_m, i) => {
            if (!keys.has(i))
                keys.set(i, monitorKey({ connector: `monitor-${i}` }));
        });
        return keys;
    }

    _keyOf(index) {
        return this._keys.get(index);
    }

    _indexOfKey(key) {
        for (const [i, k] of this._keys) {
            if (k === key)
                return i;
        }
        return -1;
    }

    _rebuild() {
        this._destroyLayers();
        this._keys = this._readKeys();
        this._loadLayout(true);
    }

    _destroyLayers() {
        for (const layer of this._layers.values())
            layer.destroy();
        this._layers.clear();
    }

    // Layers exist only for monitors that hold widgets, so an empty desktop has no actor
    _syncLayers() {
        if (!this._keys)
            return;
        const reserved = [];
        Main.layoutManager.monitors.forEach((m, index) => {
            const key = this._keyOf(index);
            const mine = this.items.filter(i => i.monitor === key);
            let layer = this._layers.get(index);
            if (!mine.length) {
                if (layer) {
                    layer.destroy();
                    this._layers.delete(index);
                }
                return;
            }
            if (!layer) {
                layer = new DesktopLayer(this, { index, key, x: m.x, y: m.y, width: m.width, height: m.height });
                this._layers.set(index, layer);
            }
            const grid = this._gridOf(index);
            // What does not fit this screen any more moves, in the view only; the stored
            // layout keeps the user's positions until they move something
            const fitted = fitItems(mine, grid);
            layer.sync(fitted, grid);
            // The desktop icons flow around the cards
            reserved.push(...fitted.map(i => rectOf(i, grid)));
        });
        this._reserve.set(reserved);
        this._syncState();
        this._gallery?.sync();
    }

    // ---- state: layout, look, liveness ----------------------------------------------------------

    _loadLayout(force = false) {
        const text = this._ks.string(KEY_LAYOUT);
        if (!force && text === this._written)
            return;
        this._written = text;
        this.items = parseLayout(text, k => this.host.registry.has(k));
        this._syncLayers();
    }

    _commit(items) {
        this.items = items;
        this._written = serializeLayout(items);
        this._ks.setString(KEY_LAYOUT, this._written);
        this._syncLayers();
    }

    _syncState() {
        this._syncLook();
        const model = this._desktop.model;
        const windows = model.windows();
        const workspace = model.workspaces.active;
        for (const [index, layer] of this._layers) {
            layer.setEditing(this._editing);
            layer.setLive(widgetsLive({
                overview: Main.overview.visible,
                editing: this._editing, monitor: index, workspace, windows,
            }));
        }
    }

    _syncLook() {
        const look = widgetLook({
            style: this._ks.string(KEY_STYLE),
            windowInFront: windowInFront(this._desktop.model.focusedWindow),
            editing: this._editing,
            highContrast: St.Settings.get().high_contrast,
        });
        for (const layer of this._layers.values())
            layer.setLook(look);
    }

    // ---- "Edit Widgets…" in the wallpaper's menu ------------------------------------------------

    _addBackgroundMenus(cleanup) {
        addBackgroundMenuItems(cleanup, (menu, at) => {
            const item = new PopupMenu.PopupMenuItem(this._('Edit Widgets…'));
            item.connect('activate', () => this.editWidgets());
            // After "Change Background…", as macOS puts it after "Change Wallpaper…"
            menu.addMenuItem(item, at.afterStock);
            return [item];
        });
    }
}
