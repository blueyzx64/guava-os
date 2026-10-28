// SPDX-License-Identifier: GPL-3.0-or-later
// Window tiling, macOS 15 Sequoia model (feature id 'window-tiling', key windows-tiling).
//
// One engine for every way in: dragging to the edges, corners and menu bar (drag.js), the
// menu bar's Window menu (the 'window-tile-requested' event), and the Ctrl+Super shortcuts. The geometry is pure (model.js);
// this adapter only reads frames and calls move_resize_frame.
//
// Mutter has no public tiling API (meta_window_tile is not introspected), so Guava's tiles are
// plain frames that Guava tracks itself in a TileBook: which window holds which zone, and the
// frame it had before ("Return to Previous Size"). Tiles follow the work area of core/layout.js
// (menu bar and dock excluded): a change re-applies them, so a tile never sits under the dock.
// GNOME's own edge tiling (org.gnome.mutter edge-tiling) is off while this runs, through
// core/originals, so the two never preview at once; the user's value comes back on disable.
//
// Return from full screen: Mutter puts a window back to its pre-fullscreen frame, which for a
// tiled window is its tile; the tile is re-applied then, in case the work area changed meanwhile.
//
// Shell API: Meta.Window (move_resize_frame, move_frame, get_frame_rect, resizeable,
// get_stable_sequence, size-changed), Main.layoutManager.monitors.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import { CleanupRegistry } from '../../lib/disposables.js';
import { GuavaSettings } from '../../lib/settings.js';
import { Keybindings } from '../../lib/keybindings.js';
import { normalizeAccel } from '../../lib/keybindingsModel.js';
import { isMaximized, maximizeWindow, unmaximizeWindow } from '../../lib/compat.js';
import { SettingOwner } from '../../core/originals.js';
import { WindowState } from '../../core/windowState.js';

import {
    SHORTCUTS, TILE_MARGIN, TileBook, centerRect, parseAction, pickBindable, placeIn,
    planArrangement, untileRect, zoneRect,
} from './model.js';
import { TileDrag } from './drag.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';

const rectOf = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const areaKey = a => (a ? `${a.x},${a.y},${a.width},${a.height}` : '');

export class WindowTiling {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._book = null;
        this._tracked = new Map(); // Meta.Window -> {cleanup, settle}
        this._areas = new Map();   // monitor -> work area key last applied
        this._keys = null;
        this._skipped = [];
    }

    enable() {
        const { settings, events } = this._ctx;
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(settings);
        ks.attach(cleanup);
        this._ks = ks;
        this._desktop = this._ctx.desktop.acquire(cleanup);
        this._layout = this._ctx.layout.acquire(cleanup);
        this._book = new TileBook();

        const edgeTiling = new SettingOwner(this._ctx.originals,
            new Gio.Settings({ schema_id: MUTTER_SCHEMA }), 'edge-tiling', { type: 'b', value: false });
        edgeTiling.sync(true);
        cleanup.add(() => edgeTiling.release());

        cleanup.add(() => {
            for (const win of [...this._tracked.keys()])
                this._forget(win, false);
            this._book.clear();
            this._areas.clear();
            WindowState.clearFlag('tiled');
        });

        new TileDrag(this._ctx, cleanup, ks, this._layout, this).enable();

        events.on('window-tile-requested', ({ window, mode }) => this.perform(window, mode), cleanup);
        events.on('work-area-changed', ({ monitor }) => this._reflow(monitor), cleanup);
        ks.watch('windows-tile-margins', () => this._reflowAll());

        // Other Guava shortcuts come and go with their features: re-check what is free
        this._bindShortcuts();
        ks.watch(SHORTCUTS.map(s => s.key), () => this._bindShortcuts());
        events.on('feature-changed', ({ id }) => {
            if (id !== 'window-tiling')
                this._bindShortcuts();
        }, cleanup);
        cleanup.add(() => {
            this._keys?.dispose();
            this._keys = null;
        });
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // ---- public API (Window menu, drag, probes) ----------------------------------------------

    /** Shortcut keys left unbound because their accelerator is taken: [{key, accel, with}]. */
    get skippedShortcuts() {
        return this._skipped;
    }

    /** @returns {?string} the zone a window holds ('center' counts), or null */
    zoneOf(win) {
        return win ? this._book?.get(win.get_stable_sequence())?.zone ?? null : null;
    }

    /** True when "Return to Previous Size" has something to do. */
    canRestore(win) {
        return !!win && (this._book?.has(win.get_stable_sequence()) || isMaximized(win));
    }

    /**
     * Run a tiling action (see model.js parseAction) on a window.
     *
     * @returns {boolean} false when the action or the window does not apply
     */
    perform(win, action) {
        const parsed = parseAction(action);
        if (!parsed || !this._tileable(win))
            return false;
        switch (parsed.kind) {
        case 'zone':
            this.tile(win, parsed.name);
            break;
        case 'center':
            this._center(win);
            break;
        case 'restore':
            this.restore(win);
            break;
        case 'arrange':
            this._arrange(win, parsed.name);
            break;
        }
        return true;
    }

    /** The rect a zone gives on a monitor (the drag preview shows it). */
    zoneRectOn(zone, monitor) {
        const area = this._layout.workArea(monitor);
        return area ? zoneRect(zone, area, this._margin()) : null;
    }

    /** Put a window in a zone of its monitor. */
    tile(win, zone, monitor = win.get_monitor()) {
        const area = this._layout.workArea(monitor);
        if (!area)
            return;
        const restore = this._leaveStates(win);
        const id = win.get_stable_sequence();
        this._book.tile(id, { zone, monitor, restore });
        this._track(win);
        this._place(win, zone, zoneRect(zone, area, this._margin()), area);
        this._areas.set(monitor, areaKey(area));
        WindowState.set(win, 'tiled', true);
        this._ctx.events.emit('window-tiled', { window: win, zone });
    }

    /** "Return to Previous Size": the frame from before the first tile, or unmaximize. */
    restore(win) {
        const id = win.get_stable_sequence();
        if (!this._book.has(id)) {
            if (isMaximized(win))
                unmaximizeWindow(win);
            return;
        }
        const restore = this._book.untile(id);
        this._forget(win, true);
        if (restore.maximized) {
            maximizeWindow(win);
            return;
        }
        const area = this._layout.workArea(win.get_monitor());
        const rect = area && !this._inside(restore, area) ? centerRect(area, restore.width, restore.height) : restore;
        win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    }

    /** A tiled window is being dragged away: back to its pre-tile size under the pointer. */
    untileForDrag(win, pointer) {
        const id = win.get_stable_sequence();
        const restore = this._book.untile(id);
        this._forget(win, true);
        if (!restore || restore.maximized)
            return;
        const r = untileRect(rectOf(win.get_frame_rect()), restore, pointer);
        win.move_resize_frame(true, r.x, r.y, r.width, r.height);
    }

    /** A grab started on the window: the user moves or resizes it, Guava stops placing it. */
    cancelSettle(win) {
        const entry = this._tracked.get(win);
        if (entry?.settle) {
            entry.cleanup.release(entry.settle);
            entry.settle = 0;
        }
    }

    isTiled(win) {
        const zone = this.zoneOf(win);
        return !!zone && zone !== 'center';
    }

    // ---- actions ----------------------------------------------------------------------------

    _tileable(win) {
        return !!win && win.get_window_type() === Meta.WindowType.NORMAL && !win.minimized;
    }

    _margin() {
        return this._ks.bool('windows-tile-margins') ? TILE_MARGIN : 0;
    }

    // Leave full screen and maximize before a tile; returns the frame to restore later
    _leaveStates(win) {
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        const maximized = isMaximized(win);
        if (maximized)
            unmaximizeWindow(win);
        return { ...rectOf(win.get_frame_rect()), maximized };
    }

    _center(win) {
        const monitor = win.get_monitor();
        const area = this._layout.workArea(monitor);
        if (!area)
            return;
        const restore = this._leaveStates(win);
        const id = win.get_stable_sequence();
        // Center keeps the size; it is remembered so Return to Previous Size goes back
        const wasTiled = this.isTiled(win);
        this._book.tile(id, { zone: 'center', monitor, restore });
        this._track(win);
        const frame = win.get_frame_rect();
        const c = centerRect(area, frame.width, frame.height);
        win.move_frame(true, c.x, c.y);
        if (wasTiled) {
            WindowState.set(win, 'tiled', false);
            this._ctx.events.emit('window-tiled', { window: win, zone: null });
        }
    }

    // Fill & Arrange with the most recently used windows of the workspace and monitor
    _arrange(win, name) {
        const model = this._desktop.model;
        const monitor = win.get_monitor();
        const id = win.get_stable_sequence();
        const others = model.windows({ workspace: model.workspaces.active, monitor, minimized: false })
            .filter(w => w.type === 'normal' && w.id !== id)
            .map(w => w.id);
        const plan = planArrangement(name, [id, ...others]);
        const placed = [];
        for (const { id: wid, zone } of plan) {
            const w = this._desktop.metaWindow(wid);
            if (!w)
                continue;
            this.tile(w, zone, monitor);
            placed.push(w);
        }
        // Stack them as on macOS: the active window ends on top and focused
        for (const w of placed.reverse())
            w.raise();
        win.activate(global.get_current_time());
    }

    // ---- geometry ---------------------------------------------------------------------------

    _inside(r, area) {
        return r.x >= area.x && r.y >= area.y &&
            r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;
    }

    // Apply a zone rect. A fixed-size window keeps its size and is centred in the tile; a
    // window whose minimum size beats the tile is placed again once its real size arrives
    // (Wayland clients resize asynchronously).
    _place(win, zone, rect, area) {
        this.cancelSettle(win);
        const entry = this._tracked.get(win);
        if (!win.resizeable) {
            const f = win.get_frame_rect();
            const p = placeIn(zone, rect, f, area);
            win.move_frame(true, p.x, p.y);
            return;
        }
        win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        const now = win.get_frame_rect();
        if (!entry || (now.width === rect.width && now.height === rect.height))
            return;
        entry.settle = entry.cleanup.connect(win, 'size-changed', () => {
            entry.cleanup.release(entry.settle);
            entry.settle = 0;
            const f = win.get_frame_rect();
            if (f.width === rect.width && f.height === rect.height)
                return;
            const p = placeIn(zone, rect, f, area);
            if (p.x !== f.x || p.y !== f.y)
                win.move_frame(true, p.x, p.y);
        });
    }

    _reapply(win) {
        const tile = this._book.get(win.get_stable_sequence());
        if (!tile || tile.zone === 'center' || win.is_fullscreen())
            return;
        const area = this._layout.workArea(tile.monitor);
        if (area)
            this._place(win, tile.zone, zoneRect(tile.zone, area, this._margin()), area);
    }

    // The work area of a monitor changed (dock, menu bar, struts): move its tiles with it
    _reflow(monitor) {
        const key = areaKey(this._layout.workArea(monitor));
        if (!key || this._areas.get(monitor) === key)
            return;
        this._areas.set(monitor, key);
        for (const id of this._book.onMonitor(monitor)) {
            const win = this._desktop.metaWindow(id);
            if (win)
                this._reapply(win);
        }
    }

    _reflowAll() {
        for (const win of this._tracked.keys())
            this._reapply(win);
    }

    // ---- per-window tracking ------------------------------------------------------------------

    _track(win) {
        if (this._tracked.has(win))
            return;
        const cleanup = new CleanupRegistry();
        const entry = { cleanup, settle: 0 };
        this._tracked.set(win, entry);
        cleanup.connect(win, 'unmanaged', () => {
            this._book.untile(win.get_stable_sequence());
            this._forget(win, false);
        });
        // Back from full screen: Mutter restores the pre-fullscreen frame (the tile); re-apply
        // it so it matches the work area of now
        cleanup.connect(win, 'notify::fullscreen', () => {
            if (!win.is_fullscreen())
                this._reapply(win);
        });
        // Maximized by something else (double-click, Super+Up): it no longer holds its tile
        const onMaximized = () => {
            if (!isMaximized(win))
                return;
            this._book.untile(win.get_stable_sequence());
            this._forget(win, true);
        };
        cleanup.connect(win, 'notify::maximized-horizontally', onMaximized);
        cleanup.connect(win, 'notify::maximized-vertically', onMaximized);
    }

    _forget(win, announce) {
        const entry = this._tracked.get(win);
        if (!entry)
            return;
        this._tracked.delete(win);
        entry.cleanup.dispose();
        if (WindowState.set(win, 'tiled', false) && announce)
            this._ctx.events.emit('window-tiled', { window: win, zone: null });
    }

    // ---- shortcuts ------------------------------------------------------------------------------

    // Bind every tiling shortcut whose accelerator is free: not a stock GNOME binding, and not
    // another Guava shortcut that is registered now (Stage Manager's Ctrl+Super+Down while it
    // runs). Rebuilt when a shortcut key changes or a feature starts or stops.
    _bindShortcuts() {
        this._keys?.dispose();
        this._keys = new CleanupRegistry();
        const settings = this._ctx.settings;
        const entries = SHORTCUTS.map(({ key }) => ({ key, accels: settings.get_strv(key) }));
        const taken = new Map();
        for (const { accel, with: owner } of Keybindings.conflicts(entries.flatMap(e => e.accels)))
            taken.set(normalizeAccel(accel), owner);
        const mine = new Set(SHORTCUTS.map(s => s.key));
        for (const name of Keybindings.names()) {
            if (mine.has(name))
                continue;
            for (const accel of settings.get_strv(name))
                taken.set(normalizeAccel(accel), `Guava ${name}`);
        }
        const { bind, skipped } = pickBindable(entries, taken);
        this._skipped = skipped;
        for (const { key, action } of SHORTCUTS) {
            if (!bind.includes(key))
                continue;
            Keybindings.add(this._keys, key, settings, () => {
                const win = global.display.focus_window;
                this.perform(win, action);
            });
        }
    }
}
