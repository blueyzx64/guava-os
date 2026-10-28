// SPDX-License-Identifier: GPL-3.0-or-later
// The desktop icon layer of the primary monitor: a non-reactive container in global.window_group
// (stacked by core/desktopLayers.js above the wallpaper and below the widgets and every window)
// that holds the icon tiles and the rubber band. Only the tiles are reactive, so a click on empty
// wallpaper still reaches the wallpaper (its menu, Show Desktop's click); the rubber band starts
// from a press on the wallpaper that the stage reports first (so are the keys).
//
// It draws what the feature tells it (sync, refresh) and turns pointer input into calls on the
// feature, which owns the model: select, open, drop, menu, keys.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { RANKS } from '../../core/desktopLayers.js';
import { IconTile } from './tile.js';
import { bandRect, cellAt, cellRect, isDoubleClick, isDrag, rubberBandHits } from './model.js';

export class IconLayer {
    /**
     * @param {object} feature the DesktopIcons instance
     * @param {{x: number, y: number, width: number, height: number}} monitor stage px
     */
    constructor(feature, monitor) {
        this._f = feature;
        this._ctx = feature.ctx;
        this.monitor = monitor;
        this._cleanup = new CleanupRegistry();
        this._tiles = new Map();     // key -> IconTile
        this._cells = new Map();
        this._grid = null;
        this._metrics = null;
        this._press = null;          // a press on a tile: {tile, startX, startY, dragging, ...}
        this._lastPress = null;      // the previous press on an icon, for double clicks
        this._band = null;           // a press on the wallpaper: {x0, y0, rects, hits, base}

        this.actor = new St.Widget({
            name: 'guava-desktop-icons',
            style_class: 'guava-di-layer',
            reactive: false,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            accessible_name: feature._('Desktop icons'),
            accessible_role: Atk.Role.PANEL,
        });
        this._rubber = new St.Widget({ style_class: 'guava-di-band', visible: false, reactive: false });
        this.actor.add_child(this._rubber);
        feature.desktopLayers.stack(this._cleanup, { id: 'icons', rank: RANKS.icons, actor: this.actor });
        this._cleanup.connect(global.stage, 'captured-event', (_s, event) => this._stageEvent(event));
    }

    get tiles() {
        return this._tiles;
    }

    // ---- drawing -----------------------------------------------------------------------------

    /**
     * Show these entries at these cells.
     *
     * @param {object[]} entries
     * @param {Map<string, {col: number, row: number}>} cells
     * @param {object} grid model grid (model.js gridFor)
     * @param {object} metrics model metrics (model.js metricsFor)
     * @param {boolean} animate ease icons that moved
     */
    sync(entries, cells, grid, metrics, animate) {
        if (this._metrics && this._metrics.icon !== metrics.icon)
            this._dropAll();
        this._grid = grid;
        this._metrics = metrics;
        this._cells = cells;
        this._endPress();
        const keys = new Set(entries.map(e => e.key));
        for (const key of [...this._tiles.keys()]) {
            if (!keys.has(key))
                this._drop(key);
        }
        for (const entry of entries) {
            let tile = this._tiles.get(entry.key);
            const fresh = !tile;
            if (fresh)
                tile = this._create(entry);
            else
                tile.update(entry);
            this._place(tile, cells.get(entry.key), animate && !fresh);
        }
        this.refresh();
    }

    _create(entry) {
        const tile = new IconTile(entry, this._metrics);
        this.actor.add_child(tile.actor);
        const c = new CleanupRegistry();
        c.connect(tile.actor, 'button-press-event', (_a, event) => this._tilePress(tile, event));
        tile.cleanup = c;
        this._tiles.set(entry.key, tile);
        return tile;
    }

    _drop(key) {
        const tile = this._tiles.get(key);
        this._tiles.delete(key);
        if (!tile)
            return;
        tile.cleanup.dispose();
        tile.destroy();
    }

    _dropAll() {
        for (const key of [...this._tiles.keys()])
            this._drop(key);
    }

    _place(tile, cell, animate) {
        const inside = !!cell && cell.col < this._grid.cols;
        tile.actor.visible = inside;
        if (!inside)
            return;
        const r = cellRect(cell, this._grid);
        const x = r.x - this.monitor.x;
        const y = r.y - this.monitor.y;
        const a = tile.actor;
        if (animate && (a.x !== x || a.y !== y))
            this._ctx.motion.ease(a, { x, y }, { duration: 'short', curve: 'standard' }, tile.cleanup);
        else
            a.set_position(x, y);
    }

    /** Redraw the selection, the keyboard focus and which side has the focus. */
    refresh() {
        const f = this._f;
        for (const [key, tile] of this._tiles) {
            tile.setState({
                selected: f.selection.has(key),
                active: f.desktopActive,
                focused: f.keyboardNav && f.keyboardFocus === key,
            });
        }
    }

    /** Where an icon is on screen (stage px), or null. */
    rectOf(key) {
        const tile = this._tiles.get(key);
        if (!tile)
            return null;
        const [x, y] = tile.actor.get_transformed_position();
        return { x, y, width: tile.actor.width, height: tile.actor.height };
    }

    // ---- keyboard focus ------------------------------------------------------------------------

    /**
     * Give the desktop the keyboard: no window keeps the focus (as macOS makes Finder active),
     * so the keys reach this layer.
     */
    takeFocus() {
        global.display.unset_input_focus(global.get_current_time());
        this.actor.grab_key_focus();
    }

    // ---- pointer on an icon ---------------------------------------------------------------------

    _tilePress(tile, event) {
        if (this._press || this._f.busy)
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        const mods = this._mods(event);
        this.takeFocus();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._f.contextMenu(event.get_coords(), tile.key);
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const now = { key: tile.key, time: event.get_time(), x, y };
        const settings = Clutter.Settings.get_default();
        const double = isDoubleClick(this._lastPress, now,
            { time: settings.double_click_time, distance: settings.double_click_distance });
        this._lastPress = double ? null : now;
        if (double && !mods.ctrl && !mods.shift) {
            this._f.openSelection(tile.key);
            return Clutter.EVENT_STOP;
        }
        const joined = this._f.press(tile.key, mods);
        const grab = global.stage.grab(tile.actor);
        const press = {
            tile, grab, startX: x, startY: y, dragging: false, joined, mods,
            moving: [], cleanup: new CleanupRegistry(),
        };
        this._press = press;
        press.cleanup.connect(tile.actor, 'motion-event', (_a, ev) => this._tileMotion(ev));
        press.cleanup.connect(tile.actor, 'button-release-event', (_a, ev) => this._tileRelease(ev));
        return Clutter.EVENT_STOP;
    }

    _mods(event) {
        const state = event.get_state();
        return {
            ctrl: (state & Clutter.ModifierType.CONTROL_MASK) !== 0,
            shift: (state & Clutter.ModifierType.SHIFT_MASK) !== 0,
        };
    }

    _tileMotion(event) {
        const p = this._press;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - p.startX;
        const dy = y - p.startY;
        if (!p.dragging) {
            if (!isDrag(dx, dy))
                return Clutter.EVENT_STOP;
            p.dragging = true;
            // Every selected icon moves with the one under the pointer
            for (const key of this._f.selection.keys) {
                const t = this._tiles.get(key);
                if (!t)
                    continue;
                this.actor.set_child_above_sibling(t.actor, null);
                t.actor.add_style_class_name('guava-di-dragging');
                p.moving.push({ tile: t, x: t.actor.x, y: t.actor.y });
            }
        }
        for (const m of p.moving)
            m.tile.actor.set_position(m.x + dx, m.y + dy);
        return Clutter.EVENT_STOP;
    }

    _tileRelease() {
        const p = this._press;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        const dragged = p.dragging;
        const key = p.tile.key;
        let delta = null;
        if (dragged) {
            const a = p.tile.actor;
            const cell = cellAt(this.monitor.x + a.x + a.width / 2, this.monitor.y + a.y + a.height / 2, this._grid);
            const from = this._cells.get(key);
            delta = { col: cell.col - from.col, row: cell.row - from.row };
        }
        this._endPress();
        if (dragged)
            this._f.drop(delta);
        else if (!p.joined && !p.mods.ctrl && !p.mods.shift)
            this._f.collapse(key);
        return Clutter.EVENT_STOP;
    }

    _endPress() {
        const p = this._press;
        if (!p)
            return;
        this._press = null;
        p.cleanup.dispose();
        p.grab.dismiss();
        for (const m of p.moving)
            m.tile.actor.remove_style_class_name('guava-di-dragging');
    }

    // ---- the rubber band -----------------------------------------------------------------------

    // The stage sees every event first. A primary press on the wallpaper of this monitor starts
    // a band; the event always goes on, so the wallpaper keeps its menu and its click.
    _stageEvent(event) {
        const type = event.type();
        // Keys: while this layer has the keyboard (takeFocus) and no modal (the rename field,
        // a menu) is open. The layer itself is not reactive, so the stage hands them over.
        if (type === Clutter.EventType.KEY_PRESS) {
            return global.stage.key_focus === this.actor && !Main.modalCount
                ? this._f.keyPressed(event) : Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_PRESS)
            return this._bandPress(event);
        if (!this._band)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION)
            this._bandMove(event);
        else if (type === Clutter.EventType.BUTTON_RELEASE)
            this._endBand();
        return Clutter.EVENT_PROPAGATE;
    }

    _bandPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._band || this._press || this._f.busy)
            return Clutter.EVENT_PROPAGATE;
        if (Main.overview.visible || !(global.stage.get_event_actor(event) instanceof Meta.BackgroundActor))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const m = this.monitor;
        if (x < m.x || y < m.y || x >= m.x + m.width || y >= m.y + m.height)
            return Clutter.EVENT_PROPAGATE;
        const mods = this._mods(event);
        const additive = mods.ctrl || mods.shift;
        this._band = {
            x0: x, y0: y, active: false, hits: '',
            base: additive ? [...this._f.selection.keys] : [],
            rects: null,
        };
        if (!additive)
            this._f.setSelection([]);
        return Clutter.EVENT_PROPAGATE;
    }

    _bandMove(event) {
        const b = this._band;
        const [x, y] = event.get_coords();
        if (!b.active) {
            if (!isDrag(x - b.x0, y - b.y0))
                return;
            b.active = true;
            b.rects = this._tileRects();
            this._rubber.visible = true;
        }
        const r = bandRect(b.x0, b.y0, x, y);
        this._rubber.set_position(r.x - this.monitor.x, r.y - this.monitor.y);
        this._rubber.set_size(r.width, r.height);
        const hits = rubberBandHits(r, b.rects);
        const sig = hits.join('\0');
        if (sig === b.hits)
            return;
        b.hits = sig;
        this._f.setSelection([...b.base, ...hits.filter(k => !b.base.includes(k))]);
    }

    // The part of each icon the band must touch to select it: the cell without its margins
    _tileRects() {
        const rects = new Map();
        const dx = Math.round(this._grid.cellW * 0.1);
        const dy = Math.round(this._grid.cellH * 0.06);
        for (const [key, cell] of this._cells) {
            if (cell.col >= this._grid.cols)
                continue;
            const r = cellRect(cell, this._grid);
            rects.set(key, { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy });
        }
        return rects;
    }

    _endBand() {
        this._band = null;
        this._rubber.visible = false;
    }

    destroy() {
        this._endPress();
        this._endBand();
        this._dropAll();
        this._cleanup.dispose();
        this.actor.destroy();
    }
}
