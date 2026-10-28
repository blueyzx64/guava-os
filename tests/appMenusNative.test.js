// Run: gjs -m tests/appMenusNative.test.js
import {
    GMenuStore, gmenuToMenus, dbusmenuToMenus, dbusmenuShortcut, dbusmenuSubmenuIds, stripMnemonic,
    nativeMenuId, applyMenubar, atspiToMenus, atspiPopoverItems, findPrimaryMenuButton, findRole,
    hasState, ROLE, STATE, MAX_ITEMS, atspiAccel, labelTarget, gmenuActionNames,
} from '../core/appMenus/nativeModel.js';
import { buildMenus, searchMenus, wellKnownNames, MAX_DESCRIBE_ALL } from '../core/appMenus/model.js';
import { xidFromDescription } from '../lib/compatModel.js';

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(a, b) {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const _ = s => s;
const labels = items => items.map(i => (i.kind === 'separator' ? '-' : i.label));

test('mnemonics and menu ids', () => {
    eq(stripMnemonic('_File'), 'File');
    eq(stripMnemonic('Save __as'), 'Save _as');
    eq(stripMnemonic('Fish & Chips'), 'Fish & Chips');
    eq(nativeMenuId('_Edit'), 'edit');
    eq(nativeMenuId('Help'), 'help');
    eq(nativeMenuId('Bookmarks'), 'native:bookmarks');
});

// A GTK menubar: File (sections, a submenu), View (a toggle and radios)
const actions = [
    { group: 'app', name: 'new', enabled: true, parameterized: false, state: null },
    { group: 'win', name: 'save', enabled: false, parameterized: false, state: null },
    { group: 'win', name: 'dark', enabled: true, parameterized: false, state: true },
    { group: 'win', name: 'size', enabled: true, parameterized: true, state: 'big' },
];
const rows = [
    [0, 0, [{ label: '_File', ':submenu': [0, 1] }, { label: '_View', ':submenu': [1, 0] }]],
    [0, 1, [{ ':section': [0, 2] }, { ':section': [0, 3], label: 'Export' }]],
    [0, 2, [{ label: '_New', action: 'app.new', accel: '<Control>n' }, { label: 'Save', action: 'win.save' },
        { label: 'Hidden', action: 'win.gone', 'hidden-when': 'action-missing' }]],
    [0, 3, [{ label: 'Recent', ':submenu': [0, 4] }]],
    [0, 4, [{ label: 'a.txt', action: 'app.widget-only' }]],
];
const more = [[1, 0, [{ label: 'Dark', action: 'win.dark' },
    { label: 'Big', action: 'win.size', target: 'big', 'target-type': 's' },
    { label: 'Small', action: 'win.size', target: 'small', 'target-type': 's' }]]];

test('GMenuStore: loads, finds linked groups, splices changes', () => {
    const s = new GMenuStore();
    s.load(rows);
    eq(s.missingGroups(), [1]);
    s.load(more);
    eq(s.missingGroups(), []);
    eq(s.change([[0, 2, 1, 1, [{ label: 'Save All', action: 'win.save' }]]]), true);
    eq(s.items(0, 2)[1].label, 'Save All');
    eq(s.change([[9, 9, 0, 0, []]]), false);
});

test('gmenuToMenus: submenus, sections, headings, accels, states', () => {
    const s = new GMenuStore();
    s.load(rows);
    s.load(more);
    const menus = gmenuToMenus(s, { actions });
    eq(menus.map(m => [m.id, m.title]), [['file', 'File'], ['view', 'View']]);
    const file = menus[0].items;
    eq(labels(file), ['New', 'Save', '-', 'Export', 'Recent']);
    eq(file[0].accel, '<Control>n');
    eq(file[0].command, { provider: 'gtk-menus', group: 'app', name: 'new', target: null, targetType: null });
    eq(file[1].enabled, false); // win.save is disabled
    eq(file[3].kind, 'heading');
    eq(file[4].items[0].enabled, false); // an action the app does not export over D-Bus
    const view = menus[1].items;
    eq(view.map(i => [i.checked, i.radio]), [[true, false], [true, true], [false, true]]);
    eq(view[2].command.target, 'small');
});

// DBusMenu layout as GetLayout unpacks it
const layout = [0, {}, [
    [1, { label: '_File', 'children-display': 'submenu' }, [
        [2, { label: '_Open…', shortcut: [['Control', 'O']] }, []],
        [3, { type: 'separator' }, []],
        [4, { label: 'Quit', enabled: false }, []],
        [5, { label: 'Ghost', visible: false }, []],
    ]],
    [6, { label: 'Settings', 'children-display': 'submenu' }, [
        [7, { label: 'Wrap', 'toggle-type': 'checkmark', 'toggle-state': 1 }, []],
        [8, { label: 'Tabs', 'toggle-type': 'radio', 'toggle-state': 0 }, []],
        [9, { label: 'More', 'children-display': 'submenu' }, [[10, { label: 'Deep', shortcut: [['Control', 'Shift', 'F5']] }, []]]],
    ]],
]];

test('dbusmenu: layout to menus', () => {
    const menus = dbusmenuToMenus(layout);
    eq(menus.map(m => m.id), ['file', 'native:settings']);
    eq(labels(menus[0].items), ['Open…', '-', 'Quit']);
    eq(menus[0].items[0].accel, '<Control>o');
    eq(menus[0].items[0].command, { provider: 'dbusmenu', id: 2 });
    eq(menus[0].items[2].enabled, false);
    const s = menus[1].items;
    eq([s[0].checked, s[0].radio, s[1].checked, s[1].radio], [true, false, false, true]);
    eq(s[2].kind, 'submenu');
    eq(s[2].items[0].accel, '<Control><Shift>F5');
    eq(dbusmenuSubmenuIds(layout), [1, 6]);
    eq(dbusmenuShortcut([]), null);
});

test('xid from Meta.Window descriptions', () => {
    eq(xidFromDescription('0x2a00004'), 0x2a00004);
    eq(xidFromDescription('0x1e00003 (Designer)'), 0x1e00003);
    eq(xidFromDescription('W12'), null);
    eq(xidFromDescription(null), null);
});

test('applyMenubar: native replaces File/Edit/View, keeps App, Window and Help', () => {
    const base = buildMenus({
        appName: 'Pad', _,
        actions: [{ group: 'win', name: 'copy', enabled: true, parameterized: false, state: null }],
        generic: { hasWindow: true },
    });
    eq(base.map(m => m.id), ['app', 'file', 'edit', 'window', 'help']);
    const native = [
        { id: 'file', title: 'File', items: [{ kind: 'item', id: 'n', label: 'Open', enabled: true, command: { provider: 'x' } }] },
        { id: 'native:tools', title: 'Tools', items: [{ kind: 'item', id: 't', label: 'Spell', enabled: true, command: { provider: 'x' } }] },
        { id: 'help', title: 'Help', items: [{ kind: 'item', id: 'h', label: 'About Pad', enabled: true, command: { provider: 'x' } },
            { kind: 'item', id: 'h2', label: 'Manual', enabled: true, command: { provider: 'x' } }] },
    ];
    const out = applyMenubar(base, native);
    eq(out.map(m => m.id), ['app', 'file', 'native:tools', 'window', 'help']);
    eq(labels(out[1].items), ['Open']);
    eq(out[4].items[0].kind, 'search');
    eq(labels(out[4].items).includes('Manual'), true);
    eq(applyMenubar(base, []), base);
    // Help search reaches native items, nested ones too
    eq(searchMenus(out, 'spell').map(h => h.path), ['Tools']);
});

test('applyMenubar: app items join the App menu without duplicates', () => {
    const base = buildMenus({ appName: 'Pad', _, generic: {} });
    const out = applyMenubar(base, [{ id: 'app', title: '', items: [
        { kind: 'item', id: 'a', label: 'About Pad', enabled: true, command: {} },
        { kind: 'item', id: 'b', label: 'New Window…', enabled: true, command: {} },
        { kind: 'item', id: 'c', label: 'Preferences', enabled: true, command: {} },
    ] }]);
    eq(out.map(m => m.id), ['app', 'window', 'help']);
    eq(labels(out[0].items).filter(l => l === 'About Pad').length, 1);
    eq(labels(out[0].items).slice(0, 2), ['New Window…', 'Preferences']);
});

// AT-SPI: a GTK 3 style menu bar and a libadwaita popover
const st = (...bits) => {
    const w = [0, 0];
    for (const b of bits)
        w[b >> 5] |= 1 << (b & 31);
    return w;
};
const frame = {
    role: ROLE.FRAME, name: 'Doc', states: st(STATE.ACTIVE), children: [
        { role: ROLE.MENU_BAR, name: '', children: [
            { role: ROLE.MENU, name: 'File', children: [
                { role: ROLE.POPUP_MENU, name: '', children: [
                    { role: ROLE.MENU_ITEM, name: 'Open', ref: '/o', states: st(STATE.SENSITIVE), children: [] },
                    { role: ROLE.SEPARATOR, name: '', children: [] },
                    { role: ROLE.CHECK_MENU_ITEM, name: 'Wrap', ref: '/w', states: st(STATE.SENSITIVE, STATE.CHECKED), children: [] },
                    { role: ROLE.MENU, name: 'Recent', children: [{ role: ROLE.MENU_ITEM, name: 'a.txt', ref: '/a', states: st(), children: [] }] },
                ] },
            ] },
        ] },
        { role: ROLE.PUSH_BUTTON, name: 'Main Menu', ref: '/outer', children: [
            { role: ROLE.TOGGLE_BUTTON, name: 'Main Menu', ref: '/btn', children: [] }] },
        { role: ROLE.TOGGLE_BUTTON, name: 'Menu', ref: '/doc', children: [] },
    ],
};

test('atspi: menu bar to menus', () => {
    const bar = findRole(frame, ROLE.MENU_BAR);
    const menus = atspiToMenus(bar);
    eq(menus.map(m => m.id), ['file']);
    const items = menus[0].items;
    eq(labels(items), ['Open', '-', 'Wrap', 'Recent']);
    eq(items[0].command, { provider: 'atspi', path: ['File', 'Open'], ref: '/o' });
    eq(items[2].checked, true);
    eq(items[3].kind, 'submenu');
    eq(items[3].items[0].enabled, false);
});

test('atspi: primary menu button and popover items', () => {
    eq(findPrimaryMenuButton(frame).ref, '/btn');
    eq([hasState(frame.states, STATE.ACTIVE), hasState(frame.states, STATE.CHECKED)], [true, false]);
    const pop = { role: ROLE.MENU, name: '', children: [
        { role: ROLE.MENU_ITEM, name: 'New Window', ref: '/1', states: st(STATE.SENSITIVE), children: [] },
        { role: ROLE.SEPARATOR, name: '', children: [] },
        { role: ROLE.MENU_ITEM, name: 'Keyboard Shortcuts', ref: '/2', states: st(STATE.SENSITIVE), children: [] },
    ] };
    const items = atspiPopoverItems(pop);
    eq(labels(items), ['New Window', '-', 'Keyboard Shortcuts']);
    eq(items[0].command.path, ['New Window']);
});

test('atspi: GTK 4 items take label from the label node and the shortcut from the key binding', () => {
    const pop = { role: ROLE.MENU, name: 'Main Menu', children: [
        { role: ROLE.MENU_ITEM, name: '', label: 'New Window', keyBinding: 'N;;Control+N', ref: '/1', states: st(STATE.SENSITIVE), children: [] },
        { role: ROLE.RADIO_MENU_ITEM, name: '', label: 'Basic', keyBinding: 'B;;', ref: '/2', states: st(STATE.SENSITIVE, STATE.CHECKED), children: [] },
    ] };
    const items = atspiPopoverItems(pop);
    eq(labels(items), ['New Window', 'Basic']);
    eq([items[0].accel, items[1].accel, items[1].checked, items[1].radio], ['<Control>n', null, true, true]);
    eq(atspiAccel('S;;Shift+Control+S'), '<Shift><Control>s');
    eq(atspiAccel('x;;Control+?'), '<Control>question');
    eq(atspiAccel('x;;F11'), 'F11');
    eq(labelTarget([[1, [[':1.2', '/a']]], [2, [[':1.2', '/b']]]]), [':1.2', '/b']);
    eq(labelTarget([]), null);
});

// Bounds (reviewer R3): huge exports never build unbounded menus
test('bounds: a huge GMenu or DBusMenu is cut at MAX_ITEMS', () => {
    const many = Array.from({ length: MAX_ITEMS + 500 }, (_v, i) => ({ label: `i${i}`, action: 'app.new' }));
    const s = new GMenuStore();
    s.load([[0, 0, [{ label: 'Big', ':submenu': [0, 1] }]], [0, 1, many]]);
    const menus = gmenuToMenus(s, { actions });
    eq(menus[0].items.length <= MAX_ITEMS, true);
    const node = [0, {}, [[1, { label: 'Big', 'children-display': 'submenu' },
        Array.from({ length: MAX_ITEMS + 500 }, (_v, i) => [i + 2, { label: `d${i}` }, []])]]];
    eq(dbusmenuToMenus(node)[0].items.length <= MAX_ITEMS, true);
});

test('gmenu: the actions menus name, and HIG accels for well-known ones', () => {
    const s = new GMenuStore();
    s.load([[0, 0, [{ label: 'File', ':submenu': [0, 1] }]],
        [0, 1, [{ label: 'Quit', action: 'app.quit' }, { label: 'Odd', action: 'win.odd' }]]]);
    eq(gmenuActionNames(s).sort(), ['app.quit', 'win.odd']);
    const acts = [{ group: 'app', name: 'quit', enabled: true, parameterized: false, state: null }];
    const menus = gmenuToMenus(s, { actions: acts, accels: new Map([['app.quit', '<Control>q']]) });
    eq(menus[0].items[0].accel, '<Control>q');
    eq(menus[0].items[1].accel, null);
});

test('well-known names per group (Describe fallback over MAX_DESCRIBE_ALL)', () => {
    eq(MAX_DESCRIBE_ALL > 100, true);
    const app = wellKnownNames('app');
    eq(app.includes('quit') && app.includes('about') && !app.includes('save'), true);
    eq(wellKnownNames('win').includes('undo'), true);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
