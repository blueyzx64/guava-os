// SPDX-License-Identifier: GPL-3.0-or-later
// The pure half of the widget model that the desktop layer, the Notification Center and the
// notch's Widgets tab share: size classes, the snapping grid, layout persistence and the
// provider lifecycle. No gi:// imports; tested by tests/widgetsModel.test.js.
//
// Units. Positions are integers in GRID UNITS, half a cell: a widget normally sits on whole
// cells (even units); holding Ctrl while dragging loosens the snap to every unit. A cell is
// CELL px and cells are GAP px apart (design pixels; the caller passes the UI scale).
//
// Sizes follow macOS Sonoma and Sequoia: small 170x170, medium 364x170, large 364x382 and
// extra-large 715x382 points. The grid is 170 points per cell with 24 between cells, so a
// medium is exactly two smalls and the gap between them; large and extra-large are a little
// taller and narrower than their two-row, four-column footprint (SIZE_PX says by how much).

export const SIZE_ORDER = Object.freeze(['small', 'medium', 'large', 'extraLarge']);

/** Size classes in cells. */
export const SIZES = Object.freeze({
    small: Object.freeze({ cols: 1, rows: 1 }),
    medium: Object.freeze({ cols: 2, rows: 1 }),
    large: Object.freeze({ cols: 2, rows: 2 }),
    extraLarge: Object.freeze({ cols: 4, rows: 2 }),
});

export const CELL = 170;
export const GAP = 24;
/** The distance of two neighbouring cells, in design px. */
export const PITCH = CELL + GAP;
/** Space kept from the edges of the area, in design px. */
export const MARGIN = 20;
export const LAYOUT_VERSION = 1;

const UNITS_PER_CELL = 2;

/** The drawn size of each size class, in design px (macOS's own numbers). */
export const SIZE_PX = Object.freeze({
    small: Object.freeze({ width: 170, height: 170 }),
    medium: Object.freeze({ width: 364, height: 170 }),
    large: Object.freeze({ width: 364, height: 382 }),
    extraLarge: Object.freeze({ width: 715, height: 382 }),
});

export const isSize = size => Object.prototype.hasOwnProperty.call(SIZES, size);

/** Size in grid units. */
export function sizeUnits(size) {
    const s = SIZES[size];
    return { w: s.cols * UNITS_PER_CELL, h: s.rows * UNITS_PER_CELL };
}

/** The next larger or smaller allowed size, or null. */
export function stepSize(size, allowed, direction) {
    const order = SIZE_ORDER.filter(s => allowed.includes(s));
    const i = order.indexOf(size) + direction;
    return i >= 0 && i < order.length ? order[i] : null;
}

// ---- the grid ---------------------------------------------------------------------------

/**
 * The grid of one monitor.
 *
 * @param {{x: number, y: number, width: number, height: number}} area usable area (px)
 * @param {number} [scale] UI scale factor
 * @returns {{x: number, y: number, unit: number, cell: number, gap: number, units: {w: number, h: number}}}
 *   x, y: the origin in px; unit: px per grid unit; units: how many fit
 */
export function gridFor(area, scale = 1) {
    const cell = CELL * scale;
    const gap = GAP * scale;
    const pitch = cell + gap;
    const margin = MARGIN * scale;
    const cols = Math.max(1, Math.floor((area.width - 2 * margin + gap) / pitch));
    const rows = Math.max(1, Math.floor((area.height - 2 * margin + gap) / pitch));
    // The grid hangs from the top-right corner, where Sonoma starts; leftover space goes left
    const usedW = cols * pitch - gap;
    return {
        x: area.x + area.width - margin - usedW,
        y: area.y + margin,
        unit: pitch / UNITS_PER_CELL,
        cell,
        gap,
        units: { w: cols * UNITS_PER_CELL, h: rows * UNITS_PER_CELL },
    };
}

/**
 * The pixel rectangle of an item. A card that is narrower than its footprint (extra-large)
 * sits against the footprint's right edge, where the widgets hang from.
 */
export function rectOf(item, grid) {
    const { w } = sizeUnits(item.size);
    const scale = grid.cell / CELL;
    const px = SIZE_PX[item.size];
    const footW = (w / UNITS_PER_CELL) * (grid.cell + grid.gap) - grid.gap;
    const width = px.width * scale;
    return {
        x: grid.x + item.x * grid.unit + footW - width,
        y: grid.y + item.y * grid.unit,
        width,
        height: px.height * scale,
    };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Does a position keep the item inside the grid? */
export function fits(x, y, size, grid) {
    const { w, h } = sizeUnits(size);
    return x >= 0 && y >= 0 && x + w <= grid.units.w && y + h <= grid.units.h;
}

function overlap(ax, ay, aSize, bx, by, bSize) {
    const a = sizeUnits(aSize);
    const b = sizeUnits(bSize);
    return ax < bx + b.w && bx < ax + a.w && ay < by + b.h && by < ay + a.h;
}

/** Does the item at (x, y) overlap any item of the list other than `self` (an id)? */
export function collides(x, y, size, items, self = null) {
    return items.some(o => o.id !== self && overlap(x, y, size, o.x, o.y, o.size));
}

/**
 * The grid position nearest to a pixel position (the item's top-left), clamped into the grid.
 * Loose snapping uses every unit; the normal one uses whole cells.
 */
export function snap(px, py, size, grid, { loose = false } = {}) {
    const step = loose ? 1 : UNITS_PER_CELL;
    const { w, h } = sizeUnits(size);
    const maxX = Math.max(0, grid.units.w - w);
    const maxY = Math.max(0, grid.units.h - h);
    const x = Math.round((px - grid.x) / grid.unit / step) * step;
    const y = Math.round((py - grid.y) / grid.unit / step) * step;
    return { x: clamp(x, 0, maxX - (maxX % step)), y: clamp(y, 0, maxY - (maxY % step)) };
}

/**
 * The free position nearest to (x, y) for an item (by distance in units), or null when the
 * grid has no room. `self` is the id of an item that is being moved and does not block itself.
 */
export function nearestFree(x, y, size, items, grid, { loose = false, self = null } = {}) {
    const step = loose ? 1 : UNITS_PER_CELL;
    const { w, h } = sizeUnits(size);
    let best = null;
    let bestDist = Infinity;
    for (let cy = 0; cy + h <= grid.units.h; cy += step) {
        for (let cx = 0; cx + w <= grid.units.w; cx += step) {
            const d = (cx - x) ** 2 + (cy - y) ** 2;
            if (d < bestDist && !collides(cx, cy, size, items, self)) {
                best = { x: cx, y: cy };
                bestDist = d;
            }
        }
    }
    return best;
}

/**
 * Where a new widget goes: the first free cell reading from the top-right, down the column,
 * then leftwards (Sonoma fills from the right edge). Null when nothing fits.
 */
export function findSlot(size, items, grid) {
    const { w, h } = sizeUnits(size);
    const lastX = grid.units.w - w;
    for (let cx = lastX - (lastX % UNITS_PER_CELL); cx >= 0; cx -= UNITS_PER_CELL) {
        for (let cy = 0; cy + h <= grid.units.h; cy += UNITS_PER_CELL) {
            if (!collides(cx, cy, size, items))
                return { x: cx, y: cy };
        }
    }
    return null;
}

// ---- layout operations (all return new arrays; items are plain objects) ------------------

/**
 * {id, kind, size, config, monitor, x, y}: `monitor` is the key of the monitor the widget was
 * placed on (see monitorKey), `config` is the widget's own options (a plain object).
 */
export function makeItem({ id, kind, size, config = {}, monitor }, pos) {
    return { id, kind, size, config, monitor, x: pos.x, y: pos.y };
}

let counter = 0;
/** A fresh id that no item of the list uses. */
export function newId(items, kind) {
    const used = new Set(items.map(i => i.id));
    let id;
    do
        id = `${kind}-${(++counter).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    while (used.has(id));
    return id;
}

/**
 * Add a widget in the first free slot of one monitor's grid.
 *
 * @returns {{items: object[], item: ?object}} item is null when the monitor is full
 */
export function addItem(items, spec, grid) {
    const here = items.filter(i => i.monitor === spec.monitor);
    const pos = findSlot(spec.size, here, grid);
    if (!pos)
        return { items, item: null };
    const item = makeItem({ ...spec, id: spec.id ?? newId(items, spec.kind) }, pos);
    return { items: [...items, item], item };
}

export function removeItem(items, id) {
    return items.filter(i => i.id !== id);
}

/** Move a widget to the free position nearest to a pixel position. Null if nothing is free. */
export function moveItem(items, id, px, py, grid, opts = {}) {
    const item = items.find(i => i.id === id);
    if (!item)
        return null;
    const here = items.filter(i => i.monitor === item.monitor);
    const want = snap(px, py, item.size, grid, opts);
    const pos = nearestFree(want.x, want.y, item.size, here, grid, { ...opts, self: id });
    if (!pos)
        return null;
    return items.map(i => (i.id === id ? { ...i, x: pos.x, y: pos.y } : i));
}

/**
 * Change a widget's size. The top-left corner stays when the new size fits there; otherwise
 * the nearest free place is used. Null when the size is not allowed or nothing is free.
 */
export function resizeItem(items, id, size, grid, allowed = SIZE_ORDER) {
    const item = items.find(i => i.id === id);
    if (!item || !isSize(size) || !allowed.includes(size))
        return null;
    const here = items.filter(i => i.monitor === item.monitor);
    const pos = nearestFree(item.x, item.y, size, here, grid, { self: id });
    if (!pos)
        return null;
    return items.map(i => (i.id === id ? { ...i, size, x: pos.x, y: pos.y } : i));
}

export function setConfig(items, id, config) {
    return items.map(i => (i.id === id ? { ...i, config: { ...i.config, ...config } } : i));
}

/**
 * Make a monitor's items fit its grid after a resolution change, without moving what already
 * fits: a widget outside or on top of another one goes to the nearest free place; one that
 * finds no room is left out of the result (it stays in `items` of the caller's store).
 *
 * @returns {object[]} the items of this monitor, in the same order, that fit
 */
export function fitItems(monitorItems, grid) {
    const placed = [];
    const pending = [];
    for (const item of monitorItems) {
        if (fits(item.x, item.y, item.size, grid) && !collides(item.x, item.y, item.size, placed))
            placed.push(item);
        else
            pending.push(item);
    }
    for (const item of pending) {
        const pos = nearestFree(item.x, item.y, item.size, placed, grid);
        if (pos)
            placed.push({ ...item, ...pos });
    }
    return monitorItems.map(i => placed.find(p => p.id === i.id)).filter(Boolean);
}

// ---- persistence -------------------------------------------------------------------------

/**
 * Read the stored layout. Anything malformed is dropped, never thrown on: an unknown kind or
 * size, a duplicate id, a bad position. `knownKinds` is a predicate (the registry's has()).
 *
 * @param {string} text the JSON string in the settings ('' is an empty layout)
 * @param {(kind: string) => boolean} knownKinds
 * @returns {object[]} items
 */
export function parseLayout(text, knownKinds = () => true) {
    if (!text)
        return [];
    let data;
    try {
        data = JSON.parse(text);
    } catch (_e) {
        return [];
    }
    if (!data || data.version !== LAYOUT_VERSION || !Array.isArray(data.items))
        return [];
    const seen = new Set();
    const out = [];
    for (const raw of data.items) {
        if (!raw || typeof raw !== 'object')
            continue;
        const { id, kind, size, config, monitor, x, y } = raw;
        if (typeof id !== 'string' || !id || seen.has(id))
            continue;
        if (typeof kind !== 'string' || !knownKinds(kind) || !isSize(size))
            continue;
        if (typeof monitor !== 'string' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0)
            continue;
        seen.add(id);
        out.push({
            id, kind, size,
            config: config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {},
            monitor, x, y,
        });
    }
    return out;
}

export function serializeLayout(items) {
    if (!items.length)
        return '';
    return JSON.stringify({
        version: LAYOUT_VERSION,
        items: items.map(({ id, kind, size, config, monitor, x, y }) => ({ id, kind, size, config, monitor, x, y })),
    });
}

/**
 * A stable key for a monitor: its connector with vendor, product and serial, so a layout
 * comes back when the same screen is plugged into the same port again.
 */
export function monitorKey({ connector, vendor, product, serial }) {
    return [connector, vendor, product, serial].map(p => (p ? String(p) : '-')).join('|');
}

/** The pieces of a layout that belong to monitors the session has, for the layer. */
export function itemsFor(items, key) {
    return items.filter(i => i.monitor === key);
}

// ---- providers ----------------------------------------------------------------------------

/** Change notifications for a provider. */
export class Emitter {
    constructor() {
        this._fns = new Set();
    }

    /** @returns {() => void} unsubscribe */
    connect(fn) {
        this._fns.add(fn);
        return () => this._fns.delete(fn);
    }

    emit(...args) {
        for (const fn of [...this._fns]) {
            try {
                fn(...args);
            } catch (e) {
                console.error('[Guava] widget listener failed:', e);
            }
        }
    }

    get size() {
        return this._fns.size;
    }
}

/**
 * Data providers are shared and lazy. The first acquire of an id builds it and calls start();
 * the last release calls stop() and drops it, so a provider costs nothing while no widget
 * that needs it is visible.
 *
 * A provider is {start(), stop(), snapshot(), onChange(fn) -> off}; the factory builds one.
 */
export class ProviderPool {
    /** @param {Record<string, () => object>} factories id -> builder */
    constructor(factories) {
        this._factories = factories;
        this._live = new Map(); // id -> {provider, refs}
    }

    has(id) {
        return Object.prototype.hasOwnProperty.call(this._factories, id);
    }

    /** @returns {{provider: object, release: () => void}} release is idempotent */
    acquire(id) {
        if (!this.has(id))
            throw new Error(`ProviderPool: unknown provider '${id}'`);
        let rec = this._live.get(id);
        if (!rec) {
            const provider = this._factories[id]();
            rec = { provider, refs: 0 };
            this._live.set(id, rec);
            try {
                provider.start();
            } catch (e) {
                this._live.delete(id);
                throw e;
            }
        }
        rec.refs++;
        let done = false;
        return {
            provider: rec.provider,
            release: () => {
                if (done)
                    return;
                done = true;
                if (--rec.refs > 0 || this._live.get(id) !== rec)
                    return;
                this._live.delete(id);
                try {
                    rec.provider.stop();
                } catch (e) {
                    console.error(`[Guava] widget provider '${id}' failed to stop:`, e);
                }
            },
        };
    }

    /** Ids that are running. */
    active() {
        return [...this._live.keys()];
    }

    /** Stop everything (extension disable); handles still held become harmless. */
    stopAll() {
        for (const [id, rec] of [...this._live]) {
            this._live.delete(id);
            try {
                rec.provider.stop();
            } catch (e) {
                console.error(`[Guava] widget provider '${id}' failed to stop:`, e);
            }
        }
    }
}

// ---- the registry -------------------------------------------------------------------------

/**
 * Widget kinds: {id, title, category, sizes, defaultSize, providers, create}. The registry
 * only holds and answers questions about them; the Shell side builds the views.
 */
export class WidgetRegistry {
    constructor() {
        this._kinds = new Map();
    }

    register(def) {
        if (this._kinds.has(def.id))
            throw new Error(`WidgetRegistry: '${def.id}' is already registered`);
        for (const s of def.sizes) {
            if (!isSize(s))
                throw new Error(`WidgetRegistry: '${def.id}' has an unknown size '${s}'`);
        }
        if (!def.sizes.includes(def.defaultSize))
            throw new Error(`WidgetRegistry: '${def.id}' default size is not one of its sizes`);
        this._kinds.set(def.id, def);
        return def;
    }

    has(id) {
        return this._kinds.has(id);
    }

    get(id) {
        return this._kinds.get(id) ?? null;
    }

    /** All kinds in registration order. */
    kinds() {
        return [...this._kinds.values()];
    }

    /**
     * The kinds whose title or category contain the query, for one surface.
     *
     * @param {{query?: string, category?: string, translate?: (s: string) => string}} [filter]
     *   translate: gettext, so the query matches what the user reads
     */
    find({ query = '', category = null, translate = s => s } = {}) {
        const q = query.trim().toLowerCase();
        return this.kinds().filter(k =>
            (!category || k.category === category) &&
            (!q || translate(k.title).toLowerCase().includes(q) || translate(k.category).toLowerCase().includes(q)));
    }

    categories() {
        return [...new Set(this.kinds().map(k => k.category))];
    }

    /** The sizes a surface may use: Notification Center and the notch have no extra-large. */
    sizesFor(id, surface = 'desktop') {
        const def = this.get(id);
        if (!def)
            return [];
        return surface === 'desktop' ? [...def.sizes] : def.sizes.filter(s => s !== 'extraLarge');
    }
}

// ---- starter set --------------------------------------------------------------------------

/** What "Add default widgets" places, in order. */
export const DEFAULT_WIDGETS = Object.freeze([
    { kind: 'clock', size: 'small' },
    { kind: 'calendar', size: 'small' },
    { kind: 'weather', size: 'small' },
    { kind: 'now-playing', size: 'medium' },
]);
