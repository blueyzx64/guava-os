// Run: gjs -m tests/appMenusModel.test.js
import {
    buildMenus, searchMenus, formatAccel, parseAccel, parseDescribeAll, mergeNativeMenus, cacheKeys,
} from '../core/appMenus/model.js';

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
const ids = menus => menus.map(m => m.id);
const item = (menus, menu, id) => menus.find(m => m.id === menu)?.items.find(i => i.id === id);

// Text Editor exports app.* only
const editor = parseDescribeAll({
    shortcuts: [true, '', []], about: [true, '', []], help: [true, '', []], quit: [true, '', []],
    'new-window': [true, '', []], 'remove-recent': [true, '(ss)', []], 'style-scheme': [true, 's', ['Adwaita']],
}, 'app');
// Calculator exports edit actions on the window
const calc = [...parseDescribeAll({ quit: [true, '', []], about: [true, '', []] }, 'app'),
    ...parseDescribeAll({ copy: [true, '', []], paste: [true, '', []], undo: [false, '', []], preferences: [true, '', []] }, 'win')];

test('parseDescribeAll keeps names, enabled, parameter and state', () => {
    const style = editor.find(a => a.name === 'style-scheme');
    eq([style.parameterized, style.state], [true, 'Adwaita']);
    eq(editor.find(a => a.name === 'about').enabled, true);
});

test('generic menus for an app with no actions', () => {
    const m = buildMenus({ appName: 'Foot', generic: { hasWindow: true, canNewWindow: true }, _ });
    eq(ids(m), ['app', 'file', 'window', 'help']);
    eq(m[0].title, 'Foot');
    eq(item(m, 'app', 'quit').command, { provider: 'generic', name: 'quit' });
    eq(item(m, 'app', 'settings').enabled, false);
    eq(item(m, 'app', 'about').enabled, false);
    eq(item(m, 'file', 'new-window').command.name, 'new-window');
});

test('app actions replace the generic commands (About and Quit really activate)', () => {
    const m = buildMenus({ appName: 'Text Editor', actions: editor, generic: { hasWindow: true }, _ });
    eq(item(m, 'app', 'about').command, { provider: 'gtk', group: 'app', name: 'about' });
    eq(item(m, 'app', 'quit').command, { provider: 'gtk', group: 'app', name: 'quit' });
    eq(item(m, 'app', 'quit').accel, '<Control>q');
    eq(item(m, 'file', 'new-window').command.name, 'new-window');
    eq(item(m, 'file', 'new-window').command.provider, 'gtk');
    eq(item(m, 'help', 'shortcuts').command.name, 'shortcuts');
    eq(item(m, 'help', 'help').label, 'Text Editor Help');
});

test('no Edit menu unless the app provides it; Calculator gets one', () => {
    eq(ids(buildMenus({ appName: 'Text Editor', actions: editor, _ })).includes('edit'), false);
    const m = buildMenus({ appName: 'Calculator', actions: calc, generic: { hasWindow: true }, _ });
    eq(ids(m), ['app', 'file', 'edit', 'window', 'help']);
    eq(item(m, 'edit', 'copy').command, { provider: 'gtk', group: 'win', name: 'copy' });
    eq(item(m, 'edit', 'undo').enabled, false);
    eq(item(m, 'app', 'settings').command.group, 'win');
});

test('parameterized actions are never mapped', () => {
    const acts = parseDescribeAll({ quit: [true, 's', []] }, 'app');
    eq(item(buildMenus({ appName: 'X', actions: acts, _ }), 'app', 'quit').command.provider, 'generic');
});

test('window items are disabled without a window, Bring All to Front stays', () => {
    const m = buildMenus({ appName: 'Files', generic: { hasWindow: false }, _ });
    eq(item(m, 'window', 'minimize').enabled, false);
    eq(item(m, 'window', 'bring-all-to-front').enabled, true);
    eq(item(m, 'file', 'close-window').enabled, false);
});

test('window menu lists workspaces and the app windows', () => {
    const m = buildMenus({
        appName: 'Files', _, generic: {
            hasWindow: true, maximized: true, above: true,
            workspaces: { count: 2, active: 0, current: 1 },
            windows: [{ id: 7, title: 'Home', focused: true }, { id: 9, title: '', focused: false }],
        },
    });
    const ws = item(m, 'window', 'move-to-workspace');
    eq(ws.items.map(i => i.label), ['Workspace 1', 'Workspace 2', undefined, 'New Workspace']);
    eq(ws.items[1].enabled, false);
    eq(ws.items[3].command, { provider: 'generic', name: 'move-to-workspace', target: 2 });
    eq(item(m, 'window', 'zoom').label, 'Unzoom');
    eq(item(m, 'window', 'always-on-top').checked, true);
    eq(item(m, 'window', 'window:7').checked, true);
    eq(item(m, 'window', 'window:9').label, 'Files');
});

test('wm accelerators label the generic items', () => {
    const m = buildMenus({ appName: 'X', generic: { hasWindow: true }, accels: { minimize: '<Super>h' }, _ });
    eq(item(m, 'window', 'minimize').accel, '<Super>h');
});

test('no doubled or trailing separators', () => {
    for (const menu of buildMenus({ appName: 'X', _ })) {
        const k = menu.items.map(i => i.kind);
        if (k[0] === 'separator' || k[k.length - 1] === 'separator' || k.join().includes('separator,separator'))
            throw new Error(`${menu.id}: ${k}`);
    }
});

test('help search finds enabled items with their path', () => {
    const m = buildMenus({ appName: 'Calculator', actions: calc, generic: { hasWindow: true, workspaces: { count: 1 } }, _ });
    eq(searchMenus(m, 'past').map(r => [r.path, r.item.label]), [['Edit', 'Paste']]);
    eq(searchMenus(m, 'undo'), []);                  // disabled
    eq(searchMenus(m, '   '), []);
    eq(searchMenus(m, 'workspace').map(r => r.path)[0], 'Window ▸ Move to Workspace');
    eq(searchMenus(m, 'e', 3).length, 3);
});

test('native menus merge by id and new ones go before Window', () => {
    const m = buildMenus({ appName: 'X', _ });
    const n = mergeNativeMenus(m, [
        { id: 'file', title: 'File', items: [{ kind: 'item', id: 'n1', label: 'Export', enabled: true }] },
        { id: 'go', title: 'Go', items: [{ kind: 'item', id: 'g', label: 'Back', enabled: true }] },
    ]);
    eq(ids(n), ['app', 'file', 'go', 'window', 'help']);
    eq(n[1].items[0].label, 'Export');
    eq(n[1].items[1].kind, 'separator');
    eq(mergeNativeMenus(m, []), m);
});

test('accelerators: glyphs, words, ⌘ for Super, swap', () => {
    eq(formatAccel('<Control>q'), '⌃Q');
    eq(formatAccel('<Super>h'), '⌘H');
    eq(formatAccel('<Super><Alt>Escape'), '⌥⌘⎋');
    eq(formatAccel('<Shift><Control>z'), '⌃⇧Z');
    eq(formatAccel('<Primary>comma'), '⌃,');
    eq(formatAccel('<Control>q', { ctrlIsCommand: true }), '⌘Q');
    eq(formatAccel('<Super>Left', { ctrlIsCommand: true }), '⌃←');
    eq(formatAccel('<Control><Shift>z', { glyphs: false }), 'Ctrl+Shift+Z');
    eq(formatAccel('<Super><Alt>Escape', { glyphs: false }), 'Alt+Super+Esc');
    eq(formatAccel('<Control>comma', { glyphs: false }), 'Ctrl+,');
    eq(formatAccel('F11'), 'F11');
    eq(formatAccel(''), '');
    eq(formatAccel('<Control>'), '');
    eq(parseAccel('<Mod4>x').super, true);
});

test('cache keys separate the app and the window', () => {
    eq(cacheKeys({ gtk: { busName: ':1.5', appPath: '/a', windowPath: '/a/window/1' } }),
        { app: ':1.5/a', window: ':1.5/a/window/1' });
    eq(cacheKeys({ gtk: null }), { app: null, window: null });
});

test('app names with $ patterns are shown as they are', () => {
    const m = buildMenus({ appName: 'Cash $& $1 $$', _, generic: {} });
    eq(m[0].items.find(i => i.id === 'quit').label, 'Quit Cash $& $1 $$');
});

if (failed)
    throw new Error(`${failed} failed`);
