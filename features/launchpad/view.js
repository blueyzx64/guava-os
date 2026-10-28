// SPDX-License-Identifier: GPL-3.0-or-later
// LaunchpadView: the full-screen grid (macOS 11–15 Launchpad), built on open and destroyed on
// close, so a closed Launchpad costs nothing.
//
//   overlay (primary monitor, reactive; a click on empty space closes, or ends jiggle mode)
//     backdrop   the wallpaper decoded to a tiny picture and stretched (a faux blur, no
//                shader), under a dim layer
//     search     the field at the top; typing anywhere goes there
//     viewport   clips the strip; the strip holds every page side by side and slides
//     dots       one per page
//     folder     the open folder (FolderPanel), above everything
//
// Icons are placed by index (model.gridMetrics); a reorder only moves actors. Drags use the
// Shell's DND (ui/dnd.js makeDraggable; the strip's delegate is the drop target). Decisions
// (paging, drops, folders, keys, search, ⓧ) are in model.js; writes go through store.js.
//
// Shell API: ui/dnd.js, Main.pushModal,
// Shell.App create_icon_texture / activate, St.ImageContent (the backdrop), checked on GNOME 50.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import * as A11y from '../../lib/a11y.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { Glass } from '../../lib/glass.js';
import { decodeWallpaper, resolveWallpaper } from '../../lib/wallpaperDecode.js';
import { parseHexColor, wallpaperSource } from '../../lib/wallpaperModel.js';
import {
    cleanFolderName, dropAction, gridMetrics, jiggleParams, moveId, navigate, pageCount, pageOf,
    searchApps,
} from './model.js';

// The backdrop picture: small enough to look blurred once stretched over the screen
const BACKDROP_WIDTH = 48;
// The last decoded backdrop (a few KB), so opening Launchpad again decodes nothing
let backdropCache = { key: null, pixbuf: null };
// Folder grid columns (macOS folders are narrower than the main grid)
const FOLDER_COLUMNS = 5;
// A drag held at a page edge turns the page after this long (macOS feels about the same)
const EDGE_FLIP_MS = 550;
// Share of the side margin that counts as the edge
const EDGE_ZONE = 0.5;
// The pointer rests this long on a slot before the icons make room there
const REFLOW_MS = 200;

const KEYS = new Map([
    [Clutter.KEY_Left, 'left'], [Clutter.KEY_Right, 'right'], [Clutter.KEY_Up, 'up'],
    [Clutter.KEY_Down, 'down'], [Clutter.KEY_Page_Up, 'pageup'], [Clutter.KEY_Page_Down, 'pagedown'],
    [Clutter.KEY_Home, 'home'], [Clutter.KEY_End, 'end'],
]);
const isAlt = sym => sym === Clutter.KEY_Alt_L || sym === Clutter.KEY_Alt_R;

/** Forget the cached backdrop (Launchpad stopped). */
export function dropBackdropCache() {
    backdropCache = { key: null, pixbuf: null };
}

/** One icon: an app or a folder, with its label and (in jiggle mode) its ⓧ. */
class Tile {
    constructor(view, item) {
        this.view = view;
        this.id = item.id;
        this.kind = item.kind;
        this.cleanup = new CleanupRegistry();
        const m = view.metrics;
        this.actor = this.cleanup.actor(new St.Button({
            style_class: 'guava-launchpad-tile',
            accessible_name: item.name,
            reactive: true, can_focus: true, track_hover: true,
            width: m.cellWidth, height: m.cellHeight,
        }));
        this.actor._delegate = this;
        // The part that wobbles: the icon and its badge (not the label)
        this.body = new St.Widget({ layout_manager: new Clutter.FixedLayout(), width: m.cellWidth, height: m.cellHeight });
        this.iconBox = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x: Math.round((m.cellWidth - m.icon) / 2), y: 6, width: m.icon, height: m.icon,
        });
        this.iconBox.set_pivot_point(0.5, 0.5);
        this.label = new St.Label({
            style_class: 'guava-launchpad-label', text: item.name,
            x: 4, y: m.icon + 14, width: m.cellWidth - 8,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        this.body.add_child(this.iconBox);
        this.body.add_child(this.label);
        this.actor.set_child(this.body);
        this.setItem(item);

        this.cleanup.connect(this.actor, 'clicked', () => view.activate(this));
        this.cleanup.connect(this.actor, 'button-press-event', (_a, e) => view.pressStarted(this, e));
        this.cleanup.connect(this.actor, 'button-release-event', () => view.pressEnded());
        this._draggable = DND.makeDraggable(this.actor);
        this.cleanup.connect(this._draggable, 'drag-begin', () => view.dragBegin(this));
        this.cleanup.connect(this._draggable, 'drag-cancelled', () => view.dragEnd(this, false));
        this.cleanup.connect(this._draggable, 'drag-end', (_d, _t, ok) => view.dragEnd(this, ok));
        this.jiggle = null;
        this.badge = null;
    }

    /** Fill the icon for an item (an app's icon, or the folder's mini grid). */
    setItem(item) {
        this.item = item;
        this.iconBox.destroy_all_children();
        const m = this.view.metrics;
        if (item.kind === 'folder') {
            const box = new St.Widget({ style_class: 'guava-launchpad-folder', layout_manager: new Clutter.FixedLayout(), width: m.icon, height: m.icon });
            box.set_style(`border-radius: ${Math.round(m.icon * 0.22)}px;`);
            const pad = Math.round(m.icon * 0.1), gap = Math.round(m.icon * 0.04);
            const mini = Math.floor((m.icon - 2 * pad - 2 * gap) / 3);
            item.apps.slice(0, 9).forEach((id, i) => {
                const icon = this.view.store.app(id)?.create_icon_texture(mini);
                if (!icon)
                    return;
                icon.set_position(pad + (i % 3) * (mini + gap), pad + Math.floor(i / 3) * (mini + gap));
                box.add_child(icon);
            });
            this.iconBox.add_child(box);
        } else {
            const app = this.view.store.app(item.id);
            const icon = app?.create_icon_texture(m.icon);
            if (icon)
                this.iconBox.add_child(icon);
        }
        this.label.text = item.name;
        this.actor.accessible_name = item.name;
    }

    // ---- DND delegate (the source side) ----

    getDragActor() {
        const m = this.view.metrics;
        if (this.kind === 'folder')
            return new Clutter.Clone({ source: this.iconBox, width: m.icon, height: m.icon });
        return this.view.store.app(this.id)?.create_icon_texture(m.icon) ?? new St.Widget();
    }

    getDragActorSource() {
        return this.iconBox;
    }

    destroy() {
        this.destroyed = true;
        this.cleanup.dispose();
    }
}

/** The open folder: a glass panel with the folder's name (editable) and its apps. */
class FolderPanel {
    constructor(view, folderTile) {
        this.view = view;
        this.folderId = folderTile.id;
        this.cleanup = new CleanupRegistry();
        const m = view.metrics;
        const _ = view.gettext;
        const members = folderTile.item.apps;
        this.order = [...members];
        const cols = Math.min(FOLDER_COLUMNS, Math.max(1, members.length));
        const rows = Math.min(m.rows, Math.ceil(members.length / cols));
        this.cols = cols;
        this.perPage = cols * rows;

        // Full-screen catcher: a click outside closes the folder; a drag leaving it closes it too
        this.layer = this.cleanup.actor(new St.Widget({
            style_class: 'guava-launchpad-folder-layer', reactive: true,
            width: view.monitor.width, height: view.monitor.height,
        }));
        this.layer._delegate = {
            handleDragOver: () => {
                this.view.closeFolder();
                return DND.DragMotionResult.CONTINUE;
            },
        };
        this.cleanup.connect(this.layer, 'button-press-event', (a, e) => {
            if (global.stage.get_event_actor(e) !== a)
                return Clutter.EVENT_PROPAGATE;
            this.view.closeFolder();
            return Clutter.EVENT_STOP;
        });

        const width = cols * m.cellWidth + 64;
        const height = rows * m.cellHeight + 104;
        this.panel = new St.BoxLayout({
            style_class: 'guava-launchpad-folder-panel', orientation: Clutter.Orientation.VERTICAL,
            reactive: true, width, height,
            accessible_name: folderTile.item.name, accessible_role: A11y.Role.DIALOG,
            x: Math.round((view.monitor.width - width) / 2), y: Math.round((view.monitor.height - height) / 2),
        });
        this.panel.set_pivot_point(0.5, 0.5);
        this.name = new St.Entry({
            style_class: 'guava-launchpad-folder-name', text: folderTile.item.name,
            can_focus: true, x_align: Clutter.ActorAlign.CENTER, hint_text: _('Folder name'),
            accessible_name: _('Folder name'),
        });
        this.name.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        this.name.clutter_text.connect('activate', () => this._rename());
        this.cleanup.connect(this.name.clutter_text, 'key-focus-out', () => this._rename());
        this.panel.add_child(this.name);
        this.grid = new St.Widget({ layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true });
        this.grid._delegate = this;
        this.panel.add_child(this.grid);
        this.layer.add_child(this.panel);
        this._glass = Glass.attach(this.panel, { surface: 'overlays', role: 'content', radius: 32 });
        this.cleanup.add(() => this._glass.destroy());

        this.tiles = new Map();
        for (const id of members) {
            const app = view.store.app(id);
            if (!app)
                continue;
            const tile = new Tile(view, { kind: 'app', id, name: app.get_name() });
            tile.folderId = this.folderId;
            this.cleanup.add(() => tile.destroy());
            this.tiles.set(id, tile);
            this.grid.add_child(tile.actor);
        }
        this.layout(false);
    }

    layout(animate) {
        const m = this.view.metrics;
        this.order.forEach((id, i) => {
            const tile = this.tiles.get(id);
            if (!tile)
                return;
            const x = (i % this.cols) * m.cellWidth + 16;
            const y = Math.floor(i / this.cols) * m.cellHeight;
            if (animate)
                this.view.motion.ease(tile.actor, { x, y }, { duration: 'short', curve: 'standard' }, tile.cleanup);
            else
                tile.actor.set_position(x, y);
        });
    }

    _rename() {
        const name = cleanFolderName(this.name.text);
        if (name)
            this.view.store.renameFolder(this.folderId, name);
    }

    // ---- reorder inside the folder (drop target) ----

    _slot(x, y) {
        const m = this.view.metrics;
        const col = Math.max(0, Math.min(this.cols - 1, Math.floor((x - 16) / m.cellWidth)));
        const row = Math.max(0, Math.floor(y / m.cellHeight));
        return Math.min(this.order.length - 1, row * this.cols + col);
    }

    handleDragOver(source, _actor, x, y) {
        if (source?.folderId !== this.folderId)
            return DND.DragMotionResult.CONTINUE;
        const next = moveId(this.order, source.id, this._slot(x, y));
        if (next.join() !== this.order.join()) {
            this.order = next;
            this.layout(true);
        }
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (source?.folderId !== this.folderId)
            return false;
        this.view.store.reorderFolder(this.folderId, this.order);
        return true;
    }

    destroy() {
        this.cleanup.dispose();
    }
}

export class LaunchpadView {
    /**
     * @param {object} host the feature (index.js): store, uninstall, motion, gettext, close()
     */
    constructor(host) {
        this.host = host;
        this.store = host.store;
        this.motion = host.motion;
        this.gettext = host.gettext;
        this.cleanup = new CleanupRegistry();
        this.monitor = Main.layoutManager.primaryMonitor;
        this.metrics = gridMetrics(this.monitor);
        this.tiles = new Map();         // id -> Tile (top-level items and search results)
        this.items = [];                // top-level items, in order
        this.order = [];                // their ids (the preview order while dragging)
        this.shown = [];                // ids on screen (order, or search results)
        this.page = 0;
        this.focus = -1;
        this.query = '';
        this.jiggling = false;
        this._jiggleByAlt = false;
        this.folder = null;
        this._drag = null;              // {tile, dropIndex, target}
        this._closedFolder = null;
        this.alert = null;
        this._flip = 0;
        this._reflow = 0;
        this._building = 0;
        this._press = 0;
        this._scrollLock = false;
        this._grab = null;
        this._build();
    }

    // ---- build -------------------------------------------------------------------------------

    _build() {
        const mon = this.monitor;
        const m = this.metrics;
        const _ = this.gettext;
        this.overlay = this.cleanup.actor(new St.Widget({
            name: 'guava-launchpad', style_class: 'guava-launchpad', reactive: true, can_focus: true,
            accessible_name: _('Launchpad'), accessible_role: A11y.Role.DIALOG,
            layout_manager: new Clutter.FixedLayout(),
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        }));
        this.backdrop = new St.Widget({ width: mon.width, height: mon.height });
        this.overlay.add_child(this.backdrop);
        this.overlay.add_child(new St.Widget({ style_class: 'guava-launchpad-dim', width: mon.width, height: mon.height }));

        this.content = new St.Widget({ layout_manager: new Clutter.FixedLayout(), width: mon.width, height: mon.height });
        this.content.set_pivot_point(0.5, 0.5);
        this.overlay.add_child(this.content);

        const searchWidth = Math.min(280, mon.width - 32);
        this.search = new St.Entry({
            style_class: 'guava-launchpad-search', hint_text: _('Search'), accessible_name: _('Search Apps'), can_focus: true,
            x: Math.round((mon.width - searchWidth) / 2), y: m.searchTop, width: searchWidth,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic', style_class: 'guava-launchpad-search-icon' }),
        });
        this.content.add_child(this.search);
        this._searchGlass = Glass.attach(this.search, { surface: 'overlays', role: 'bar', radius: 10 });
        this.cleanup.add(() => this._searchGlass.destroy());
        this.cleanup.connect(this.search.clutter_text, 'text-changed', () => this._setQuery(this.search.text));
        this.cleanup.connect(this.search.clutter_text, 'activate', () => this._activateFocus());

        this.viewport = new St.Widget({
            layout_manager: new Clutter.FixedLayout(), clip_to_allocation: true,
            x: 0, y: m.top, width: mon.width, height: m.gridHeight,
        });
        this.strip = new St.Widget({ layout_manager: new Clutter.FixedLayout(), height: m.gridHeight });
        this.strip._delegate = this;
        this.viewport.add_child(this.strip);
        this.content.add_child(this.viewport);

        this.dots = new St.BoxLayout({ style_class: 'guava-launchpad-dots', y: m.dotsTop, reactive: true });
        this.content.add_child(this.dots);

        this.cleanup.connect(this.overlay, 'button-press-event', (a, e) => this._backgroundPress(a, e));
        this.cleanup.connect(this.overlay, 'scroll-event', (_a, e) => this._scroll(e));
        this.cleanup.connect(this.overlay, 'captured-event', (_a, e) => this._captured(e));
    }

    /** Re-read the store (apps installed or removed, folders, order) and lay out again. */
    refresh() {
        if (this._drag)
            return;
        this.items = this.store.items();
        this.order = this.items.map(i => i.id);
        const byId = new Map(this.items.map(i => [i.id, i]));
        for (const [id, tile] of this.tiles) {
            const item = byId.get(id);
            if (!item && !this._isSearchHit(id)) {
                tile.destroy();
                this.tiles.delete(id);
            } else if (item && (item.kind !== tile.kind || item.name !== tile.item.name ||
                (item.apps ?? []).join() !== (tile.item.apps ?? []).join())) {
                tile.setItem(item);
            }
        }
        this._buildTiles(this.metrics.perPage * (this.page + 1));
        this._setQuery(this.query, true);
        if (this.jiggling)
            this._applyJiggle(true);
    }

    // Opening must not wait for every icon: the pages up to `upTo` icons are built now, the
    // others one page at a time while the Shell is idle
    _buildTiles(upTo) {
        const missing = this.items.filter(item => !this.tiles.has(item.id));
        missing.slice(0, upTo).forEach(item => this._tile(item));
        if (missing.length > upTo && !this._building) {
            this._building = this.cleanup.idle(() => {
                this._building = 0;
                this._buildTiles(this.metrics.perPage);
                this._layout(false);
                if (this.jiggling)
                    this._applyJiggle(true);
            }, { name: 'launchpad-build-pages' });
        }
    }

    _isSearchHit(id) {
        return !!this.query && this.shown.includes(id);
    }

    _tile(item) {
        let tile = this.tiles.get(item.id);
        if (!tile) {
            tile = new Tile(this, item);
            this.tiles.set(item.id, tile);
            this.strip.add_child(tile.actor);
        }
        return tile;
    }

    async _loadBackdrop() {
        const cancellable = new Gio.Cancellable();
        this.cleanup.add(() => cancellable.cancel());
        try {
            const bg = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const iface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            const source = wallpaperSource({
                pictureUri: bg.get_string('picture-uri'), pictureUriDark: bg.get_string('picture-uri-dark'),
                options: bg.get_string('picture-options'), primaryColor: bg.get_string('primary-color'),
                colorScheme: iface.get_string('color-scheme'),
            });
            // Opaque from the start (windows never show through): the wallpaper's own colour,
            // then the picture once it is decoded
            const [r, g, b] = source.kind === 'color' ? source.color
                : parseHexColor(bg.get_string('primary-color')) ?? [40, 44, 56];
            this.backdrop.set_style(`background-color: rgb(${r},${g},${b});`);
            if (source.kind !== 'file')
                return;
            const h = Math.max(1, Math.round(BACKDROP_WIDTH * this.monitor.height / this.monitor.width));
            const slide = await resolveWallpaper(source.uri, cancellable);
            const key = `${slide.uri} ${h}`;
            let pixbuf = backdropCache.key === key ? backdropCache.pixbuf : null;
            if (!pixbuf) {
                pixbuf = await decodeWallpaper(slide.uri, BACKDROP_WIDTH, h, false, cancellable);
                if (cancellable.is_cancelled())
                    return;
                backdropCache = { key, pixbuf };
            }
            const image = St.ImageContent.new_with_preferred_size(pixbuf.get_width(), pixbuf.get_height());
            const context = global.stage.context.get_backend().get_cogl_context();
            image.set_bytes(context, pixbuf.read_pixel_bytes(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride());
            // A plain actor carries the picture (St widgets paint their background instead)
            const picture = new Clutter.Actor({
                content: image, content_gravity: Clutter.ContentGravity.RESIZE_FILL,
                width: this.monitor.width, height: this.monitor.height,
            });
            picture.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
            this.backdrop.add_child(picture);
        } catch (e) {
            // No picture (no loader, missing file): the dim layer alone stays
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`[Guava] launchpad: no backdrop picture: ${e.message}`);
        }
    }

    // ---- open / close ------------------------------------------------------------------------

    /** Show it, with the macOS zoom-in. Returns false when the Shell refused the grab. */
    open() {
        // Above everything, the menu bar and the dock included (macOS covers them too)
        Main.layoutManager.uiGroup.add_child(this.overlay);
        this.refresh();
        this._loadBackdrop();
        this._grab = Main.pushModal(this.overlay, { actionMode: Shell.ActionMode.POPUP });
        if (!this._grab) {
            this.destroy();
            return false;
        }
        this.search.grab_key_focus();
        this.overlay.opacity = 0;
        this.content.set_scale(1.08, 1.08);
        this.motion.ease(this.overlay, { opacity: 255 }, { duration: 'medium', curve: 'standard' }, this.cleanup);
        this.motion.ease(this.content, { scale_x: 1, scale_y: 1 }, { duration: 'medium', curve: 'emphasized' }, this.cleanup);
        return true;
    }

    /** Zoom out and destroy. `done` runs once it is gone. */
    close(done) {
        this._popGrab();
        this.overlay.reactive = false;
        this.motion.ease(this.content, { scale_x: 1.08, scale_y: 1.08 }, { duration: 'short', curve: 'exit' }, this.cleanup);
        this.motion.ease(this.overlay, { opacity: 0 }, {
            duration: 'short', curve: 'exit',
            onDone: () => {
                this.destroy();
                done?.();
            },
        }, this.cleanup);
    }

    _popGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    destroy() {
        this._popGrab();
        this._closeAlert();
        this.folder?.destroy();
        this.folder = null;
        this._closedFolder?.destroy();
        this._closedFolder = null;
        for (const tile of this.tiles.values())
            tile.destroy();
        this.tiles.clear();
        this.cleanup.dispose();
    }

    // ---- layout and pages --------------------------------------------------------------------

    _position(i) {
        const m = this.metrics;
        const page = pageOf(i, m.perPage);
        const slot = i - page * m.perPage;
        return [page * this.monitor.width + m.left + (slot % m.columns) * m.cellWidth,
            Math.floor(slot / m.columns) * m.cellHeight];
    }

    _layout(animate) {
        const shown = new Set(this.shown);
        for (const [id, tile] of this.tiles) {
            tile.actor.visible = shown.has(id);
            if (!tile.actor.visible)
                tile.actor.remove_style_pseudo_class('selected');
        }
        this.shown.forEach((id, i) => {
            const tile = this.tiles.get(id);
            if (!tile)
                return;
            const [x, y] = this._position(i);
            if (animate)
                this.motion.ease(tile.actor, { x, y }, { duration: 'short', curve: 'standard' }, tile.cleanup);
            else
                tile.actor.set_position(x, y);
        });
        const pages = this.pageCount;
        this.strip.width = pages * this.monitor.width;
        this._syncDots();
        if (this.page >= pages)
            this.setPage(pages - 1, false);
        this._syncFocus();
    }

    get pageCount() {
        return pageCount(this.shown.length + (this._drag ? 1 : 0), this.metrics.perPage);
    }

    setPage(page, animate = true) {
        const p = Math.max(0, Math.min(this.pageCount - 1, page));
        this.page = p;
        const x = -p * this.monitor.width;
        if (animate) {
            this._scrollLock = true;
            this.motion.ease(this.strip, { translation_x: x }, {
                duration: 'medium', curve: 'standard', onDone: () => {
                    this._scrollLock = false;
                },
            }, this.cleanup);
        } else {
            this.strip.translation_x = x;
        }
        this._syncDots();
    }

    _syncDots() {
        const pages = this.pageCount;
        const _ = this.gettext;
        if (this.dots.get_n_children() !== pages) {
            this.dots.destroy_all_children();
            for (let i = 0; i < pages; i++) {
                const dot = new St.Button({
                    style_class: 'guava-launchpad-dot', can_focus: false,
                    accessible_name: _('Page %d').replace('%d', String(i + 1)),
                });
                dot.connect('clicked', () => this.setPage(i));
                this.dots.add_child(dot);
            }
        }
        this.dots.get_children().forEach((d, i) => {
            d.checked = i === this.page;
        });
        this.dots.visible = pages > 1;
        const [w] = this.dots.get_preferred_width(-1);
        this.dots.x = Math.round((this.monitor.width - w) / 2);
    }

    _scroll(event) {
        if (this._scrollLock || this.folder)
            return Clutter.EVENT_STOP;
        const dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(d) >= 0.5)
                step = Math.sign(d);
        } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
            step = 1;
        } else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
            step = -1;
        }
        if (step)
            this.setPage(this.page + step);
        return Clutter.EVENT_STOP;
    }

    // ---- search ------------------------------------------------------------------------------

    _setQuery(text, force = false) {
        const q = (text ?? '').trim();
        if (q === this.query && !force)
            return;
        const changed = q !== this.query;
        this.query = q;
        if (q) {
            if (this.jiggling)
                this.setJiggle(false);
            this.shown = searchApps(q, this.store.apps());
            for (const id of this.shown) {
                const app = this.store.app(id);
                if (app && !this.tiles.has(id))
                    this._tile({ kind: 'app', id, name: app.get_name() });
            }
            this.focus = this.shown.length ? 0 : -1;
        } else {
            // Search hits that are not top-level items go away with the search
            const top = new Set(this.order);
            for (const [id, tile] of this.tiles) {
                if (!top.has(id)) {
                    tile.destroy();
                    this.tiles.delete(id);
                }
            }
            this.shown = [...this.order];
            if (changed)
                this.focus = -1;
        }
        this._layout(false);
        if (changed)
            this.setPage(0, false);
    }

    // ---- focus and keys ----------------------------------------------------------------------

    _syncFocus() {
        this.shown.forEach((id, i) => {
            const tile = this.tiles.get(id);
            if (i === this.focus)
                tile?.actor.add_style_pseudo_class('selected');
            else
                tile?.actor.remove_style_pseudo_class('selected');
        });
    }

    _captured(event) {
        const type = event.type();
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();
        if (isAlt(sym)) {
            // macOS: holding Option makes the icons jiggle for as long as it is held
            if (type === Clutter.EventType.KEY_PRESS && !this.jiggling && !this.query && !this.folder) {
                this._jiggleByAlt = true;
                this.setJiggle(true);
            } else if (type === Clutter.EventType.KEY_RELEASE && this._jiggleByAlt) {
                this._jiggleByAlt = false;
                this.setJiggle(false);
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        if (this.alert) {
            if (sym === Clutter.KEY_Escape)
                this._closeAlert();
            return sym === Clutter.KEY_Escape ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        if (sym === Clutter.KEY_Escape) {
            if (this.folder)
                this.closeFolder();
            else if (this.jiggling)
                this.setJiggle(false);
            else if (this.query)
                this.search.text = '';
            else
                this.host.close();
            return Clutter.EVENT_STOP;
        }
        if (this.folder)
            return Clutter.EVENT_PROPAGATE;
        const key = KEYS.get(sym);
        if (key) {
            const m = this.metrics;
            this.focus = navigate(this.focus, key, { columns: m.columns, perPage: m.perPage, count: this.shown.length });
            this._syncFocus();
            const p = pageOf(this.focus, m.perPage);
            if (this.focus >= 0 && p !== this.page)
                this.setPage(p);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            this._activateFocus();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activateFocus() {
        const id = this.shown[this.focus >= 0 ? this.focus : 0];
        const tile = id && this.tiles.get(id);
        if (tile)
            this.activate(tile);
    }

    // ---- clicks ------------------------------------------------------------------------------

    activate(tile) {
        if (tile.kind !== 'folder' && this.jiggling)
            return;
        if (tile.kind === 'folder') {
            this.openFolder(tile);
            return;
        }
        const app = this.store.app(tile.id);
        if (!app)
            return;
        this.host.close();
        app.activate();
    }

    _backgroundPress(actor, event) {
        const hit = global.stage.get_event_actor(event);
        if (hit !== actor && hit !== this.viewport && hit !== this.strip && hit !== this.content)
            return Clutter.EVENT_PROPAGATE;
        if (this.jiggling)
            this.setJiggle(false);
        else
            this.host.close();
        return Clutter.EVENT_STOP;
    }

    /** A press on a tile: held long enough (the system long-press time), it starts jiggle mode. */
    pressStarted(tile, event) {
        this.pressEnded();
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this.query)
            return Clutter.EVENT_PROPAGATE;
        const ms = Clutter.Settings.get_default().long_press_duration;
        this._press = this.cleanup.timeout(ms, () => {
            this._press = 0;
            if (!this.jiggling && !this._drag)
                this.setJiggle(true);
            return GLib.SOURCE_REMOVE;
        }, { name: 'launchpad-long-press' });
        return Clutter.EVENT_PROPAGATE;
    }

    pressEnded() {
        if (this._press) {
            this.cleanup.release(this._press);
            this._press = 0;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- jiggle mode and ⓧ -------------------------------------------------------------------

    setJiggle(on) {
        if (this.jiggling === on)
            return;
        this.jiggling = on;
        if (on)
            this.host.probeUninstall().then(() => {
                if (!this.jiggling)
                    return;
                this.shown.forEach(id => this.tiles.has(id) && this._syncBadge(this.tiles.get(id), true));
                this.folder?.tiles.forEach(t => this._syncBadge(t, true));
            });
        this._applyJiggle(on);
    }

    _applyJiggle(on) {
        this._jiggleTiles(this.shown.map(id => this.tiles.get(id)).filter(Boolean), on);
        if (this.folder)
            this._jiggleTiles([...this.folder.tiles.values()], on);
    }

    /** Start or stop the wobble (none under reduced motion) and the ⓧ of these tiles. */
    _jiggleTiles(tiles, on) {
        const env = this.motion.env;
        const wobble = on && env.animations && !env.reducedMotion;
        let i = 0;
        for (const tile of tiles) {
            tile.jiggle?.cancel();
            tile.jiggle = null;
            tile.iconBox.rotation_angle_z = 0;
            if (wobble) {
                const p = jiggleParams(i);
                tile.iconBox.rotation_angle_z = -p.angle;
                tile.jiggle = this.motion.ease(tile.iconBox, { rotation_angle_z: p.angle }, {
                    duration: p.periodMs / 2, curve: 'move', delay: p.delayMs, repeat: -1, autoReverse: true,
                }, tile.cleanup);
            }
            this._syncBadge(tile, on);
            i++;
        }
    }

    _syncBadge(tile, on) {
        const app = tile.kind === 'app' ? this.store.app(tile.id) : null;
        const rule = on && app && this.host.canDelete ? this.host.uninstall.ruleFor(app) : null;
        if (!rule) {
            tile.badge?.destroy();
            tile.badge = null;
            return;
        }
        if (tile.badge)
            return;
        const _ = this.gettext;
        tile.badge = new St.Button({
            style_class: 'guava-launchpad-delete', reactive: true, can_focus: true,
            accessible_name: _('Delete “%s”').replace('%s', app.get_name()),
            child: new St.Icon({ icon_name: 'window-close-symbolic', style_class: 'guava-launchpad-delete-icon' }),
        });
        tile.badge.set_position(-6, -6);
        tile.badge.connect('clicked', () => this._confirmDelete(tile, app, rule));
        tile.iconBox.add_child(tile.badge);
    }

    /**
     * The macOS alert (inside Launchpad, which sits above every Shell layer): the app's icon,
     * "Delete “App”?", what will happen, Cancel and Delete. Delete asks the owner to remove it.
     */
    _confirmDelete(tile, app, rule) {
        this._closeAlert();
        const _ = this.gettext;
        const reg = new CleanupRegistry();
        const layer = reg.actor(new St.Widget({
            style_class: 'guava-launchpad-alert-layer', reactive: true,
            width: this.monitor.width, height: this.monitor.height,
        }));
        const box = new St.BoxLayout({
            style_class: 'guava-launchpad-alert', orientation: Clutter.Orientation.VERTICAL,
            reactive: true, width: 280,
            accessible_name: _('Delete “%s”?').replace('%s', app.get_name()), accessible_role: A11y.Role.ALERT,
        });
        box.add_child(new St.Bin({ child: app.create_icon_texture(64), x_align: Clutter.ActorAlign.CENTER }));
        box.add_child(new St.Label({
            style_class: 'guava-launchpad-alert-title', text: _('Delete “%s”?').replace('%s', app.get_name()),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const body = new St.Label({
            style_class: 'guava-launchpad-alert-body', x_align: Clutter.ActorAlign.CENTER,
            text: _('GNOME Software will remove this app. You can install it again from GNOME Software.'),
        });
        body.clutter_text.line_wrap = true;
        body.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(body);
        const buttons = new St.BoxLayout({ style_class: 'guava-launchpad-alert-buttons', x_expand: true });
        const cancel = new St.Button({ style_class: 'guava-launchpad-alert-button', label: _('Cancel'), x_expand: true, can_focus: true });
        const del = new St.Button({
            style_class: 'guava-launchpad-alert-button default', label: _('Delete'), x_expand: true, can_focus: true,
        });
        cancel.connect('clicked', () => this._closeAlert());
        del.connect('clicked', () => {
            this._closeAlert();
            this.host.requestUninstall(rule, app);
        });
        buttons.add_child(cancel);
        buttons.add_child(del);
        box.add_child(buttons);
        layer.add_child(box);
        this.overlay.add_child(layer);
        const [, natH] = box.get_preferred_height(280);
        box.set_position(Math.round((this.monitor.width - 280) / 2), Math.round((this.monitor.height - natH) / 2.4));
        box.set_pivot_point(0.5, 0.5);
        const glass = Glass.attach(box, { surface: 'overlays', role: 'content', radius: 18 });
        reg.add(() => glass.destroy());
        box.set_scale(0.9, 0.9);
        layer.opacity = 0;
        this.motion.ease(layer, { opacity: 255 }, { duration: 'short', curve: 'standard' }, reg);
        this.motion.ease(box, { scale_x: 1, scale_y: 1 }, { duration: 'short', curve: 'emphasized' }, reg);
        del.grab_key_focus();
        this.alert = { reg, cancel, del, title: app.get_name() };
    }

    _closeAlert() {
        const alert = this.alert;
        if (!alert)
            return;
        this.alert = null;
        alert.reg.dispose();
        this.search.grab_key_focus();
    }

    /** The owner removed it: the macOS "poof" (it then leaves on installed-changed). */
    poof(appId) {
        const tile = [...this.tiles.values()].find(t => t.id === appId || t.id === `${appId}.desktop`);
        if (!tile)
            return;
        tile.jiggle?.cancel();
        this.motion.ease(tile.iconBox, { scale_x: 0.2, scale_y: 0.2, opacity: 0 }, { duration: 'short', curve: 'exit' }, tile.cleanup);
    }

    // ---- folders -----------------------------------------------------------------------------

    openFolder(tile) {
        this.closeFolder(true);
        const panel = new FolderPanel(this, tile);
        this.folder = panel;
        this.overlay.add_child(panel.layer);
        // Expand out of the folder icon (macOS): start at the icon, scaled down, then grow
        const [ix, iy] = tile.iconBox.get_transformed_position();
        const [iw, ih] = tile.iconBox.get_transformed_size();
        const p = panel.panel;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        p.translation_x = ix - this.monitor.x + iw / 2 - cx;
        p.translation_y = iy - this.monitor.y + ih / 2 - cy;
        p.set_scale(iw / p.width, ih / p.height);
        panel.layer.opacity = 0;
        this.motion.ease(panel.layer, { opacity: 255 }, { duration: 'short', curve: 'standard' }, panel.cleanup);
        this.motion.ease(p, { translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1 },
            { duration: 'medium', curve: 'emphasized' }, panel.cleanup);
        this.motion.ease(this.content, { opacity: 90 }, { duration: 'short', curve: 'standard' }, this.cleanup);
        if (this.jiggling)
            this._jiggleTiles([...panel.tiles.values()], true);
    }

    closeFolder(immediate = false) {
        const panel = this.folder;
        if (!panel)
            return;
        this.folder = null;
        panel.layer.reactive = false;
        this.motion.ease(this.content, { opacity: 255 }, { duration: 'short', curve: 'standard' }, this.cleanup);
        this.search.grab_key_focus();
        if (this._drag) {
            panel.layer.hide();
            this._closedFolder = panel;
            return;
        }
        if (immediate) {
            panel.destroy();
            return;
        }
        this.motion.ease(panel.panel, { scale_x: 0.85, scale_y: 0.85 }, { duration: 'short', curve: 'exit' }, panel.cleanup);
        this.motion.ease(panel.layer, { opacity: 0 }, {
            duration: 'short', curve: 'exit', onDone: () => panel.destroy(),
        }, panel.cleanup);
    }

    // ---- drag and drop -----------------------------------------------------------------------

    dragBegin(tile) {
        this.pressEnded();
        if (this.query || !this.store.writable) {
            this._drag = { tile, inert: true };
            return;
        }
        // A drag from the grid starts on its own slot; one from a folder has none yet
        this._drag = { tile, dropIndex: tile.folderId ? -1 : this.order.indexOf(tile.id), pendingIndex: -1, target: null };
        tile.actor.opacity = 0;
        if (tile.folderId)
            this._drag.order = [...this.order];
    }

    dragEnd(tile, _ok) {
        const drag = this._drag;
        this._cancelReflow();
        this._drag = null;
        this._cancelFlip();
        this._setTarget(null);
        if (!drag)
            return;
        if (!tile.destroyed)
            tile.actor.opacity = 255;
        // A folder closed by dragging out of it is destroyed only now (the drag source lived in it)
        this._closedFolder?.destroy();
        this._closedFolder = null;
        if (!drag.inert)
            this.refresh();
    }

    _slotAt(x, y) {
        const m = this.metrics;
        const W = this.monitor.width;
        const page = Math.max(0, Math.floor(x / W));
        const lx = x - page * W - m.left;
        const col = Math.max(0, Math.min(m.columns - 1, Math.floor(lx / m.cellWidth)));
        const row = Math.max(0, Math.min(m.rows - 1, Math.floor(y / m.cellHeight)));
        return {
            page, index: page * m.perPage + row * m.columns + col,
            offset: { x: lx - col * m.cellWidth, y: y - row * m.cellHeight },
            edge: lx < -m.left * (1 - EDGE_ZONE) ? -1 : lx > m.gridWidth + m.left * (1 - EDGE_ZONE) ? 1 : 0,
        };
    }

    _setTarget(tile) {
        if (this._drag)
            this._drag.target = tile;
        for (const t of this.tiles.values()) {
            if (t === tile)
                t.actor.add_style_pseudo_class('drop');
            else
                t.actor.remove_style_pseudo_class('drop');
        }
    }

    _cancelReflow() {
        if (this._reflow) {
            this.cleanup.release(this._reflow);
            this._reflow = 0;
        }
        if (this._drag)
            this._drag.pendingIndex = -1;
    }

    _cancelFlip() {
        if (this._flip) {
            this.cleanup.release(this._flip);
            this._flip = 0;
        }
    }

    // The strip's DND delegate
    handleDragOver(source, _actor, x, y) {
        const drag = this._drag;
        if (!drag || drag.inert || !(source instanceof Tile))
            return DND.DragMotionResult.CONTINUE;
        const slot = this._slotAt(x, y);
        // Held at a page edge: turn the page (one more page while dragging past the last)
        if (slot.edge && !this._flip) {
            this._flip = this.cleanup.timeout(EDGE_FLIP_MS, () => {
                this._flip = 0;
                this.setPage(this.page + slot.edge);
                return GLib.SOURCE_REMOVE;
            }, { name: 'launchpad-edge-flip' });
        } else if (!slot.edge) {
            this._cancelFlip();
        }
        const others = this.order.filter(id => id !== source.id);
        const m = this.metrics;
        const underId = this.shown[slot.index];
        const under = underId && underId !== source.id ? this.tiles.get(underId) : null;
        const act = dropAction({
            dragKind: source.kind, targetKind: under?.kind ?? null, slot: slot.index,
            offset: slot.offset, cell: { width: m.cellWidth, height: m.cellHeight }, count: others.length + 1,
        });
        drag.action = act;
        if (act.action !== 'move') {
            this._cancelReflow();
            this._setTarget(under);
            return DND.DragMotionResult.MOVE_DROP;
        }
        this._setTarget(null);
        // Icons make room only once the pointer rests on a slot (macOS): every move re-arms the
        // wait, so a slow drag over an icon on the way to its centre (folder) never shifts it away
        if (act.index === drag.dropIndex) {
            this._cancelReflow();
        } else {
            this._cancelReflow();
            drag.pendingIndex = act.index;
            this._reflow = this.cleanup.timeout(REFLOW_MS, () => {
                this._reflow = 0;
                drag.pendingIndex = -1;
                drag.dropIndex = act.index;
                const next = [...others];
                next.splice(Math.min(act.index, next.length), 0, source.id);
                this.shown = next;
                this.order = next;
                this._layout(true);
                return GLib.SOURCE_REMOVE;
            }, { name: 'launchpad-reflow' });
        }
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        const drag = this._drag;
        if (!drag || drag.inert || !(source instanceof Tile) || !drag.action)
            return false;
        const perPage = this.metrics.perPage;
        const target = drag.target;
        if (drag.action.action === 'move' && drag.pendingIndex >= 0) {
            // Dropped before the icons made room: the drop goes where the pointer is
            drag.dropIndex = drag.pendingIndex;
            this.order = moveId(this.order.includes(source.id) ? this.order : [...this.order, source.id], source.id, drag.dropIndex);
        }
        const base = this.order.filter(id => id !== source.id);
        try {
            if (source.folderId) {
                // Out of a folder: onto the grid (at the drop place), or into another folder
                const at = drag.action.action === 'move' ? drag.dropIndex : null;
                const current = drag.order ?? base;
                this.store.removeFromFolder(current, source.folderId, source.id, at, perPage);
                const after = this.store.items().map(i => i.id);
                if (target && drag.action.action === 'into')
                    this.store.addToFolder(after, target.id, source.id, perPage);
                else if (target && drag.action.action === 'folder')
                    this.store.createFolder(after, source.id, target.id, perPage);
            } else if (target && drag.action.action === 'folder') {
                const order = [...this.items.map(i => i.id)];
                this.store.createFolder(order, source.id, target.id, perPage);
            } else if (target && drag.action.action === 'into') {
                this.store.addToFolder(this.items.map(i => i.id), target.id, source.id, perPage);
            } else {
                this.store.saveOrder(this.order, perPage);
            }
        } catch (e) {
            console.error('[Guava] launchpad: drop failed:', e);
        }
        return true;
    }
}

export { Tile };
