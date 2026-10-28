// Run: gjs -m tests/launchpadModel.test.js
import { normalizeAccel } from '../lib/keybindingsModel.js';
import {
    COLUMNS, ROWS, addToFolder, buildItems, cleanFolderName, createFolder, dropAction, flatpakAppId,
    folderMembers, folderNameFor, freeAccels, gridMetrics, jiggleParams, layoutIndex, moveId, navigate, pageCount, pageOf,
    paginate, removeFromFolder, searchApps, serializeLayout, uninstallRule,
} from '../features/launchpad/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}
const ok = (v, msg) => {
    if (!v)
        throw new Error(msg ?? 'expected true');
};

const app = (id, name, categories = []) => ({ id, name, categories });
const APPS = [
    app('files.desktop', 'Files', ['System', 'FileManager']),
    app('calc.desktop', 'Calculator', ['Utility']),
    app('text.desktop', 'Text Editor', ['Utility', 'TextEditor']),
    app('music.desktop', 'Rhythmbox', ['Audio']),
    app('term.desktop', 'Terminal', ['System']),
];

test('gridMetrics: 7x5 on a 1280x800 display, centred', () => {
    const m = gridMetrics({ width: 1280, height: 800 });
    eq([m.columns, m.rows, m.perPage], [COLUMNS, ROWS, 35]);
    ok(m.icon >= 48 && m.icon <= 96, `icon ${m.icon}`);
    eq(m.left * 2 + m.gridWidth, 1280);
    ok(m.top + m.gridHeight < m.dotsTop + 1, 'grid above the dots');
});

test('gridMetrics: small screens get fewer columns, never below 3x2', () => {
    const m = gridMetrics({ width: 480, height: 360 });
    ok(m.columns >= 3 && m.columns < COLUMNS, `columns ${m.columns}`);
    ok(m.rows >= 2, `rows ${m.rows}`);
    ok(m.icon >= 40);
});

test('folderMembers: apps, then categories, minus excluded, installed only', () => {
    const f = { apps: ['term.desktop', 'gone.desktop'], categories: ['Utility'], excluded: ['calc.desktop'] };
    eq(folderMembers(f, APPS), ['term.desktop', 'text.desktop']);
});

test('buildItems: folders hide their apps; empty folders are skipped; layout order', () => {
    const folders = [
        { id: 'Utilities', name: 'Utilities', apps: ['calc.desktop', 'text.desktop'] },
        { id: 'Empty', name: 'Empty', apps: ['gone.desktop'] },
    ];
    const layout = [{ 'music.desktop': { position: 0 }, Utilities: { position: 1 } }, { 'files.desktop': { position: 0 } }];
    const items = buildItems(APPS, folders, layout);
    eq(items.map(i => i.id), ['music.desktop', 'Utilities', 'files.desktop', 'term.desktop']);
    eq(items[1].apps, ['calc.desktop', 'text.desktop']);
    eq(items[1].kind, 'folder');
});

test('buildItems: unknown items follow the known ones, by name', () => {
    const items = buildItems(APPS, [], [{ 'term.desktop': { position: 0 } }]);
    eq(items.map(i => i.name), ['Terminal', 'Calculator', 'Files', 'Rhythmbox', 'Text Editor']);
});

test('layoutIndex: the first page wins for duplicates', () => {
    const idx = layoutIndex([{ a: { position: 3 } }, { a: { position: 0 }, b: { position: 1 } }]);
    eq(idx.get('a'), [0, 3]);
    eq(idx.get('b'), [1, 1]);
});

test('paging helpers', () => {
    eq(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    eq(paginate([], 4), [[]]);
    eq(pageCount(0, 35), 1);
    eq(pageCount(36, 35), 2);
    eq(pageOf(35, 35), 1);
});

test('serializeLayout: positions restart on every page', () => {
    eq(serializeLayout(['a', 'b', 'c'], 2), [{ a: { position: 0 }, b: { position: 1 } }, { c: { position: 0 } }]);
});

test('moveId: forwards, backwards, clamped, unknown', () => {
    eq(moveId(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
    eq(moveId(['a', 'b', 'c', 'd'], 'd', 0), ['d', 'a', 'b', 'c']);
    eq(moveId(['a', 'b'], 'a', 99), ['b', 'a']);
    eq(moveId(['a', 'b'], 'x', 0), ['a', 'b']);
});

test('createFolder: takes the target place, target first', () => {
    const r = createFolder(['a', 'b', 'c', 'd'], 'd', 'b', 'F');
    eq(r.order, ['a', 'F', 'c']);
    eq(r.folder, { id: 'F', apps: ['b', 'd'] });
    eq(createFolder(['a'], 'a', 'a', 'F'), null);
    eq(createFolder(['a'], 'x', 'y', 'F'), null);
});

test('addToFolder: leaves the top level, un-excluded', () => {
    const r = addToFolder(['a', 'F', 'c'], { apps: ['x'], excluded: ['c'] }, 'c');
    eq(r, { order: ['a', 'F'], apps: ['x', 'c'], excluded: [] });
});

test('removeFromFolder: lands after the folder; categories folders exclude it', () => {
    const f = { id: 'F', apps: ['x', 'y'], categories: ['Utility'], excluded: [] };
    const r = removeFromFolder(['a', 'F', 'b'], f, ['x', 'y'], 'x');
    eq(r, { order: ['a', 'F', 'x', 'b'], apps: ['y'], excluded: ['x'], empty: false });
});

test('removeFromFolder: the last app removes the folder; a drop index is honoured', () => {
    const f = { id: 'F', apps: ['x'], categories: [], excluded: [] };
    const r = removeFromFolder(['a', 'F', 'b'], f, ['x'], 'x', 0);
    eq(r, { order: ['x', 'a', 'b'], apps: [], excluded: [], empty: true });
});

test('cleanFolderName', () => {
    eq(cleanFolderName('  My   Games \n'), 'My Games');
    eq(cleanFolderName('   '), null);
    eq(cleanFolderName('x'.repeat(80)).length, 64);
});

test('dropAction: centre of an app makes a folder, of a folder adds to it, edges move', () => {
    const cell = { width: 100, height: 100 };
    eq(dropAction({ dragKind: 'app', targetKind: 'app', slot: 3, offset: { x: 50, y: 52 }, cell, count: 9 }),
        { action: 'folder', index: 3 });
    eq(dropAction({ dragKind: 'app', targetKind: 'folder', slot: 3, offset: { x: 40, y: 60 }, cell, count: 9 }),
        { action: 'into', index: 3 });
    eq(dropAction({ dragKind: 'app', targetKind: 'app', slot: 3, offset: { x: 5, y: 50 }, cell, count: 9 }),
        { action: 'move', index: 3 });
    // Folders never nest
    eq(dropAction({ dragKind: 'folder', targetKind: 'app', slot: 2, offset: { x: 50, y: 50 }, cell, count: 9 }),
        { action: 'move', index: 2 });
    eq(dropAction({ dragKind: 'app', targetKind: null, slot: 40, offset: { x: 50, y: 50 }, cell, count: 9 }),
        { action: 'move', index: 8 });
});

test('navigate: arrows within a page, Left/Right across pages', () => {
    const g = { columns: 7, perPage: 35, count: 40 };
    eq(navigate(-1, 'right', g), 0);
    eq(navigate(0, 'left', g), 0);
    eq(navigate(34, 'right', g), 35);
    eq(navigate(35, 'left', g), 34);
    eq(navigate(8, 'up', g), 1);
    eq(navigate(1, 'up', g), 1);
    eq(navigate(1, 'down', g), 8);
    eq(navigate(30, 'down', g), 30);       // last row of page 1
    eq(navigate(3, 'pagedown', g), 38);
    eq(navigate(10, 'pagedown', g), 39);   // clamped to the last icon
    eq(navigate(38, 'pageup', g), 3);
    eq(navigate(5, 'end', g), 39);
    eq(navigate(5, 'home', g), 0);
    eq(navigate(0, 'down', { columns: 7, perPage: 35, count: 0 }), -1);
});

test('navigate: Down to a short last row goes to its last icon', () => {
    const g = { columns: 4, perPage: 12, count: 6 };
    eq(navigate(3, 'down', g), 5);
    eq(navigate(5, 'down', g), 5);
});

test('searchApps: prefix, word prefix, substring, keywords; accents folded', () => {
    const apps = [
        { id: 'a', name: 'Text Editor' },
        { id: 'b', name: 'Terminal' },
        { id: 'c', name: 'Contexte' },
        { id: 'd', name: 'Notes', keywords: ['textpad'] },
        { id: 'e', name: 'Écran' },
    ];
    eq(searchApps('te', apps), ['b', 'a', 'c', 'd']);
    eq(searchApps('edit', apps), ['a']);
    eq(searchApps('textp', apps), ['d']);
    eq(searchApps('ecr', apps), ['e']);
    eq(searchApps('  ', apps), []);
});

test('flatpakAppId: X-Flatpak first, then the export path', () => {
    eq(flatpakAppId({ desktopId: 'org.x.App.desktop', path: '/usr/share/applications/org.x.App.desktop', xFlatpak: 'org.x.App' }), 'org.x.App');
    eq(flatpakAppId({ desktopId: 'org.x.App.desktop', path: '/var/lib/flatpak/exports/share/applications/org.x.App.desktop', xFlatpak: null }), 'org.x.App');
    eq(flatpakAppId({ desktopId: 'org.x.App.desktop', path: '/home/u/.local/share/flatpak/exports/share/applications/org.x.App.desktop' }), 'org.x.App');
    eq(flatpakAppId({ desktopId: 'nautilus.desktop', path: '/usr/share/applications/nautilus.desktop', xFlatpak: '' }), null);
});

test('uninstallRule: Flatpak apps only, else nothing', () => {
    const caps = { software: true };
    eq(uninstallRule({ desktopId: 'c.desktop', flatpakId: 'org.c' }, caps), { backend: 'flatpak', appId: 'org.c' });
    eq(uninstallRule({ desktopId: 'files.desktop', flatpakId: null }, caps), null);
});

test('uninstallRule: an absent back end offers nothing', () => {
    eq(uninstallRule({ desktopId: 'c.desktop', flatpakId: 'org.c' }, { software: false }), null);
});

test('jiggleParams: neighbours differ, deterministic', () => {
    const a = jiggleParams(0), b = jiggleParams(1);
    ok(Math.sign(a.angle) !== Math.sign(b.angle));
    eq(jiggleParams(5), jiggleParams(5));
    ok(Math.abs(a.angle) < 3 && a.periodMs >= 260 && a.periodMs < 320);
});

test('folderNameFor: shared category first, else the most common, else null', () => {
    eq(folderNameFor([['Utility', 'GTK'], ['Utility', 'TextEditor']]), 'Utilities');
    eq(folderNameFor([['Game'], ['Game', 'Network'], ['Network']]), 'Games');
    eq(folderNameFor([['GTK'], []]), null);
});

test('freeAccels: only Launchpad accelerators leave the app grid', () => {
    eq(freeAccels(['<Super>a', '<Super><Shift>x'], ['<super>A', 'F4'], normalizeAccel), ['<Super><Shift>x']);
    eq(freeAccels(['<Super>a'], [], normalizeAccel), ['<Super>a']);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
