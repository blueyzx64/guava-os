// SPDX-License-Identifier: GPL-3.0-or-later
// Menu bar items: the pure rules of the status-item host, the pinned Control Center controls
// and the item manager (F43; UI "Menu bar"). No gi imports.
//
// Every item the manager handles has an id:
//   pin:<control>   a Control Center control pinned to the menu bar (pinned.js)
//   sni:<Id>        a StatusNotifierItem (an app's tray icon), hosted by Guava or AppIndicator
//   stock:<role>    a GNOME status-area item Guava may hide or move (the input-source menu)

import { MAX_DEPTH, MAX_ITEMS, stripMnemonic } from '../../core/appMenus/nativeModel.js';

// Pinned controls: lib/menuBarPins.js (shared with the Control Center editor and the prefs)

// ---- status-item host -----------------------------------------------------------------

export const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
export const WATCHER_PATH = '/StatusNotifierWatcher';
export const ITEM_PATH = '/StatusNotifierItem';
/** Extensions that host status items themselves; Guava defers to them. */
export const APPINDICATOR_UUIDS = Object.freeze([
    'appindicatorsupport@rgcjonas.gmail.com',
    'ubuntu-appindicators@ubuntu.com',
]);

/**
 * Who hosts the status items.
 *   'defer'  the AppIndicator extension is enabled: it owns the watcher and draws the icons;
 *            Guava only manages (hides, orders) the items it adds to the panel
 *   'own'    Guava owns org.kde.StatusNotifierWatcher and draws the icons
 *   'client' another program owns the watcher (a KDE session, a tray daemon): Guava registers
 *            as a host with it and draws the icons
 *   'off'    the user turned the host off
 *
 * @param {{enabled: boolean, appIndicator: boolean, otherOwner: boolean}} s
 */
export function hostMode({ enabled, appIndicator, otherOwner }) {
    if (!enabled)
        return 'off';
    if (appIndicator)
        return 'defer';
    return otherOwner ? 'client' : 'own';
}

/**
 * Where an item lives on the bus. Apps register "service" (a bus name, the object at the
 * default path), "/path" (on the caller's connection: libappindicator, Electron) or
 * "service/path".
 *
 * @param {string} service the RegisterStatusNotifierItem argument
 * @param {string} sender the unique name of the caller
 * @returns {{bus: string, path: string}}
 */
export function parseItemAddress(service, sender) {
    const s = String(service ?? '');
    if (s.startsWith('/'))
        return { bus: sender, path: s };
    const slash = s.indexOf('/');
    if (slash > 0)
        return { bus: s.slice(0, slash), path: s.slice(slash) };
    return { bus: s || sender, path: ITEM_PATH };
}

/** The string the watcher lists for an item ("bus/path", as KDE and AppIndicator do). */
export function itemAddress({ bus, path }) {
    return `${bus}${path}`;
}

/**
 * A stable manager id for an item. The SNI `Id` (e.g. "discord", "steam") survives restarts,
 * so a hidden item stays hidden; bus names change on every launch.
 */
export function sniId(id, title, fallback) {
    const base = String(id || title || fallback || 'item').trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return `sni:${base || 'item'}`;
}

/** SNI Status -> shown. Passive items (idle tray icons) stay hidden, as KDE and macOS do. */
export function sniVisible(status) {
    return status !== 'Passive';
}

/**
 * Which pixmap of an SNI IconPixmap list to draw: the smallest one at least `size` pixels,
 * else the largest.
 *
 * @param {{width: number, height: number}[]} pixmaps
 * @returns {number} index, -1 when the list is empty
 */
export function pickPixmap(pixmaps, size) {
    let best = -1;
    pixmaps.forEach((p, i) => {
        if (!(p.width > 0 && p.height > 0))
            return;
        if (best < 0) {
            best = i;
            return;
        }
        const b = pixmaps[best];
        const fits = p.width >= size;
        const bFits = b.width >= size;
        if ((fits && (!bFits || p.width < b.width)) || (!fits && !bFits && p.width > b.width))
            best = i;
    });
    return best;
}

/**
 * SNI pixmaps are ARGB32 in network byte order; Cogl wants RGBA. Returns a new array.
 *
 * @param {Uint8Array} argb
 * @returns {Uint8Array}
 */
export function argbToRgba(argb) {
    const out = new Uint8Array(argb.length - (argb.length % 4));
    for (let i = 0; i < out.length; i += 4) {
        out[i] = argb[i + 1];
        out[i + 1] = argb[i + 2];
        out[i + 2] = argb[i + 3];
        out[i + 3] = argb[i];
    }
    return out;
}

/**
 * A DBusMenu layout node, recursively unpacked ([id, {props}, [children]]), as a menu tree.
 * Invisible items are dropped; separators kept, but never first, last or doubled. At most
 * MAX_ITEMS items are read and submenus nest MAX_DEPTH deep.
 *
 * @returns {{id: number, label: string, separator: boolean, enabled: boolean,
 *   toggle: ''|'checkmark'|'radio', checked: boolean, icon: ?string, children: object[]}}
 */
export function parseMenu(node) {
    return unpackMenu(node, 0, { left: MAX_ITEMS });
}

// Bounded like core/appMenus: an app cannot make the Shell build an endless tree
function unpackMenu(node, depth, budget) {
    const [id, props = {}, children = []] = node ?? [0, {}, []];
    const kids = [];
    if (depth < MAX_DEPTH) {
        for (const child of children ?? []) {
            if (budget.left <= 0)
                break;
            budget.left--;
            const item = unpackMenu(child, depth + 1, budget);
            if (!item.visible)
                continue;
            if (item.separator && (!kids.length || kids[kids.length - 1].separator))
                continue;
            kids.push(item);
        }
    }
    while (kids.length && kids[kids.length - 1].separator)
        kids.pop();
    const toggle = props['toggle-type'] === 'checkmark' || props['toggle-type'] === 'radio'
        ? props['toggle-type'] : '';
    return {
        id: Number(id) || 0,
        label: stripMnemonic(props.label),
        separator: props.type === 'separator',
        visible: props.visible !== false,
        enabled: props.enabled !== false,
        toggle,
        checked: toggle !== '' && Number(props['toggle-state']) === 1,
        icon: typeof props['icon-name'] === 'string' && props['icon-name'] ? props['icon-name'] : null,
        children: kids,
    };
}

// ---- the item manager -----------------------------------------------------------------

/**
 * The bar order: the saved ids that are live, in saved order; new ones go first (macOS adds
 * a new status item at the left end of the status area), in the order they came.
 *
 * @param {string[]} saved `menubar-item-order`
 * @param {string[]} live ids of the items present now, in arrival order
 */
export function barOrder(saved, live) {
    const liveSet = new Set(live);
    const savedSet = new Set(saved);
    return [...live.filter(id => !savedSet.has(id)), ...saved.filter(id => liveSet.has(id))];
}

/** Move `id` by `delta` in the full saved order (live and remembered items alike). */
export function moveItem(order, id, delta) {
    const from = order.indexOf(id);
    if (from < 0)
        return order;
    const to = Math.max(0, Math.min(order.length - 1, from + delta));
    const out = [...order];
    out.splice(from, 1);
    out.splice(to, 0, id);
    return out;
}

/**
 * The prefs' list of items: "id\ttitle" lines, newest information wins, capped. Items stay
 * listed after they quit so they can be hidden before they start again.
 *
 * @param {string[]} registry `menubar-item-registry`
 * @param {{id: string, title: string}[]} items
 * @returns {string[]}
 */
export function updateRegistry(registry, items, cap = 48) {
    const map = new Map();
    for (const line of registry ?? []) {
        const [id, title = ''] = String(line).split('\t');
        if (id)
            map.set(id, title);
    }
    for (const { id, title } of items)
        map.set(id, String(title ?? '').replace(/[\t\n]/g, ' '));
    const lines = [...map].map(([id, title]) => `${id}\t${title}`);
    return lines.slice(Math.max(0, lines.length - cap));
}

export function parseRegistry(registry) {
    return (registry ?? []).map(line => {
        const [id, title = ''] = String(line).split('\t');
        return { id, title: title || id };
    }).filter(e => e.id);
}

/**
 * Which items fit in the menu bar. The right box gets at most half of what the centre (the
 * notch) leaves; items the user hid, or that are not wanted now (a "when active" pin that is
 * idle, a passive tray icon), take no room. When the rest does not fit, a chevron takes the
 * left end and the items at the left of the order go behind it (the right end stays, as
 * macOS keeps the items next to Control Center).
 *
 * @param {object} s
 * @param {string[]} s.order
 * @param {Set<string>|string[]} s.hidden ids the user hid
 * @param {Set<string>|string[]} s.idle ids that do not want to show now
 * @param {Map<string, number>} s.widths natural widths
 * @param {number} s.available width left for the managed items
 * @param {number} s.chevron width of the chevron button
 * @param {boolean} [s.overflow] false: never collapse (items may be clipped)
 * @returns {{shown: string[], overflow: string[], chevron: boolean}}
 */
export function planBar({ order, hidden, idle, widths, available, chevron, overflow = true }) {
    const hid = new Set(hidden);
    const off = new Set(idle);
    const wanted = order.filter(id => !hid.has(id) && !off.has(id));
    const width = id => Math.max(0, widths.get(id) ?? 0);
    const total = wanted.reduce((sum, id) => sum + width(id), 0);
    if (!overflow || total <= available)
        return { shown: wanted, overflow: [], chevron: false };
    let budget = available - chevron;
    let cut = wanted.length;
    while (cut > 0 && budget - width(wanted[cut - 1]) >= 0) {
        budget -= width(wanted[cut - 1]);
        cut--;
    }
    return { shown: wanted.slice(cut), overflow: wanted.slice(0, cut), chevron: cut > 0 };
}

