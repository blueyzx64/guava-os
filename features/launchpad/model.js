// SPDX-License-Identifier: GPL-3.0-or-later
// Launchpad: the pure decisions (no gi imports). index.js and view.js feed it plain values.
//
//   gridMetrics(monitor)              columns, rows, cell and icon sizes for one monitor
//   buildItems(apps, folders, layout) the top-level grid (folders + loose apps), in GNOME's order
//   folderMembers(folder, apps)       what a folder holds (its apps + its categories - excluded)
//   paginate / pageOf / pageCount     pages of a flat list
//   moveId / createFolder / addToFolder / removeFromFolder   drag edits (new values, no mutation)
//   serializeLayout(order, perPage)   app-picker-layout pages ({id: {position}})
//   navigate(index, key, grid)        arrow-key focus moves, across pages
//   searchApps(query, apps)           ranked app ids
//   dropAction(...)                   what releasing a drag over the grid does
//   flatpakAppId / uninstallRule      which apps get an ⓧ, and who removes them
//   jiggleParams(index)               per-icon wobble so icons do not move in lockstep
//
// The data is GNOME's own: the folders are org.gnome.desktop.app-folders
// and the order is org.gnome.shell app-picker-layout, so the Activities app grid and Launchpad
// always agree. Rules for ⓧ: uninstallRule() below.

/** macOS Launchpad (Big Sur to Sequoia): 7 columns by 5 rows on a usual display. */
export const COLUMNS = 7;
export const ROWS = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Grid geometry for a monitor. The search field sits at the top, the page dots at the bottom,
 * and the grid fills what is left with generous side margins (macOS leaves about a tenth).
 *
 * @param {{width: number, height: number}} monitor logical px
 * @returns {{columns, rows, perPage, cellWidth, cellHeight, icon, gridWidth, gridHeight, left, top,
 *            searchTop, dotsTop}}
 */
export function gridMetrics({ width, height }) {
    const searchTop = Math.round(clamp(height * 0.045, 24, 56));
    const searchHeight = 36;
    const dotsHeight = 44;
    const top = searchTop + searchHeight + Math.round(clamp(height * 0.05, 16, 64));
    const bottomMargin = dotsHeight + Math.round(clamp(height * 0.03, 12, 40));
    const sideMargin = Math.round(clamp(width * 0.1, 24, 260));
    const gridWidth = Math.max(1, width - 2 * sideMargin);
    const gridHeight = Math.max(1, height - top - bottomMargin);
    // Fewer columns and rows on small screens, so icons keep a readable size
    const columns = clamp(Math.floor(gridWidth / 112), 3, COLUMNS);
    const rows = clamp(Math.floor(gridHeight / 118), 2, ROWS);
    const cellWidth = Math.floor(gridWidth / columns);
    const cellHeight = Math.floor(gridHeight / rows);
    // The label takes two lines of ~15 px under the icon
    const icon = Math.round(clamp(Math.min(cellWidth * 0.62, cellHeight - 44), 40, 128));
    return {
        columns, rows, perPage: columns * rows,
        cellWidth, cellHeight, icon,
        gridWidth: cellWidth * columns, gridHeight: cellHeight * rows,
        left: Math.round((width - cellWidth * columns) / 2), top,
        searchTop, dotsTop: height - dotsHeight - Math.round(bottomMargin - dotsHeight) / 2,
    };
}

/**
 * The apps a folder shows, as GNOME's FolderView computes them (js/ui/appDisplay.js
 * FolderView._loadApps): its `apps` first, then every app whose categories meet the folder's,
 * minus `excluded`; only installed apps, no duplicates.
 *
 * @param {{apps: string[], categories: string[], excluded: string[]}} folder
 * @param {{id: string, categories: string[]}[]} apps installed apps, in system order
 * @returns {string[]}
 */
export function folderMembers(folder, apps) {
    const installed = new Set(apps.map(a => a.id));
    const excluded = new Set(folder.excluded ?? []);
    const out = [];
    const seen = new Set();
    const add = id => {
        if (!installed.has(id) || excluded.has(id) || seen.has(id))
            return;
        seen.add(id);
        out.push(id);
    };
    for (const id of folder.apps ?? [])
        add(id);
    const cats = folder.categories ?? [];
    if (cats.length) {
        for (const app of apps) {
            if ((app.categories ?? []).some(c => cats.includes(c)))
                add(app.id);
        }
    }
    return out;
}

/** {id: [page, position]} from app-picker-layout pages ([{id: {position}}]). */
export function layoutIndex(layout) {
    const index = new Map();
    (layout ?? []).forEach((page, p) => {
        for (const [id, props] of Object.entries(page ?? {})) {
            if (!index.has(id))
                index.set(id, [p, Number(props?.position ?? 0)]);
        }
    });
    return index;
}

/**
 * The top level of the grid: non-empty folders and the apps that are in no folder, ordered by
 * GNOME's layout (page, then position); items it does not know follow, by name.
 *
 * @param {{id: string, name: string, categories?: string[]}[]} apps
 * @param {{id: string, name: string, apps: string[], categories?: string[], excluded?: string[]}[]} folders
 * @param {object[]} layout app-picker-layout pages
 * @returns {{kind: 'app'|'folder', id: string, name: string, apps?: string[]}[]}
 */
export function buildItems(apps, folders, layout) {
    const items = [];
    const inFolder = new Set();
    for (const f of folders) {
        const members = folderMembers(f, apps);
        if (!members.length)
            continue;
        members.forEach(id => inFolder.add(id));
        items.push({ kind: 'folder', id: f.id, name: f.name, apps: members });
    }
    for (const a of apps) {
        if (!inFolder.has(a.id))
            items.push({ kind: 'app', id: a.id, name: a.name });
    }
    const index = layoutIndex(layout);
    const known = items.map((it, i) => ({ it, i, pos: index.get(it.id) }));
    known.sort((a, b) => {
        if (a.pos && b.pos)
            return a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1] || a.i - b.i;
        if (a.pos)
            return -1;
        if (b.pos)
            return 1;
        return a.it.name.localeCompare(b.it.name) || a.i - b.i;
    });
    return known.map(k => k.it);
}

export const pageCount = (count, perPage) => Math.max(1, Math.ceil(count / Math.max(1, perPage)));
export const pageOf = (index, perPage) => Math.floor(Math.max(0, index) / Math.max(1, perPage));

/** Split a list into pages of perPage. Always at least one (maybe empty) page. */
export function paginate(list, perPage) {
    const pages = [];
    for (let i = 0; i < list.length; i += perPage)
        pages.push(list.slice(i, i + perPage));
    return pages.length ? pages : [[]];
}

/** app-picker-layout pages for an ordered id list: [{id: {position}}] with positions per page. */
export function serializeLayout(order, perPage) {
    return paginate(order, perPage).map(page =>
        Object.fromEntries(page.map((id, position) => [id, { position }])));
}

/** `order` with `id` moved to `toIndex` (clamped). Unknown id: a copy of `order`. */
export function moveId(order, id, toIndex) {
    const from = order.indexOf(id);
    if (from < 0)
        return [...order];
    const out = order.filter(x => x !== id);
    out.splice(clamp(toIndex, 0, out.length), 0, id);
    return out;
}

/**
 * Drop one app on another (macOS: hold it there): a new folder takes the target's place and
 * holds both, the target first (GNOME's createFolder does the same).
 *
 * @param {string[]} order top-level ids
 * @param {string} dragId the app being dragged
 * @param {string} targetId the app under it
 * @param {string} folderId the new folder's id
 * @returns {?{order: string[], folder: {id: string, apps: string[]}}} null if not two loose apps
 */
export function createFolder(order, dragId, targetId, folderId) {
    if (dragId === targetId || !order.includes(targetId))
        return null;
    const out = [];
    for (const id of order) {
        if (id === dragId)
            continue;
        out.push(id === targetId ? folderId : id);
    }
    return { order: out, folder: { id: folderId, apps: [targetId, dragId] } };
}

/**
 * Drop an app on a folder: it leaves the top level and joins the folder's own list (and stops
 * being excluded, for a categories folder).
 *
 * @returns {{order: string[], apps: string[], excluded: string[]}}
 */
export function addToFolder(order, folder, appId) {
    return {
        order: order.filter(id => id !== appId),
        apps: (folder.apps ?? []).includes(appId) ? [...folder.apps] : [...(folder.apps ?? []), appId],
        excluded: (folder.excluded ?? []).filter(id => id !== appId),
    };
}

/**
 * Drag an app out of a folder (GNOME's FolderView.removeApp): it leaves the folder's list; a
 * categories folder also excludes it, or the category would bring it back. The folder is gone
 * when nothing is left in it. The app lands right after the folder on the top level (or at
 * `toIndex` when the drop names a place).
 *
 * @param {string[]} order top-level ids
 * @param {{id, apps, categories, excluded}} folder
 * @param {string[]} members what the folder showed before (folderMembers)
 * @param {string} appId
 * @param {?number} [toIndex]
 * @returns {{order: string[], apps: string[], excluded: string[], empty: boolean}}
 */
export function removeFromFolder(order, folder, members, appId, toIndex = null) {
    const apps = (folder.apps ?? []).filter(id => id !== appId);
    const excluded = [...(folder.excluded ?? [])];
    if ((folder.categories ?? []).length && !excluded.includes(appId))
        excluded.push(appId);
    const empty = members.filter(id => id !== appId).length === 0;
    let out = order.filter(id => id !== appId);
    const at = toIndex ?? out.indexOf(folder.id) + 1;
    out.splice(clamp(at, 0, out.length), 0, appId);
    if (empty)
        out = out.filter(id => id !== folder.id);
    return { order: out, apps, excluded, empty };
}

/** A folder name typed by the user: trimmed, single-line, or null to keep the old one. */
export function cleanFolderName(text) {
    const name = String(text ?? '').replace(/\s+/g, ' ').trim();
    return name ? name.slice(0, 64) : null;
}

/**
 * What releasing a drag does, from where it is over the grid.
 * Over the middle of another icon (inner `hold` share of the cell): merge (folder); otherwise
 * a move to the slot under the pointer.
 *
 * @param {{dragKind: 'app'|'folder', targetKind: ?('app'|'folder'), slot: number,
 *          offset: {x: number, y: number}, cell: {width: number, height: number},
 *          count: number}} p offset is the pointer inside the target cell (0..width/height)
 * @returns {{action: 'move', index: number}|{action: 'folder'|'into', index: number}}
 */
export function dropAction({ dragKind, targetKind, slot, offset, cell, count, hold = 0.5 }) {
    const index = clamp(slot, 0, Math.max(0, count - 1));
    if (targetKind && dragKind === 'app') {
        const dx = Math.abs(offset.x - cell.width / 2) / cell.width;
        const dy = Math.abs(offset.y - cell.height / 2) / cell.height;
        if (dx < hold / 2 && dy < hold / 2)
            return { action: targetKind === 'folder' ? 'into' : 'folder', index };
    }
    return { action: 'move', index };
}

/**
 * Keyboard focus moves. Rows and columns are per page; Left/Right run on into the next or
 * previous page (macOS), Up/Down stop at the page edge, Page Up/Down keep the slot.
 *
 * @param {number} index current focus (-1: none)
 * @param {'left'|'right'|'up'|'down'|'pageup'|'pagedown'|'home'|'end'} key
 * @param {{columns: number, perPage: number, count: number}} grid
 * @returns {number} the new index (-1 for an empty grid)
 */
export function navigate(index, key, { columns, perPage, count }) {
    if (count <= 0)
        return -1;
    if (index < 0)
        return 0;
    const last = count - 1;
    const page = pageOf(index, perPage);
    const slot = index - page * perPage;
    const pageEnd = Math.min(last, page * perPage + perPage - 1);
    switch (key) {
    case 'left':
        return Math.max(0, index - 1);
    case 'right':
        return Math.min(last, index + 1);
    case 'up':
        return slot >= columns ? index - columns : index;
    case 'down':
        if (index + columns <= pageEnd)
            return index + columns;
        // The row below is short: go to its last icon, when there is a row below at all
        return Math.floor(slot / columns) < Math.floor((pageEnd - page * perPage) / columns) ? pageEnd : index;
    case 'pageup':
        return page > 0 ? (page - 1) * perPage + slot : index;
    case 'pagedown': {
        const pages = pageCount(count, perPage);
        return page < pages - 1 ? Math.min(last, (page + 1) * perPage + slot) : index;
    }
    case 'home':
        return 0;
    case 'end':
        return last;
    default:
        return index;
    }
}

const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Apps matching a search, best first: name starts with it, a word of the name starts with it,
 * the name contains it, then its generic name or keywords do. Ties keep the name order.
 *
 * @param {string} query
 * @param {{id: string, name: string, generic?: string, keywords?: string[]}[]} apps
 * @returns {string[]} ids
 */
export function searchApps(query, apps) {
    const q = fold(query).trim();
    if (!q)
        return [];
    const scored = [];
    for (const a of apps) {
        const name = fold(a.name);
        let score = -1;
        if (name.startsWith(q))
            score = 0;
        else if (name.split(/[\s\-_.]+/).some(w => w.startsWith(q)))
            score = 1;
        else if (name.includes(q))
            score = 2;
        else if (fold(a.generic).includes(q) || (a.keywords ?? []).some(k => fold(k).startsWith(q)))
            score = 3;
        if (score >= 0)
            scored.push({ id: a.id, name: a.name, score });
    }
    scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return scored.map(s => s.id);
}

// ---- jiggle mode and delete (ⓧ) -------------------------------------------------------------

/** Where Flatpak exports desktop files (system and per-user installations). */
const FLATPAK_EXPORTS = /\/flatpak\/exports\/share\/applications\/[^/]+\.desktop$/;

/**
 * The Flatpak app id of a desktop entry, or null when it is not a Flatpak app. Flatpak writes
 * X-Flatpak=<app id> into every exported entry; the export path is the fallback.
 *
 * @param {{desktopId: string, path: ?string, xFlatpak: ?string}} info
 * @returns {?string}
 */
export function flatpakAppId({ desktopId, path, xFlatpak }) {
    const declared = String(xFlatpak ?? '').trim();
    if (declared)
        return declared;
    if (path && FLATPAK_EXPORTS.test(path))
        return String(desktopId ?? '').replace(/\.desktop$/, '') || null;
    return null;
}

/**
 * Who can remove an app, the Linux version of macOS's "only App Store apps get an ⓧ"
 *:
 *   1. a Flatpak app -> GNOME Software's `uninstall` action, when GNOME Software is activatable;
 *   2. anything else -> no ⓧ (system apps such as Files and Settings stay protected).
 *
 * @param {{desktopId: string, flatpakId: ?string}} app
 * @param {{software: boolean}} caps which back ends are reachable
 * @returns {?{backend: 'flatpak', appId: string}}
 */
export function uninstallRule(app, caps) {
    if (caps.software && app.flatpakId)
        return { backend: 'flatpak', appId: app.flatpakId };
    return null;
}

/**
 * The wobble of one icon in jiggle mode: a small rotation back and forth with a period and
 * phase that differ from its neighbours (deterministic, so a redraw does not reshuffle).
 *
 * @param {number} index position in the grid
 * @returns {{angle: number, periodMs: number, delayMs: number}} angle in degrees (signed)
 */
export function jiggleParams(index) {
    const n = Math.abs(Math.floor(index));
    const sign = n % 2 === 0 ? 1 : -1;
    return {
        angle: sign * (1.6 + (n * 7 % 5) * 0.12),
        periodMs: 260 + (n * 37) % 60,
        delayMs: (n * 53) % 120,
    };
}

/** freedesktop main categories -> the macOS-style folder name Launchpad suggests. */
export const FOLDER_NAMES = Object.freeze({
    Game: 'Games',
    Development: 'Developer Tools',
    Graphics: 'Graphics & Design',
    Office: 'Productivity',
    Network: 'Internet',
    AudioVideo: 'Entertainment',
    Audio: 'Music',
    Video: 'Video',
    Education: 'Education',
    Science: 'Education',
    Settings: 'Utilities',
    System: 'Utilities',
    Utility: 'Utilities',
});

/**
 * The name of a new folder (macOS names it after what its apps have in common): the first
 * main category every app shares, else the most common one, else null ("Untitled Folder").
 *
 * @param {string[][]} categoryLists one list per app
 * @returns {?string} an untranslated FOLDER_NAMES value
 */
export function folderNameFor(categoryLists) {
    const counts = new Map();
    for (const list of categoryLists) {
        for (const c of new Set(list)) {
            if (FOLDER_NAMES[c])
                counts.set(c, (counts.get(c) ?? 0) + 1);
        }
    }
    let best = null;
    for (const c of Object.keys(FOLDER_NAMES)) {
        const n = counts.get(c) ?? 0;
        if (n > 0 && (!best || n > counts.get(best)))
            best = c;
    }
    return best ? FOLDER_NAMES[best] : null;
}

/**
 * GNOME's "Show all apps" accelerators with Launchpad's own taken out (Launchpad replaces the
 * app grid there, Super+A by default). Accelerators are compared normalized.
 *
 * @param {string[]} stock org.gnome.shell.keybindings toggle-application-view (the user's)
 * @param {string[]} ours launchpad-shortcut
 * @param {(accel: string) => string} normalize lib/keybindingsModel.js normalizeAccel
 * @returns {string[]}
 */
export function freeAccels(stock, ours, normalize) {
    const taken = new Set(ours.map(normalize).filter(Boolean));
    return stock.filter(a => !taken.has(normalize(a)));
}
