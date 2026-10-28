// SPDX-License-Identifier: GPL-3.0-or-later
// Native app menus as plain values: what the P6 providers read from an app, turned into the
// menu items the menu bar shows (core/appMenus/model.js shapes).
//
//   GTK exported menus   org.gtk.Menus rows -> GMenuStore -> gmenuToMenus(store, actions)
//   DBusMenu             com.canonical.dbusmenu GetLayout -> dbusmenuToMenus(layout)
//   AT-SPI               accessible nodes {role, name, states, children} -> atspiToMenus(menubar)
//
// Items: {kind: 'item', id, label, enabled, accel, checked: bool|null, radio, command},
// {kind: 'submenu', id, label, enabled, items}, {kind: 'separator'}, {kind: 'heading', label}.
// Top-level menus: {id, title, items}; nativeMenuId() maps a title to Guava's ids (File ->
// 'file') so the menu bar keeps Guava's Window and Help where they belong.
//
// Pure JS (no gi imports): runs under `gjs -m` in tests.

const SEP = Object.freeze({ kind: 'separator' });

/** Replies (GMenu Start, DBusMenu GetLayout, AT-SPI cache) larger than this are not parsed. */
export const MAX_REPLY_BYTES = 1024 * 1024;

/** At most this many items are built for one app's menus. */
export const MAX_ITEMS = 3000;

/** Submenus nest at most this deep. */
export const MAX_DEPTH = 8;

/** Drop a mnemonic: '_File' -> 'File', '__init' -> '_init' (GTK, and Qt through DBusMenu). */
export function stripMnemonic(label) {
    return String(label ?? '').replace(/_(_)?/g, (_m, u) => u ?? '');
}

/** Guava's id for a native top-level menu title, or a stable 'native:<title>' id. */
export function nativeMenuId(title) {
    const t = stripMnemonic(title).trim().toLowerCase();
    const known = { file: 'file', edit: 'edit', view: 'view', window: 'window', help: 'help' };
    return known[t] ?? `native:${t}`;
}

// Separators: none first, last or doubled
function tidy(items) {
    const out = [];
    for (const it of items) {
        if (!it)
            continue;
        if (it.kind === 'separator' && (!out.length || out[out.length - 1].kind === 'separator'))
            continue;
        out.push(it);
    }
    while (out.length && out[out.length - 1].kind === 'separator')
        out.pop();
    return out;
}

// ---- GTK exported menus (org.gtk.Menus) ----------------------------------------------------

/**
 * The menus one org.gtk.Menus object exported, kept up to date from Start() replies and
 * Changed signals. Rows are unpacked GVariants:
 *   Start   a(uuaa{sv})    [group, menu, items]
 *   Changed a(uuuuaa{sv})  [group, menu, position, removed, items]
 * Item attributes: label, action, target, accel, hidden-when, and the links ':section' and
 * ':submenu' as [group, menu]. The adapter adds 'target-type' (the target's GVariant type) so
 * the target can be sent back on activation.
 */
export class GMenuStore {
    constructor() {
        this._menus = new Map(); // 'group:menu' -> items
        this._started = new Set(); // groups subscribed with Start(), to End() later
    }

    /** The groups Start() subscribed to. */
    get started() {
        return [...this._started];
    }

    markStarted(groups) {
        for (const g of groups)
            this._started.add(g);
    }

    get size() {
        return this._menus.size;
    }

    /** The groups the store holds (the ones to End() when done). */
    groups() {
        return [...new Set([...this._menus.keys()].map(k => Number(k.split(':')[0])))];
    }

    load(rows) {
        for (const [group, menu, items] of rows ?? [])
            this._menus.set(`${group}:${menu}`, [...items]);
    }

    /** @returns {boolean} true when a known menu changed */
    change(rows) {
        let hit = false;
        for (const [group, menu, position, removed, items] of rows ?? []) {
            const key = `${group}:${menu}`;
            const cur = this._menus.get(key);
            if (!cur)
                continue;
            cur.splice(position, removed, ...items);
            hit = true;
        }
        return hit;
    }

    items(group, menu) {
        return this._menus.get(`${group}:${menu}`) ?? null;
    }

    /** Every menu's items. */
    menus() {
        return [...this._menus.values()];
    }

    /** Groups that items link to (sections, submenus) but were not started or loaded. */
    missingGroups() {
        const have = new Set([...this.groups(), ...this._started]);
        const out = new Set();
        for (const items of this._menus.values()) {
            for (const attrs of items) {
                for (const link of [attrs[':section'], attrs[':submenu']]) {
                    if (Array.isArray(link) && !have.has(link[0]))
                        out.add(link[0]);
                }
            }
        }
        return [...out];
    }
}

const linkOf = v => (Array.isArray(v) && v.length === 2 ? v : null);

/**
 * The menu bar of an exported GMenu (group 0, menu 0).
 *
 * @param {GMenuStore} store
 * @param {object} [opts]
 * @param {{group, name, enabled, parameterized, state}[]} [opts.actions] the app's
 *   app.* and win.* actions (org.gtk.Actions DescribeAll), for enabled and toggle states
 * @param {string} [opts.provider] the command's provider id
 * @param {number[]} [opts.root] [group, menu] of the menu bar
 * @returns {{id, title, items}[]}
 */
export function gmenuToMenus(store, { actions = [], provider = 'gtk-menus', root = [0, 0], accels = null } = {}) {
    const byName = new Map(actions.map(a => [`${a.group}.${a.name}`, a]));
    let seq = 0;
    let budget = MAX_ITEMS;
    const seen = new Set();

    const itemFor = attrs => {
        const label = stripMnemonic(attrs.label ?? '');
        const actionName = attrs.action ?? null;
        const action = actionName ? byName.get(actionName) ?? null : null;
        const hidden = attrs['hidden-when'];
        if (hidden === 'action-missing' && !action)
            return null;
        if (hidden === 'action-disabled' && (!action || !action.enabled))
            return null;
        const [group, ...rest] = (actionName ?? '').split('.');
        const name = rest.join('.');
        const target = attrs.target === undefined ? null : attrs.target;
        let checked = null;
        let radio = false;
        if (action && action.state !== null && action.state !== undefined) {
            if (target !== null) {
                radio = true;
                checked = action.state === target;
            } else if (typeof action.state === 'boolean') {
                checked = action.state;
            }
        }
        const reachable = !!action && (group === 'app' || group === 'win');
        return {
            kind: 'item', id: `${provider}:${seq++}`, label,
            enabled: reachable && action.enabled !== false,
            accel: attrs.accel ?? (target === null ? accels?.get(actionName) : null) ?? null,
            checked, radio,
            command: reachable ? { provider, group, name, target, targetType: attrs['target-type'] ?? null } : null,
        };
    };

    const walk = (group, menu, depth) => {
        const key = `${group}:${menu}`;
        const rows = store.items(group, menu);
        if (!rows || depth > 8 || seen.has(key))
            return [];
        seen.add(key);
        const out = [];
        for (const attrs of rows) {
            if (budget-- <= 0)
                break;
            const section = linkOf(attrs[':section']);
            const submenu = linkOf(attrs[':submenu']);
            if (section) {
                const inner = walk(section[0], section[1], depth + 1);
                if (!inner.length)
                    continue;
                out.push(SEP);
                if (attrs.label)
                    out.push({ kind: 'heading', label: stripMnemonic(attrs.label) });
                out.push(...inner, SEP);
            } else if (submenu) {
                const inner = tidy(walk(submenu[0], submenu[1], depth + 1));
                if (inner.length) {
                    out.push({
                        kind: 'submenu', id: `${provider}:${seq++}`,
                        label: stripMnemonic(attrs.label ?? ''), enabled: true, items: inner,
                    });
                }
            } else {
                out.push(itemFor(attrs));
            }
        }
        seen.delete(key);
        return out;
    };

    // The top level: submenus become menus; loose items (rare) go to the app's own menu
    const top = walk(root[0], root[1], 0);
    const menus = [];
    const loose = [];
    for (const it of top) {
        if (it?.kind === 'submenu')
            menus.push({ id: nativeMenuId(it.label), title: it.label, items: it.items });
        else if (it?.kind === 'item')
            loose.push(it);
    }
    if (loose.length)
        menus.unshift({ id: 'app', title: '', items: loose });
    return menus;
}

/** Every action name the store's items use ('app.save'), once each. */
export function gmenuActionNames(store) {
    const out = new Set();
    for (const items of store.menus()) {
        for (const attrs of items) {
            if (typeof attrs.action === 'string')
                out.add(attrs.action);
        }
    }
    return [...out];
}

// ---- DBusMenu (com.canonical.dbusmenu) -----------------------------------------------------

const DBUSMENU_MODS = Object.freeze({
    control: '<Control>', ctrl: '<Control>', alt: '<Alt>', shift: '<Shift>', super: '<Super>', meta: '<Super>',
});

/**
 * A DBusMenu shortcut (aas: [['Control', 'Shift', 'S']]) as a GTK accelerator.
 *
 * @returns {?string} '<Control><Shift>s', or null
 */
export function dbusmenuShortcut(shortcut) {
    const first = Array.isArray(shortcut) ? shortcut[0] : null;
    if (!Array.isArray(first) || !first.length)
        return null;
    const keys = first.map(String);
    const key = keys[keys.length - 1];
    let mods = '';
    for (const m of keys.slice(0, -1))
        mods += DBUSMENU_MODS[m.toLowerCase()] ?? '';
    return `${mods}${key.length === 1 ? key.toLowerCase() : key}`;
}

/**
 * A GetLayout node, unpacked: [id, props, children] with children unpacked the same way.
 *
 * @param {Array} node
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @returns {{id, title, items}[]} the top-level menus under the root
 */
export function dbusmenuToMenus(node, { provider = 'dbusmenu' } = {}) {
    const budget = { left: MAX_ITEMS };
    const items = children => tidy((children ?? []).map(child => itemFromLayout(child, provider, 0, budget)));
    const [, , children] = node ?? [0, {}, []];
    const menus = [];
    for (const child of children ?? []) {
        const [id, props, sub] = child;
        if (props.visible === false || props.type === 'separator')
            continue;
        const title = stripMnemonic(props.label ?? '');
        if (!title)
            continue;
        menus.push({ id: nativeMenuId(title), title, items: items(sub), nativeId: id });
    }
    return menus;
}

function itemFromLayout([id, props, children], provider, depth, budget) {
    if (props.visible === false || budget.left-- <= 0)
        return null;
    if (props.type === 'separator')
        return SEP;
    const label = stripMnemonic(props.label ?? '');
    const enabled = props.enabled !== false;
    if ((props['children-display'] === 'submenu' || children?.length) && depth < MAX_DEPTH) {
        const inner = tidy((children ?? []).map(c => itemFromLayout(c, provider, depth + 1, budget)));
        return { kind: 'submenu', id: `${provider}:${id}`, label, enabled, items: inner, nativeId: id };
    }
    const toggle = props['toggle-type'];
    const checked = toggle === 'checkmark' || toggle === 'radio' ? props['toggle-state'] === 1 : null;
    return {
        kind: 'item', id: `${provider}:${id}`, label, enabled,
        accel: dbusmenuShortcut(props.shortcut),
        checked, radio: toggle === 'radio',
        command: { provider, id },
    };
}

/** Submenu ids under the root (to send AboutToShow before reading them). */
export function dbusmenuSubmenuIds(node, depth = 1) {
    const out = [];
    const walk = ([id, props, children], d) => {
        if (d > 0 && (props['children-display'] === 'submenu' || children?.length))
            out.push(id);
        if (d < depth)
            for (const c of children ?? [])
                walk(c, d + 1);
    };
    if (node)
        walk(node, 0);
    return out;
}

// ---- AT-SPI ------------------------------------------------------------------------------------

/** AtspiRole values the provider reads (at-spi2-core atspi-constants.h). */
export const ROLE = Object.freeze({
    CHECK_MENU_ITEM: 8, FRAME: 23, MENU: 33, MENU_BAR: 34, MENU_ITEM: 35, POPUP_MENU: 41,
    PUSH_BUTTON: 43, RADIO_MENU_ITEM: 45, SEPARATOR: 50, TOGGLE_BUTTON: 62, WINDOW: 69,
});

/** AtspiStateType bits (two uint32 words from GetState). */
export const STATE = Object.freeze({ ACTIVE: 1, CHECKED: 4, ENABLED: 8, SENSITIVE: 24, SHOWING: 25, VISIBLE: 30, PRESSED: 20 });

export function hasState(states, bit) {
    const word = states?.[bit >> 5] ?? 0;
    return ((word >>> (bit & 31)) & 1) === 1;
}

const MENU_ROLES = new Set([ROLE.MENU, ROLE.POPUP_MENU]);
export const ITEM_ROLES = new Set([ROLE.MENU_ITEM, ROLE.CHECK_MENU_ITEM, ROLE.RADIO_MENU_ITEM, ROLE.MENU]);

/** Depth-first search for the first node with a role (null when none). */
export function findRole(node, role, depth = 0, maxDepth = 24) {
    if (!node || depth > maxDepth)
        return null;
    if (node.role === role)
        return node;
    for (const c of node.children ?? []) {
        const hit = findRole(c, role, depth + 1, maxDepth);
        if (hit)
            return hit;
    }
    return null;
}

/**
 * The menu button of a libadwaita window's header bar ("Main Menu", "Primary Menu", "Menu").
 *
 * @returns {?object} the node
 */
export function findPrimaryMenuButton(frame) {
    const out = [];
    const walk = n => {
        if (!n)
            return;
        if ((n.role === ROLE.TOGGLE_BUTTON || n.role === ROLE.PUSH_BUTTON) &&
            /^(main|primary|application)?\s*menu$/i.test((n.name ?? '').trim()))
            out.push(n);
        for (const c of n.children ?? [])
            walk(c);
    };
    walk(frame);
    // 'Main Menu' beats a plain 'Menu' (a document's menu); GTK 4 names both the GtkMenuButton
    // and its inner toggle button, and only the toggle has the click action
    const rank = n => (/main|primary/i.test(n.name) ? 2 : 0) + (n.role === ROLE.TOGGLE_BUTTON ? 1 : 0);
    out.sort((a, b) => rank(b) - rank(a));
    return out[0] ?? null;
}

/**
 * The accelerator of an Action key binding ('N;;Control+N': mnemonic;;shortcut) as a GTK
 * accelerator string ('<Control>n'); null when it has none.
 */
export function atspiAccel(binding) {
    const combo = (binding ?? '').split(';;')[1]?.trim();
    if (!combo)
        return null;
    const parts = combo.split('+');
    const key = parts.pop();
    const mods = parts.map(m => `<${m}>`).join('');
    const names = { '?': 'question', ',': 'comma', '+': 'plus', '-': 'minus', '.': 'period' };
    return mods + (names[key] ?? (key.length === 1 ? key.toLowerCase() : key));
}

/** The node a relation set says labels this one ([bus, path]) or null. */
export function labelTarget(relations, LABELLED_BY = 2) {
    const rel = (relations ?? []).find(r => r[0] === LABELLED_BY);
    return rel?.[1]?.[0] ?? null;
}

/** Path of labels from the root to a node: the key to find an item again after a reopen. */
function atspiItems(node, provider, path, depth) {
    const out = [];
    for (const c of node.children ?? []) {
        if (c.role === ROLE.SEPARATOR) {
            out.push(SEP);
            continue;
        }
        if (MENU_ROLES.has(c.role) && !c.name) {
            // GTK3 puts a nameless popup menu between an item and its children
            out.push(...atspiItems(c, provider, path, depth + 1));
            continue;
        }
        if (!ITEM_ROLES.has(c.role)) {
            if (depth < 12 && c.children?.length)
                out.push(...atspiItems(c, provider, path, depth + 1));
            continue;
        }
        const label = (c.label || c.name || '').trim();
        if (!label)
            continue;
        const enabled = c.states ? hasState(c.states, STATE.SENSITIVE) || hasState(c.states, STATE.ENABLED) : true;
        const subPath = [...path, label];
        const kids = depth < 12 ? atspiItems(c, provider, subPath, depth + 1) : [];
        if (c.role === ROLE.MENU || kids.some(k => k.kind !== 'separator')) {
            out.push({ kind: 'submenu', id: `${provider}:${subPath.join('/')}`, label, enabled, items: tidy(kids) });
            continue;
        }
        const checkable = c.role === ROLE.CHECK_MENU_ITEM || c.role === ROLE.RADIO_MENU_ITEM;
        out.push({
            kind: 'item', id: `${provider}:${subPath.join('/')}`, label, enabled,
            accel: c.accel ?? atspiAccel(c.keyBinding),
            checked: checkable ? hasState(c.states, STATE.CHECKED) : null,
            radio: c.role === ROLE.RADIO_MENU_ITEM,
            command: { provider, path: subPath, ref: c.ref ?? null },
        });
    }
    return out;
}

/**
 * Menus from an accessible MENU_BAR node (Firefox, LibreOffice, GTK 3 menu bars).
 *
 * @returns {{id, title, items}[]}
 */
export function atspiToMenus(menubar, { provider = 'atspi' } = {}) {
    const menus = [];
    for (const m of menubar?.children ?? []) {
        const title = (m.name ?? '').trim();
        if (!title)
            continue;
        const items = tidy(atspiItems(m, provider, [title], 1));
        menus.push({ id: nativeMenuId(title), title, items });
    }
    return menus;
}

/**
 * The items of an open popover menu (a libadwaita primary menu), as one list.
 *
 * @returns {object[]}
 */
export function atspiPopoverItems(menu, { provider = 'atspi' } = {}) {
    return tidy(atspiItems(menu, provider, [], 1));
}

// ---- merging into Guava's menus -------------------------------------------------------------

const norm = s => stripMnemonic(s).replace(/[.…]+$/, '').trim().toLowerCase();

/**
 * Put a native menu bar in place of the generic menus: the app's own menus replace Guava's
 * File, Edit and View; Guava's App menu (bold name: About, Settings, Hide, Quit), Window and
 * Help stay. A native Window or Help menu adds its items to Guava's (Help after the search).
 *
 * @param {object[]} menus from buildMenus()
 * @param {{id, title, items}[]} menubar
 * @returns {object[]} a new list
 */
export function applyMenubar(menus, menubar = []) {
    if (!menubar.length)
        return menus;
    const keep = new Map(menus.filter(m => ['app', 'window', 'help'].includes(m.id)).map(m => [m.id, { ...m, items: [...m.items] }]));
    const out = [];
    if (keep.has('app'))
        out.push(keep.get('app'));
    for (const n of menubar) {
        if (n.id === 'app') {
            const app = keep.get('app');
            if (app)
                app.items = tidy([...dedupe(n.items, app.items), SEP, ...app.items]);
        } else if (n.id === 'window' && keep.has('window')) {
            const w = keep.get('window');
            w.items = tidy([...n.items, SEP, ...w.items]);
        } else if (n.id === 'help' && keep.has('help')) {
            const h = keep.get('help');
            const [search, ...rest] = h.items;
            h.items = tidy([search, SEP, ...dedupe(n.items, rest), SEP, ...rest]);
        } else {
            out.push({ id: n.id, title: n.title, items: tidy(n.items) });
        }
    }
    for (const id of ['window', 'help']) {
        if (keep.has(id))
            out.push(keep.get(id));
    }
    return out;
}

// Native items whose label an existing item already has are left out
function dedupe(items, existing) {
    const labels = new Set();
    const collect = list => {
        for (const it of list) {
            if (it.kind === 'item')
                labels.add(norm(it.label));
        }
    };
    collect(existing);
    return items.filter(it => it.kind !== 'item' || !labels.has(norm(it.label)));
}
