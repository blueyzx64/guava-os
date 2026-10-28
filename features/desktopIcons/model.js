// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop icons, the pure half (tests/desktopIconsModel.test.js). No gi:// imports.
//
// The desktop is a grid of CELLS counted from the TOP-RIGHT corner, as Finder's desktop is:
// cell {col: 0, row: 0} is the top-right one, `col` grows to the left and `row` downwards.
// New icons flow down the right-most column, then continue in the next column to the left.
//
//   entry   {key, name, kind: 'folder'|'file'|'drive', contentType, kindLabel, mtime, ctime, size}
//           `key` identifies the icon in the saved arrangement (the file name; 'drive:<name>').
//   stored  Map key -> {col, row, user}   user: the user put it there (a drag), else it is a
//           remembered automatic place that may move to make room for a widget.
//   cells   Map key -> {col, row}

export const SORTS = Object.freeze(['none', 'name', 'kind', 'date-modified', 'date-created', 'size']);
export const LAYOUT_VERSION = 1;

/** Margin between the icon grid and the usable area, in design px. */
export const MARGIN = 12;
/** Pixels the pointer must travel before a press on an icon, or on the wallpaper, drags. */
export const DRAG_THRESHOLD = 6;
/** The label shows at most this many lines. */
export const LABEL_LINES = 2;
/** The folder changed: wait this long for more changes before reading it again (ms). */
export const RELOAD_DEBOUNCE_MS = 150;
/** Typing to select forgets what was typed after this pause (ms). */
export const TYPE_AHEAD_MS = 1000;

const MAX_STORED = 2000;
const cellKey = (col, row) => `${col},${row}`;

// ---- metrics and grid ----------------------------------------------------------------------

/**
 * Sizes of one icon cell at a UI scale. The cell is the icon, a gap, and the label's two lines.
 *
 * @param {number} iconSize icon edge in design px (32..128)
 * @param {number} [scale] UI scale factor
 */
export function metricsFor(iconSize, scale = 1) {
    const icon = Math.round(iconSize * scale);
    const lineHeight = Math.round(15 * scale);
    const gap = Math.round(6 * scale);
    const labelHeight = LABEL_LINES * lineHeight + Math.round(4 * scale);
    const cellW = Math.round(Math.max(80, Math.round(iconSize * 1.5) + 4) * scale);
    return {
        icon, gap, lineHeight, labelHeight, cellW,
        labelWidth: cellW - Math.round(8 * scale),
        cellH: icon + gap + labelHeight + Math.round(10 * scale),
        margin: Math.round(MARGIN * scale),
    };
}

/**
 * The cell grid on a usable area, hanging from its top-right corner.
 *
 * @param {{x: number, y: number, width: number, height: number}} area
 * @param {ReturnType<typeof metricsFor>} m
 */
export function gridFor(area, m) {
    return {
        right: area.x + area.width - m.margin,
        top: area.y + m.margin,
        cellW: m.cellW,
        cellH: m.cellH,
        cols: Math.max(1, Math.floor((area.width - 2 * m.margin) / m.cellW)),
        rows: Math.max(1, Math.floor((area.height - 2 * m.margin) / m.cellH)),
    };
}

/** The pixel rectangle of a cell. */
export function cellRect(cell, grid) {
    return {
        x: grid.right - (cell.col + 1) * grid.cellW,
        y: grid.top + cell.row * grid.cellH,
        width: grid.cellW,
        height: grid.cellH,
    };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** The cell under a pixel position, clamped into the grid. */
export function cellAt(px, py, grid) {
    return {
        col: clamp(Math.floor((grid.right - px) / grid.cellW), 0, grid.cols - 1),
        row: clamp(Math.floor((py - grid.top) / grid.cellH), 0, grid.rows - 1),
    };
}

/** Is the cell inside the grid? */
export const inGrid = (cell, grid) =>
    Number.isInteger(cell.col) && Number.isInteger(cell.row) &&
    cell.col >= 0 && cell.row >= 0 && cell.col < grid.cols && cell.row < grid.rows;

/** The n-th cell of the flow: down the right-most column, then the next one to the left. */
export const flowCell = (index, grid) => ({ col: Math.floor(index / grid.rows), row: index % grid.rows });

/**
 * The cells that overlap any of the rectangles (the widgets), as a Set of "col,row" keys.
 *
 * @param {Array<{x: number, y: number, width: number, height: number}>} rects
 */
export function blockedCells(rects, grid) {
    const blocked = new Set();
    for (const r of rects) {
        const c0 = clamp(Math.floor((grid.right - (r.x + r.width)) / grid.cellW), 0, grid.cols);
        const c1 = clamp(Math.floor((grid.right - r.x - 1) / grid.cellW), -1, grid.cols - 1);
        const r0 = clamp(Math.floor((r.y - grid.top) / grid.cellH), 0, grid.rows);
        const r1 = clamp(Math.floor((r.y + r.height - 1 - grid.top) / grid.cellH), -1, grid.rows - 1);
        for (let col = c0; col <= c1; col++) {
            for (let row = r0; row <= r1; row++)
                blocked.add(cellKey(col, row));
        }
    }
    return blocked;
}

// ---- sorting ---------------------------------------------------------------------------------

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const COMPARE = {
    'none': byName,
    'name': byName,
    'kind': (a, b) => (a.kindLabel ?? '').localeCompare(b.kindLabel ?? '') || byName(a, b),
    'date-modified': (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b),
    'date-created': (a, b) => (b.ctime ?? 0) - (a.ctime ?? 0) || byName(a, b),
    'size': (a, b) => (b.size ?? 0) - (a.size ?? 0) || byName(a, b),
};

/**
 * The entries in the order of a sort (newest, largest first), as a new array. Drives come
 * first in every order, as the disks do on the Finder desktop.
 */
export function sortEntries(entries, mode) {
    const sorted = [...entries].sort(COMPARE[mode] ?? byName);
    return [...sorted.filter(e => e.kind === 'drive'), ...sorted.filter(e => e.kind !== 'drive')];
}

export const isSort = mode => SORTS.includes(mode);

// ---- the arrangement ---------------------------------------------------------------------------

/**
 * Where every icon goes.
 *
 * With a sort the whole desktop is laid out in that order and nothing is remembered. With
 * 'none' an icon keeps its remembered cell; the rest (new files, icons whose cell is gone or
 * under a widget) take the first free cell of the flow, in name order.
 *
 * @param {{entries: object[], stored: Map<string, {col: number, row: number, user: boolean}>,
 *   grid: object, sort: string, blocked?: Set<string>}} s
 * @returns {{cells: Map<string, {col: number, row: number}>, assigned: Map<string, {col: number, row: number}>}}
 *   assigned: the icons that got an automatic cell now (the caller remembers them)
 */
export function layoutCells({ entries, stored, grid, sort, blocked = new Set() }) {
    const cells = new Map();
    const assigned = new Map();
    const taken = new Set();
    let next = 0;
    const nextFree = () => {
        for (;;) {
            const c = flowCell(next++, grid);
            const k = cellKey(c.col, c.row);
            if (!taken.has(k) && !blocked.has(k)) {
                taken.add(k);
                return c;
            }
        }
    };
    if (sort !== 'none') {
        for (const e of sortEntries(entries, sort))
            cells.set(e.key, nextFree());
        return { cells, assigned };
    }
    const pending = [];
    for (const e of sortEntries(entries, 'name')) {
        const rec = stored.get(e.key);
        const k = rec ? cellKey(rec.col, rec.row) : '';
        if (rec && inGrid(rec, grid) && !taken.has(k) && (rec.user || !blocked.has(k))) {
            taken.add(k);
            cells.set(e.key, { col: rec.col, row: rec.row });
        } else {
            pending.push(e);
        }
    }
    for (const e of pending) {
        const c = nextFree();
        cells.set(e.key, c);
        assigned.set(e.key, c);
    }
    return { cells, assigned };
}

/**
 * Drop the selected icons `delta` cells away. An icon whose target is taken by an icon that
 * stays, or by another dropped icon, takes the nearest free cell instead; nothing leaves the grid.
 *
 * @param {Map<string, {col: number, row: number}>} cells
 * @param {Iterable<string>} moving keys of the dragged icons
 * @returns {Map<string, {col: number, row: number}>} the new cell of each dragged icon
 */
export function moveCells(cells, moving, delta, grid) {
    const keys = [...moving].filter(k => cells.has(k));
    const set = new Set(keys);
    const taken = new Set();
    for (const [k, c] of cells) {
        if (!set.has(k))
            taken.add(cellKey(c.col, c.row));
    }
    const out = new Map();
    // Flow order: the icon nearest the corner picks first, so a group keeps its shape
    keys.sort((a, b) => flowIndex(cells.get(a), grid) - flowIndex(cells.get(b), grid));
    for (const k of keys) {
        const from = cells.get(k);
        const want = {
            col: clamp(from.col + delta.col, 0, grid.cols - 1),
            row: clamp(from.row + delta.row, 0, grid.rows - 1),
        };
        const target = taken.has(cellKey(want.col, want.row)) ? nearestFreeCell(want, taken, grid) : want;
        const cell = target ?? from;
        taken.add(cellKey(cell.col, cell.row));
        out.set(k, cell);
    }
    return out;
}

const flowIndex = (cell, grid) => cell.col * grid.rows + cell.row;

/** The free cell nearest to `want` (straight-line distance, then flow order), or null. */
export function nearestFreeCell(want, taken, grid) {
    let best = null;
    let bestDist = Infinity;
    for (let col = 0; col < grid.cols; col++) {
        for (let row = 0; row < grid.rows; row++) {
            if (taken.has(cellKey(col, row)))
                continue;
            const d = (col - want.col) ** 2 + (row - want.row) ** 2;
            if (d < bestDist) {
                best = { col, row };
                bestDist = d;
            }
        }
    }
    return best;
}

// ---- persistence ------------------------------------------------------------------------------

/**
 * Read the saved arrangement; anything malformed is dropped, never thrown on.
 *
 * @param {string} text the JSON in the settings ('' is empty)
 * @returns {Map<string, {col: number, row: number, user: boolean}>}
 */
export function parseArrangement(text) {
    const out = new Map();
    if (!text)
        return out;
    let data;
    try {
        data = JSON.parse(text);
    } catch (_e) {
        return out;
    }
    if (!data || data.version !== LAYOUT_VERSION || !data.cells || typeof data.cells !== 'object')
        return out;
    for (const [key, v] of Object.entries(data.cells)) {
        if (out.size >= MAX_STORED)
            break;
        if (!key || !Array.isArray(v) || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || v[0] < 0 || v[1] < 0)
            continue;
        out.set(key, { col: v[0], row: v[1], user: v[2] === 1 });
    }
    return out;
}

export function serializeArrangement(stored) {
    if (!stored.size)
        return '';
    const cells = {};
    for (const [key, c] of stored)
        cells[key] = c.user ? [c.col, c.row, 1] : [c.col, c.row];
    return JSON.stringify({ version: LAYOUT_VERSION, cells });
}

/**
 * Keep what the desktop still has. A drive that is not mounted right now keeps its place, so
 * it comes back where it was; a file that is gone is forgotten.
 */
export function pruneArrangement(stored, entries) {
    const live = new Set(entries.map(e => e.key));
    const out = new Map();
    for (const [k, c] of stored) {
        if (live.has(k) || k.startsWith(DRIVE_PREFIX))
            out.set(k, c);
    }
    return out;
}

export const DRIVE_PREFIX = 'drive:';

// ---- selection ---------------------------------------------------------------------------------

/**
 * The selected icons. `anchor` is where a Shift range starts, `focus` the icon the keyboard
 * moves from (the last one clicked or reached).
 */
export class Selection {
    constructor() {
        this._keys = new Set();
        this.anchor = null;
        this.focus = null;
    }

    get keys() {
        return this._keys;
    }

    get size() {
        return this._keys.size;
    }

    has(key) {
        return this._keys.has(key);
    }

    clear() {
        this._keys.clear();
        this.anchor = this.focus = null;
    }

    /** Select exactly these (rubber band, select all). */
    set(keys) {
        this._keys = new Set(keys);
        this.focus = [...this._keys].pop() ?? null;
        this.anchor = this.focus;
    }

    /** Keep only what still exists. */
    retain(keys) {
        const live = new Set(keys);
        for (const k of [...this._keys]) {
            if (!live.has(k))
                this._keys.delete(k);
        }
        if (this.anchor && !live.has(this.anchor))
            this.anchor = null;
        if (this.focus && !live.has(this.focus))
            this.focus = null;
    }

    /**
     * A click: plain replaces the selection; Ctrl toggles one icon; Shift selects the range
     * from the anchor in flow order (with Ctrl it adds the range).
     *
     * @param {string} key
     * @param {{ctrl?: boolean, shift?: boolean}} mods
     * @param {string[]} order every icon in flow order
     */
    click(key, { ctrl = false, shift = false } = {}, order = []) {
        if (shift && this.anchor && order.includes(this.anchor)) {
            const a = order.indexOf(this.anchor);
            const b = order.indexOf(key);
            const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
            if (!ctrl)
                this._keys.clear();
            range.forEach(k => this._keys.add(k));
            this.focus = key;
            return;
        }
        if (ctrl) {
            if (!this._keys.delete(key))
                this._keys.add(key);
        } else {
            this._keys = new Set([key]);
        }
        this.anchor = this.focus = key;
    }

    /** Press on an icon that starts a drag: it joins the selection unless it is part of it. */
    press(key, { ctrl = false, shift = false } = {}, order = []) {
        if (this._keys.has(key) && !ctrl && !shift) {
            this.focus = key;
            return false;
        }
        this.click(key, { ctrl, shift }, order);
        return true;
    }

    /** A click without a drag on an icon of a group: it alone stays selected. */
    collapseTo(key) {
        this._keys = new Set([key]);
        this.anchor = this.focus = key;
    }
}

/** Keys of the icons whose rectangle meets the rubber band. */
export function rubberBandHits(band, rects) {
    const hits = [];
    for (const [key, r] of rects) {
        if (r.x < band.x + band.width && band.x < r.x + r.width && r.y < band.y + band.height && band.y < r.y + r.height)
            hits.push(key);
    }
    return hits;
}

/** The rectangle between the press point and the pointer. */
export function bandRect(x0, y0, x1, y1) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/**
 * Is this press the second of a double click? Same icon, within the system's double-click time
 * and distance of the previous press (the Shell gives no click count).
 *
 * @param {?{key: string, time: number, x: number, y: number}} prev the previous press
 * @param {{key: string, time: number, x: number, y: number}} now
 * @param {{time: number, distance: number}} limits Clutter.Settings double-click-time / -distance
 */
export function isDoubleClick(prev, now, { time, distance }) {
    return !!prev && prev.key === now.key && now.time - prev.time <= time &&
        Math.abs(now.x - prev.x) <= distance && Math.abs(now.y - prev.y) <= distance;
}

/** Has the pointer moved far enough from the press to start a drag? */
export const isDrag = (dx, dy, threshold = DRAG_THRESHOLD) => dx * dx + dy * dy >= threshold * threshold;

// ---- keyboard -------------------------------------------------------------------------------------

/**
 * The icon an arrow key moves to: the nearest one in that direction, preferring the one in the
 * same row or column. Null when nothing lies that way. With no `from`, the first icon of the flow.
 *
 * @param {string|null} from
 * @param {'left'|'right'|'up'|'down'} direction on screen
 * @param {Map<string, {col: number, row: number}>} cells
 */
export function neighbour(from, direction, cells) {
    const start = from && cells.has(from) ? cells.get(from) : null;
    if (!start) {
        let first = null;
        for (const [k, c] of cells) {
            if (!first || c.col < cells.get(first).col || (c.col === cells.get(first).col && c.row < cells.get(first).row))
                first = k;
        }
        return first;
    }
    // Screen axes: x grows to the right (so against col), y grows downwards
    const sx = c => -c.col;
    const sy = c => c.row;
    const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[direction];
    let best = null;
    let bestScore = Infinity;
    for (const [k, c] of cells) {
        const along = dir[0] ? (sx(c) - sx(start)) * dir[0] : (sy(c) - sy(start)) * dir[1];
        const across = Math.abs(dir[0] ? sy(c) - sy(start) : sx(c) - sx(start));
        if (along <= 0)
            continue;
        const score = along + across * 2.5;
        if (score < bestScore) {
            best = k;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Type-to-select: the next icon (after `from`, wrapping) whose name starts with the typed text.
 *
 * @param {string} typed
 * @param {Array<{key: string, name: string}>} ordered entries in flow order
 */
export function typeAhead(typed, ordered, from = null) {
    const prefix = typed.toLowerCase();
    if (!prefix || !ordered.length)
        return null;
    const start = Math.max(0, ordered.findIndex(e => e.key === from));
    for (let i = 1; i <= ordered.length; i++) {
        const e = ordered[(start + i) % ordered.length];
        if (e.name.toLowerCase().startsWith(prefix))
            return e.key;
    }
    return null;
}

/** Keys in flow order. */
export function flowOrder(cells, grid) {
    return [...cells].sort((a, b) => flowIndex(a[1], grid) - flowIndex(b[1], grid)).map(([k]) => k);
}

// ---- names ------------------------------------------------------------------------------------------

/**
 * Check a new name typed for an icon.
 *
 * @param {string} raw
 * @param {string} current the icon's name now
 * @param {Iterable<string>} siblings names in the same folder
 * @returns {{ok: true, name: string, changed: boolean}|{ok: false, error: 'empty'|'slash'|'dots'|'long'|'exists'}}
 */
export function validateName(raw, current, siblings) {
    const name = raw.trim();
    if (!name)
        return { ok: false, error: 'empty' };
    if (name === '.' || name === '..')
        return { ok: false, error: 'dots' };
    if (name.includes('/') || name.includes('\0'))
        return { ok: false, error: 'slash' };
    if (new TextEncoder().encode(name).length > 255)
        return { ok: false, error: 'long' };
    if (name === current)
        return { ok: true, name, changed: false };
    for (const s of siblings) {
        if (s === name)
            return { ok: false, error: 'exists' };
    }
    return { ok: true, name, changed: true };
}

/** "untitled folder", then "untitled folder 2", ... that no sibling uses. */
export function uniqueName(base, siblings) {
    const taken = new Set(siblings);
    if (!taken.has(base))
        return base;
    for (let n = 2; ; n++) {
        const name = `${base} ${n}`;
        if (!taken.has(name))
            return name;
    }
}

/** How many characters of a file name Rename selects first: the name without its extension. */
export function stemLength(name, isFolder) {
    if (isFolder)
        return name.length;
    const m = /^(.+?)(\.tar)?\.[^./\s]{1,8}$/.exec(name);
    return m ? m[1].length : name.length;
}

// ---- menus ------------------------------------------------------------------------------------------

/**
 * The actions of the context menu for the selected icons, in order ('-' is a separator).
 * Drives offer Eject, never Rename or Move to Trash.
 *
 * @param {Array<{kind: string}>} selected the entries under the menu (empty: the wallpaper)
 * @returns {string[]}
 */
export function menuActions(selected) {
    if (!selected.length)
        return ['new-folder', 'sort'];
    const drives = selected.every(e => e.kind === 'drive');
    const files = selected.every(e => e.kind !== 'drive');
    const out = ['open', 'show-in-files'];
    if (selected.length === 1 && files)
        out.push('rename');
    out.push('-');
    if (files)
        out.push('trash');
    if (drives)
        out.push('eject');
    out.push('-', 'new-folder');
    return out;
}

// ---- drives ----------------------------------------------------------------------------------------

/**
 * Should a mount show on the desktop? A removable or user-mounted disk, not the system's own
 * mounts and not a mount another mount hides.
 *
 * @param {{rootPath: ?string, isShadowed: boolean}} mount
 */
export function showsAsDrive({ rootPath, isShadowed }) {
    if (isShadowed || !rootPath || rootPath === '/')
        return false;
    return !/^\/(boot|sys|proc|dev|run\/host|var\/lib\/flatpak)(\/|$)/.test(rootPath);
}

// ---- who has the focus ----------------------------------------------------------------------------

/**
 * Is the desktop in front, so its selection shows in the accent colour? Yes while no normal or
 * dialog window that is not minimized has the focus.
 *
 * @param {?{type: string, minimized: boolean}} focused WindowInfo (core/desktopModel.js)
 */
export function desktopInFront(focused) {
    return !focused || focused.minimized || (focused.type !== 'normal' && focused.type !== 'dialog');
}

// ---- DING ------------------------------------------------------------------------------------------

/** Extensions that draw desktop icons themselves (Desktop Icons NG and its forks). */
export const DING_UUIDS = Object.freeze([
    'ding@rastersoft.com',
    'gtk4-ding@smedius.gitlab.com',
    'desktopicons-neo@darkdemon',
    'desktop-icons@csoriano',
]);

/**
 * Is another extension drawing the desktop icons? `enabled` is the list of enabled extension
 * uuids (org.gnome.shell enabled-extensions); a listed extension counts only when extensions
 * are not all switched off.
 */
export function dingEnabled(enabled, userExtensionsDisabled = false) {
    return !userExtensionsDisabled && enabled.some(u => DING_UUIDS.includes(u));
}
