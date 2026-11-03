// SPDX-License-Identifier: GPL-3.0-or-later
// Control Center layout model. Pure functions, no gi imports, so it runs under `gjs -m`.
//
// The stock Quick Settings grid is a flow layout with N columns and a per-child column
// span. The Control Center runs it with 4 columns (a half-width stock tile is span 2) and
// decides, from this table, the order and span of every item.

export const COLUMNS = 4;

/**
 * Block order, top to bottom. 'top' is the macOS top block: the connectivity stack in the
 * left half, Do Not Disturb and a few secondary squares in the right half. The secondary
 * squares that do not fit there go to 'toggles', one compact row under the media.
 */
export const GROUPS = [
    'top', 'display', 'sound', 'media', 'toggles', 'guava',
    'background', 'extras', 'notifications', 'system', 'footer',
];

export const MORE_HEADER_ID = 'guava:more-header';
/** Captions of the Display and Sound modules (they join the sliders under them). */
export const DISPLAY_HEADER_ID = 'guava:display-header';
export const SOUND_HEADER_ID = 'guava:sound-header';
/** Blank half cells that keep the right column of the top block in step with the left. */
export const SPACER_PREFIX = 'guava:spacer-';

// key -> [role, rank]
//   conn       a row of the connectivity stack (left half of the top block)
//   focus      Do Not Disturb, first in the right half
//   secondary  an on/off toggle: a 1x1 icon-only square when the shell can make it one
//              (a plain QuickToggle), a labelled half tile otherwise
//   display / sound   sliders, joined under their caption
//   other roles are full-width blocks of the same name
const STOCK = {
    'wifi': ['conn', 0],
    'wired': ['conn', 1],
    'bluetooth': ['conn', 2],
    'vpn': ['conn', 3],
    'modem': ['conn', 4],
    'bt-tether': ['conn', 5],

    'dnd': ['focus', 0],

    'dark-style': ['secondary', 0],
    'night-light': ['secondary', 1],
    'airplane': ['secondary', 2],
    'power-saver': ['secondary', 3],
    'backlight': ['secondary', 4],
    'rotation': ['secondary', 5],
    'location': ['secondary', 6],
    'camera': ['secondary', 7],
    'remote-access': ['secondary', 8],
    'thunderbolt': ['secondary', 9],
    'unsafe': ['secondary', 10],

    'brightness': ['display', 0],
    'volume-out': ['sound', 0],
    'volume-in': ['sound', 1],
    'now-playing': ['media', 0],
    'guava-toggles': ['guava', 0],
    'background-apps': ['background', 0],
    'notifications': ['notifications', 0],
    'system': ['system', 0],
    // The "Edit Controls…" button (customModel.js), under everything
    'edit-controls': ['footer', 0],
};

/**
 * The Guava feature tiles of the Control Center, in display order. Each is bound to the
 * boolean settings key that switches the feature on. The Control Center itself is
 * deliberately absent: switching it off from inside would take the switch away.
 */
// Marks a label for translation (xgettext -kN_); the adapter translates it with gettext
const N_ = s => s;

export const GUAVA_TOGGLES = [
    { key: 'notch', icon: 'preferences-system-notifications-symbolic', label: N_('Notch') },
    { key: 'stage-manager', icon: 'view-paged-symbolic', label: N_('Stage Manager') },
    { key: 'clipboard-history', icon: 'edit-paste-symbolic', label: N_('Clipboard') },
    { key: 'spotlight', icon: 'system-search-symbolic', label: N_('Spotlight') },
    { key: 'liquid-glass', icon: 'weather-fog-symbolic', label: N_('Liquid Glass') },
    { key: 'rounded-corners', icon: 'window-restore-symbolic', label: N_('Rounded Corners') },
    { key: 'show-desktop-button', icon: 'guava-show-desktop-symbolic', label: N_('Show Desktop') },
];

/** Columns of the Guava tile module. */
export const GUAVA_COLUMNS = 8;

/**
 * The Guava tiles to build, given which keys the schema has, with their cell in the
 * module's own grid.
 *
 * @param {(key: string) => boolean} hasKey
 * @returns {{key: string, icon: string, label: string, column: number, row: number}[]}
 */
export function guavaTiles(hasKey) {
    return GUAVA_TOGGLES
        .filter(t => t.key !== 'control-center' && hasKey(t.key))
        .map((t, i) => ({ ...t, column: i % GUAVA_COLUMNS, row: Math.floor(i / GUAVA_COLUMNS) }));
}

export function isKnownKey(key) {
    return Object.hasOwn(STOCK, key);
}

/**
 * Where one item goes, before the top block is shared out. Unknown items (other
 * extensions' toggles) land in "extras" and keep their stock look: a stock span of 1 of 2
 * columns becomes 2 of 4.
 *
 * @param {{key: ?string, stockSpan?: number, compactable?: boolean}} entry
 * @returns {{role: string, rank: number, span: number, compact: boolean}}
 */
export function place(entry) {
    if (entry.key && Object.hasOwn(STOCK, entry.key)) {
        const [role, rank] = STOCK[entry.key];
        if (role === 'conn' || role === 'focus')
            return { role, rank, span: 2, compact: false };
        if (role === 'secondary') {
            return entry.compactable
                ? { role, rank, span: 1, compact: true }
                : { role, rank, span: 2, compact: false };
        }
        return { role, rank, span: COLUMNS, compact: false };
    }
    const span = Math.min(COLUMNS, Math.max(1, (entry.stockSpan ?? 1) * 2));
    return { role: 'extras', rank: 0, span, compact: false };
}

const byRank = (a, b) => a.rank - b.rank || a.index - b.index;

/** Mark a run of items as one module: rounded outer corners, joined edges inside. */
function join(run) {
    run.forEach((item, i) => {
        item.joinPrev = i > 0;
        item.joinNext = i < run.length - 1;
    });
}

/**
 * Take one row two cells wide out of `pool` (in rank order): the first two squares side by
 * side; else the first labelled half tile; else the last square alone, its label back (a
 * lone icon-only half tile reads as a bug).
 *
 * @returns {object[]} the row
 */
function takeHalfRow(pool) {
    const squares = pool.filter(i => i.compact);
    const labelled = pool.find(i => !i.compact);
    let row;
    if (squares.length >= 2) {
        row = squares.slice(0, 2);
    } else if (labelled) {
        row = [labelled];
    } else {
        row = squares;
        row[0].span = 2;
        row[0].compact = false;
    }
    for (const item of row)
        pool.splice(pool.indexOf(item), 1);
    return row;
}

/**
 * Order, spans and module joins for the whole grid.
 *
 * - Top block: the connectivity toggles are one stack in the left half (one row each).
 *   The right half takes Do Not Disturb, then rows of two secondary squares, as many rows
 *   as the stack has (at least one). Blank spacers fill the right half if it runs out.
 *   With no connectivity at all the block is one row: Do Not Disturb and two squares.
 * - Display and Sound: a caption joined to its sliders.
 * - The secondary toggles left over: squares first, then labelled half tiles, packed in
 *   rows of COLUMNS. A labelled tile alone at the end of a row is widened.
 * - Everything else is full width, in GROUPS order. The "More" header heads the extras.
 * Hidden items keep a place at the end of their block (they may appear later) and are not
 * counted.
 *
 * @param {{id: string, key: ?string, stockSpan?: number, visible: boolean,
 *   compactable?: boolean}[]} entries
 * @returns {{id: string, group: string, span: number, visible: boolean, compact: boolean,
 *   joinPrev: boolean, joinNext: boolean}[]}
 */
export function planLayout(entries) {
    const items = entries.map((entry, index) => ({
        id: entry.id, index, visible: entry.visible, joinPrev: false, joinNext: false,
        ...place(entry),
    }));
    const shown = role => items.filter(i => i.role === role && i.visible).sort(byRank);
    const hidden = role => items.filter(i => i.role === role && !i.visible);
    const out = [];
    const emit = (group, list) => list.forEach(item => out.push({ ...item, group }));

    // ---- top block
    const conn = shown('conn');
    const focus = shown('focus');
    const pool = shown('secondary');
    const top = [];
    if (conn.length) {
        join(conn);
        const right = focus.map(item => [item]);
        while (right.length < conn.length && pool.length)
            right.push(takeHalfRow(pool));
        let spacers = 0;
        conn.forEach((item, r) => {
            top.push(item);
            top.push(...right[r] ?? [{ id: `${SPACER_PREFIX}${spacers++}`, visible: true, span: 2 }]);
        });
        // Do Not Disturb never drops out of the block, even beside a one-row stack
        right.slice(conn.length).forEach(row => top.push(...row));
    } else if (focus.length) {
        top.push(...focus);
        if (pool.length)
            top.push(...takeHalfRow(pool));
    }
    emit('top', [...top, ...hidden('conn'), ...hidden('focus')]);

    // ---- display, sound: caption + sliders
    for (const [group, headerId] of [['display', DISPLAY_HEADER_ID], ['sound', SOUND_HEADER_ID]]) {
        const sliders = shown(group);
        const header = { id: headerId, visible: sliders.length > 0, span: COLUMNS };
        join([header, ...sliders]);
        emit(group, [header, ...sliders, ...hidden(group)]);
    }

    emit('media', [...shown('media'), ...hidden('media')]);

    // ---- leftover secondary toggles: squares first, then labelled tiles. A short last row
    // of squares then takes the next labelled tile beside it (widened to the row end), so a
    // square is never left alone on a row under labelled tiles.
    const labelled = pool.filter(i => !i.compact);
    const squares = pool.filter(i => i.compact);
    const toggles = [...squares, ...labelled];
    let col = 0;
    toggles.forEach((item, i) => {
        if (col + item.span > COLUMNS)
            col = 0;
        col += item.span;
        const next = toggles[i + 1];
        const rowEnds = !next || col + next.span > COLUMNS;
        if (rowEnds && !item.compact && col < COLUMNS)
            item.span += COLUMNS - col;
        if (rowEnds)
            col = 0;
    });
    emit('toggles', [...toggles, ...hidden('secondary')]);

    for (const group of ['guava', 'background'])
        emit(group, [...shown(group), ...hidden(group)]);

    const extras = items.filter(i => i.role === 'extras');
    emit('extras', [
        { id: MORE_HEADER_ID, visible: extras.some(i => i.visible), span: COLUMNS },
        ...extras.filter(i => i.visible), ...extras.filter(i => !i.visible),
    ]);

    for (const group of ['notifications', 'system', 'footer'])
        emit(group, [...shown(group), ...hidden(group)]);

    return out.map(({ id, group, span, visible, compact = false, joinPrev = false, joinNext = false }) =>
        ({ id, group, span, visible, compact, joinPrev, joinNext }));
}

/**
 * The order to put back on disable. The grid may have been rebuilt, or items removed or
 * re-parented by others, since the snapshot: only ids that are still in the live grid are
 * kept, in their saved order. Ids that appeared since go after them, in live order.
 *
 * Works on any identity values (ids in tests, actors in the shell adapter).
 *
 * @param {string[]} saved
 * @param {string[]} live items currently in the grid, in current order
 * @returns {string[]}
 */
export function restoreOrder(saved, live) {
    const liveSet = new Set(live);
    const keep = saved.filter(id => liveSet.has(id));
    const keepSet = new Set(keep);
    return [...keep, ...live.filter(id => !keepSet.has(id))];
}

// The battery time shown in the user row (shared with the menu bar's Battery item)
export { BATTERY_STATE, batteryTime } from '../../lib/batteryModel.js';
