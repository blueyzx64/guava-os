// SPDX-License-Identifier: GPL-3.0-or-later
// The app menu model: what the menu bar shows for the focused app, as plain values.
//
// Providers (core/appMenus/service.js) report what an app offers; buildMenus() merges that
// with the generic menus every app gets:
//
//   App     About, Settings…, Hide, Hide Others, Show All, Quit
//   File    New Window, Close Window (+ what the app adds: New Tab, Open…, Save, Print…)
//   Edit    only when the app exports edit actions (Undo, Cut, Copy, Paste, Select All, Find)
//   View    only when the app exports view actions (zoom, reload, full screen)
//   Window  Minimize, Zoom, Full Screen, Tile Left/Right, Move to Workspace, Always on Top,
//           Bring All to Front, then the app's windows
//   Help    a search field over every item, the app's help and keyboard shortcuts
//
//   const menus = buildMenus({ appName, actions, generic, accels, _ });
//   // [{ id: 'app', title: 'Text Editor', items: [{ id, label, enabled, accel, command }] }]
//   searchMenus(menus, 'quit');        // [{ path: 'Text Editor', item }]
//   formatAccel('<Control>q', { glyphs: true });   // '⌃Q'
//
// A provider result is {actions: [{group: 'app'|'win', name, enabled, parameterized, state}]}
// (GTK actions, P1). P6 adds {menus: [...]} from exported GTK menu bars and DBusMenu; they
// merge by menu id through mergeNativeMenus().
//
// Commands are data: {provider: 'generic', name} runs in core/appMenus/commands.js;
// {provider: '<id>', group, name} goes back to the provider that reported the action.
//
// Pure JS (no gi imports): runs under `gjs -m` in tests.

/** Top-level menus, left to right. */
export const MENU_ORDER = Object.freeze(['app', 'file', 'edit', 'view', 'window', 'help']);

/**
 * Well-known GTK actions and the slot they fill. The first name an app exports wins.
 * `accel` is the GNOME HIG shortcut apps conventionally bind to it: org.gtk.Actions does not
 * say which keys an app uses, so the label shows the standard one.
 */
export const WELL_KNOWN = Object.freeze([
    { slot: 'about', names: ['app.about', 'win.about'] },
    { slot: 'settings', names: ['app.preferences', 'app.settings', 'win.preferences', 'win.show-preferences', 'app.show-preferences'], accel: '<Control>comma' },
    { slot: 'quit', names: ['app.quit'], accel: '<Control>q' },
    { slot: 'new-window', names: ['app.new-window', 'win.new-window'], accel: '<Control>n' },
    { slot: 'new-tab', names: ['win.new-tab', 'app.new-tab'], accel: '<Control>t' },
    { slot: 'open', names: ['win.open', 'app.open', 'win.open-file'], accel: '<Control>o' },
    { slot: 'save', names: ['win.save'], accel: '<Control>s' },
    { slot: 'save-as', names: ['win.save-as'], accel: '<Shift><Control>s' },
    { slot: 'print', names: ['win.print'], accel: '<Control>p' },
    { slot: 'close-window', names: ['win.close', 'win.close-window'], accel: '<Control>w' },
    { slot: 'undo', names: ['win.undo', 'app.undo'], accel: '<Control>z' },
    { slot: 'redo', names: ['win.redo', 'app.redo'], accel: '<Shift><Control>z' },
    { slot: 'cut', names: ['win.cut', 'app.cut'], accel: '<Control>x' },
    { slot: 'copy', names: ['win.copy', 'app.copy'], accel: '<Control>c' },
    { slot: 'paste', names: ['win.paste', 'app.paste'], accel: '<Control>v' },
    { slot: 'select-all', names: ['win.select-all', 'app.select-all'], accel: '<Control>a' },
    { slot: 'find', names: ['win.find', 'win.search', 'app.find'], accel: '<Control>f' },
    { slot: 'zoom-in', names: ['win.zoom-in', 'app.zoom-in'], accel: '<Control>plus' },
    { slot: 'zoom-out', names: ['win.zoom-out', 'app.zoom-out'], accel: '<Control>minus' },
    { slot: 'zoom-reset', names: ['win.zoom-reset', 'win.zoom-normal', 'win.zoom-default', 'app.zoom-reset'], accel: '<Control>0' },
    { slot: 'reload', names: ['win.reload', 'win.refresh'], accel: '<Control>r' },
    { slot: 'app-fullscreen', names: ['win.toggle-fullscreen', 'win.fullscreen'], accel: 'F11' },
    { slot: 'help', names: ['app.help', 'win.help'], accel: 'F1' },
    { slot: 'shortcuts', names: ['app.shortcuts', 'app.show-shortcuts', 'win.show-help-overlay', 'app.show-help-overlay'], accel: '<Control>question' },
]);

/** DescribeAll replies with more actions than this are not walked (gtkActions.js). */
export const MAX_DESCRIBE_ALL = 2000;

/**
 * The well-known action names of one group, without the group prefix: what an app with too
 * many actions is asked for, one by one.
 *
 * @param {'app'|'win'} group
 * @returns {string[]}
 */
export function wellKnownNames(group) {
    const out = new Set();
    for (const { names } of WELL_KNOWN) {
        for (const n of names) {
            if (n.startsWith(`${group}.`))
                out.add(n.slice(group.length + 1));
        }
    }
    return [...out];
}

// Generic commands every app gets: slot -> generic command name. A slot an app's action
// fills replaces the generic command (app.quit beats Shell.App.request_quit()).
const GENERIC = Object.freeze({
    'about': 'about',
    'settings': null,       // no generic way: shown disabled, as macOS does for apps without one
    'hide': 'hide',
    'hide-others': 'hide-others',
    'show-all': 'show-all',
    'quit': 'quit',
    'new-window': 'new-window',
    'close-window': 'close-window',
    'minimize': 'minimize',
    'zoom': 'zoom',
    'fullscreen': 'fullscreen',
    'tile-left': 'tile-left',
    'tile-right': 'tile-right',
    'always-on-top': 'always-on-top',
    'bring-all-to-front': 'bring-all-to-front',
});

// Window-manager shortcuts (org.gnome.desktop.wm.keybindings / org.gnome.mutter.keybindings)
// the adapter reads for these slots; the labels show what really works.
export const WM_ACCEL_SLOTS = Object.freeze({
    'minimize': ['wm', 'minimize'],
    'zoom': ['wm', 'toggle-maximized'],
    'fullscreen': ['wm', 'toggle-fullscreen'],
    'close-window': ['wm', 'close'],
    'always-on-top': ['wm', 'always-on-top'],
    'tile-left': ['mutter', 'toggle-tiled-left'],
    'tile-right': ['mutter', 'toggle-tiled-right'],
});

const SEP = Object.freeze({ kind: 'separator' });

/** @returns {Map<string, {action, accel}>} slot -> the app's action that fills it */
function slotsFromActions(actions = []) {
    const byName = new Map();
    for (const a of actions) {
        if (!a.parameterized)
            byName.set(`${a.group}.${a.name}`, a);
    }
    const out = new Map();
    for (const { slot, names, accel } of WELL_KNOWN) {
        for (const n of names) {
            const action = byName.get(n);
            if (action) {
                out.set(slot, { action, accel: accel ?? null });
                break;
            }
        }
    }
    return out;
}

function actionCommand(action) {
    return { provider: action.provider ?? 'gtk', group: action.group, name: action.name };
}

/**
 * The item for a slot: the app's action when it has one, else the generic command.
 *
 * @returns {?object} null when neither exists and `optional` is set
 */
function slotItem(slot, label, { filled, accels }, { optional = false, generic = true } = {}) {
    const hit = filled.get(slot);
    if (hit) {
        const state = hit.action.state;
        return {
            kind: 'item', id: slot, label,
            enabled: hit.action.enabled !== false,
            accel: hit.accel ?? accels[slot] ?? null,
            checked: typeof state === 'boolean' ? state : null,
            command: actionCommand(hit.action),
        };
    }
    if (optional)
        return null;
    const name = generic ? GENERIC[slot] ?? null : null;
    return {
        kind: 'item', id: slot, label,
        enabled: !!name,
        accel: accels[slot] ?? null,
        checked: null,
        command: name ? { provider: 'generic', name } : null,
    };
}

// Drop leading, trailing and doubled separators, and nulls
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

/**
 * Build the menus for one app.
 *
 * @param {object} p
 * @param {string} p.appName shown bold and in "About/Hide/Quit <app>"
 * @param {object[]} [p.actions] provider actions ({group, name, enabled, parameterized, state, provider?})
 * @param {object} [p.generic] what the Shell can do for this app:
 *   {canNewWindow, hasAbout, hasWindow, maximized, fullscreen, above,
 *    workspaces: {count, active, current}, windows: [{id, title, focused}]}
 * @param {object} [p.accels] slot -> accelerator string (wm shortcuts, Guava shortcuts)
 * @param {Function} p._ gettext
 * @returns {{id: string, title: string, items: object[]}[]}
 */
export function buildMenus({ appName, actions = [], generic = {}, accels = {}, _ }) {
    const filled = slotsFromActions(actions);
    const ctx = { filled, accels };
    const win = !!generic.hasWindow;
    // A replacer function: an app name with '$&' or '$1' is inserted as is
    const fmt = (s, v) => s.replace('%s', () => v);
    const item = (slot, label, opts) => slotItem(slot, label, ctx, opts);

    const about = item('about', fmt(_('About %s'), appName));
    if (!filled.has('about') && !generic.hasAbout)
        about.enabled = false;
    const newWindow = item('new-window', _('New Window'));
    if (!filled.has('new-window') && !generic.canNewWindow)
        newWindow.enabled = false;
    const closeWindow = item('close-window', _('Close Window'));
    if (!filled.has('close-window') && !win)
        closeWindow.enabled = false;

    const app = tidy([
        about, SEP,
        item('settings', _('Settings…')), SEP,
        item('hide', fmt(_('Hide %s'), appName)),
        item('hide-others', _('Hide Others')),
        item('show-all', _('Show All')), SEP,
        item('quit', fmt(_('Quit %s'), appName)),
    ]);

    const file = tidy([
        newWindow,
        item('new-tab', _('New Tab'), { optional: true }),
        item('open', _('Open…'), { optional: true }), SEP,
        closeWindow,
        item('save', _('Save'), { optional: true }),
        item('save-as', _('Save As…'), { optional: true }), SEP,
        item('print', _('Print…'), { optional: true }),
    ]);

    const edit = tidy([
        item('undo', _('Undo'), { optional: true }),
        item('redo', _('Redo'), { optional: true }), SEP,
        item('cut', _('Cut'), { optional: true }),
        item('copy', _('Copy'), { optional: true }),
        item('paste', _('Paste'), { optional: true }),
        item('select-all', _('Select All'), { optional: true }), SEP,
        item('find', _('Find…'), { optional: true }),
    ]);

    const view = tidy([
        item('zoom-in', _('Zoom In'), { optional: true }),
        item('zoom-out', _('Zoom Out'), { optional: true }),
        item('zoom-reset', _('Actual Size'), { optional: true }), SEP,
        item('reload', _('Reload'), { optional: true }),
        item('app-fullscreen', _('Toggle Full Screen'), { optional: true }),
    ]);

    const windowItems = [
        item('minimize', _('Minimize')),
        item('zoom', generic.maximized ? _('Unzoom') : _('Zoom')),
        item('fullscreen', generic.fullscreen ? _('Exit Full Screen') : _('Enter Full Screen')), SEP,
        item('tile-left', _('Tile Window to Left of Screen')),
        item('tile-right', _('Tile Window to Right of Screen')),
        workspaceSubmenu(generic.workspaces, _), SEP,
        { ...item('always-on-top', _('Always on Top')), checked: !!generic.above }, SEP,
        item('bring-all-to-front', _('Bring All to Front')),
    ];
    for (const it of windowItems) {
        if (it && it.kind === 'item' && it.id !== 'bring-all-to-front' && !win)
            it.enabled = false;
    }
    const windows = (generic.windows ?? []).map(w => ({
        kind: 'item', id: `window:${w.id}`, label: w.title || appName,
        enabled: true, accel: null, checked: !!w.focused,
        command: { provider: 'generic', name: 'activate-window', target: w.id },
    }));
    const windowMenu = tidy([...windowItems, SEP, ...windows]);

    const help = tidy([
        { kind: 'search', id: 'help-search', label: _('Search') }, SEP,
        item('help', fmt(_('%s Help'), appName), { optional: true }),
        item('shortcuts', _('Keyboard Shortcuts'), { optional: true }),
    ]);

    const menus = [
        { id: 'app', title: appName, items: app },
        { id: 'file', title: _('File'), items: file },
        { id: 'edit', title: _('Edit'), items: edit },
        { id: 'view', title: _('View'), items: view },
        { id: 'window', title: _('Window'), items: windowMenu },
        { id: 'help', title: _('Help'), items: help },
    ];
    // Edit and View appear only when the app provides something for them
    return menus.filter(m => m.items.some(i => i.kind === 'item') || m.id === 'help');
}

function workspaceSubmenu(ws, _) {
    const count = ws?.count ?? 1;
    const current = ws?.current ?? ws?.active ?? 0;
    const items = [];
    for (let i = 0; i < count; i++) {
        items.push({
            kind: 'item', id: `workspace:${i}`, label: _('Workspace %d').replace('%d', () => String(i + 1)),
            enabled: i !== current, accel: null, checked: i === current,
            command: { provider: 'generic', name: 'move-to-workspace', target: i },
        });
    }
    items.push(SEP, {
        kind: 'item', id: 'workspace:new', label: _('New Workspace'),
        enabled: true, accel: null, checked: null,
        command: { provider: 'generic', name: 'move-to-workspace', target: count },
    });
    return { kind: 'submenu', id: 'move-to-workspace', label: _('Move to Workspace'), enabled: true, items };
}

/**
 * Merge native menus (P6 providers: exported GTK menu bars, DBusMenu) into the built menus.
 * Native items go first in a menu of the same id; native menus with other ids are added
 * before Window. The generic App and Window items stay.
 *
 * @param {object[]} menus from buildMenus()
 * @param {{id: string, title: string, items: object[]}[]} native
 * @returns {object[]} a new list
 */
export function mergeNativeMenus(menus, native = []) {
    if (!native.length)
        return menus;
    const out = menus.map(m => ({ ...m, items: [...m.items] }));
    for (const n of native) {
        const hit = out.find(m => m.id === n.id);
        if (hit) {
            hit.items = tidy([...n.items, SEP, ...hit.items]);
        } else {
            const at = out.findIndex(m => m.id === 'window');
            out.splice(at < 0 ? out.length : at, 0, { id: n.id, title: n.title, items: tidy(n.items) });
        }
    }
    return out;
}

/**
 * Help search: every enabled item whose label holds the query (case-insensitive), with the
 * path of menus it lives in.
 *
 * @param {object[]} menus
 * @param {string} query
 * @param {number} [limit]
 * @returns {{path: string, item: object}[]}
 */
export function searchMenus(menus, query, limit = 8) {
    const q = (query ?? '').trim().toLowerCase();
    if (!q)
        return [];
    return menuEntries(menus).filter(e => e.item.label.toLowerCase().includes(q)).slice(0, limit);
}

/**
 * Every enabled item that runs a command, with the path of menus it lives in (Spotlight's
 * menu-item search ranks these itself).
 *
 * @param {object[]} menus
 * @returns {{path: string, item: object}[]}
 */
export function menuEntries(menus) {
    const out = [];
    const walk = (items, path) => {
        for (const it of items) {
            if (it.kind === 'submenu')
                walk(it.items, `${path} ▸ ${it.label}`);
            else if (it.kind === 'item' && it.enabled && it.command)
                out.push({ path, item: it });
        }
    };
    for (const m of menus)
        walk(m.items, m.title);
    return out;
}

// ---- shortcut labels -------------------------------------------------------------------------

const KEY_GLYPHS = Object.freeze({
    escape: '⎋', return: '↩', kp_enter: '⌤', tab: '⇥', backspace: '⌫', delete: '⌦',
    left: '←', right: '→', up: '↑', down: '↓', home: '↖', end: '↘',
    page_up: '⇞', page_down: '⇟', space: 'Space',
    comma: ',', period: '.', plus: '+', minus: '-', equal: '=', question: '?',
    slash: '/', backslash: '\\', grave: '`', semicolon: ';', apostrophe: "'",
    bracketleft: '[', bracketright: ']',
});

const KEY_WORDS = Object.freeze({
    escape: 'Esc', return: 'Enter', kp_enter: 'Enter', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', left: 'Left', right: 'Right', up: 'Up', down: 'Down', home: 'Home',
    end: 'End', page_up: 'Page Up', page_down: 'Page Down', space: 'Space',
});

/**
 * Parse a GTK accelerator ('<Super><Alt>Escape', '<Primary>q', '<Ctrl><Shift>z').
 *
 * @param {string} accel
 * @returns {?{ctrl: boolean, alt: boolean, shift: boolean, super: boolean, key: string}}
 */
export function parseAccel(accel) {
    if (!accel)
        return null;
    const mods = { ctrl: false, alt: false, shift: false, super: false };
    let rest = accel.trim();
    for (;;) {
        const m = /^<([^>]+)>/.exec(rest);
        if (!m)
            break;
        const mod = m[1].toLowerCase();
        if (mod === 'control' || mod === 'ctrl' || mod === 'primary')
            mods.ctrl = true;
        else if (mod === 'alt' || mod === 'mod1')
            mods.alt = true;
        else if (mod === 'shift')
            mods.shift = true;
        else if (mod === 'super' || mod === 'meta' || mod === 'mod4')
            mods.super = true;
        rest = rest.slice(m[0].length);
    }
    if (!rest)
        return null;
    return { ...mods, key: rest };
}

/**
 * A shortcut label, macOS-style (⌃⌥⇧⌘ then the key) or in words (Ctrl+Shift+Z).
 *
 * @param {string} accel GTK accelerator
 * @param {object} [opts]
 * @param {boolean} [opts.glyphs] true: ⌃ ⌥ ⇧ ⌘ glyphs, Super is ⌘
 * @param {boolean} [opts.ctrlIsCommand] the ⌘-position key sends Ctrl (xkb ctrl:swap_lwin_lctl):
 *   Ctrl shows as ⌘ and Super as ⌃
 * @returns {string} '' when the accelerator is empty or invalid
 */
export function formatAccel(accel, { glyphs = true, ctrlIsCommand = false } = {}) {
    const a = parseAccel(accel);
    if (!a)
        return '';
    const k = a.key.toLowerCase();
    let key;
    if (glyphs && KEY_GLYPHS[k])
        key = KEY_GLYPHS[k];
    else if (!glyphs && KEY_WORDS[k])
        key = KEY_WORDS[k];
    else if (!glyphs && KEY_GLYPHS[k] && KEY_GLYPHS[k].length === 1)
        key = KEY_GLYPHS[k];
    else
        key = a.key.length === 1 ? a.key.toUpperCase() : a.key;
    const ctrl = ctrlIsCommand ? a.super : a.ctrl;
    const cmd = ctrlIsCommand ? a.ctrl : a.super;
    if (glyphs)
        return `${ctrl ? '⌃' : ''}${a.alt ? '⌥' : ''}${a.shift ? '⇧' : ''}${cmd ? '⌘' : ''}${key}`;
    const parts = [];
    if (ctrl)
        parts.push('Ctrl');
    if (a.alt)
        parts.push('Alt');
    if (a.shift)
        parts.push('Shift');
    if (cmd)
        parts.push('Super');
    parts.push(key);
    return parts.join('+');
}

// ---- provider results ------------------------------------------------------------------------

/**
 * Parse an org.gtk.Actions DescribeAll reply (a{s(bgav)}, unpacked one level).
 *
 * @param {object} described name -> [enabled, parameterType, [state?]]
 * @param {'app'|'win'} group
 * @returns {{group, name, enabled, parameterized, state}[]} sorted by name
 */
export function parseDescribeAll(described, group) {
    const out = [];
    for (const [name, value] of Object.entries(described ?? {})) {
        const [enabled, paramType, state] = value;
        out.push({
            group, name,
            enabled: !!enabled,
            parameterized: !!paramType,
            state: Array.isArray(state) && state.length === 1 ? state[0] : null,
        });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
}

/**
 * Cache key of one window's menus: the window, and the app it belongs to (app actions are
 * shared by every window of an app).
 *
 * @param {{windowId: ?number, appId: ?string, gtk: ?{busName, appPath, windowPath}}} target
 */
export function cacheKeys(target) {
    const gtk = target?.gtk;
    return {
        app: gtk?.busName && gtk.appPath ? `${gtk.busName}${gtk.appPath}` : null,
        window: gtk?.busName && gtk.windowPath ? `${gtk.busName}${gtk.windowPath}` : null,
    };
}
