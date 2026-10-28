// Run: gjs -m tests/desktopIconsModel.test.js
import {
    Selection, bandRect, desktopInFront, blockedCells, cellAt, cellRect, dingEnabled, flowCell, flowOrder, gridFor, inGrid, isDoubleClick, isDrag,
    layoutCells, menuActions, metricsFor, moveCells, neighbour, parseArrangement, pruneArrangement,
    rubberBandHits, serializeArrangement, showsAsDrive, sortEntries, stemLength, typeAhead, uniqueName, validateName,
} from '../features/desktopIcons/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const AREA = { x: 0, y: 32, width: 1280, height: 768 };
const m = metricsFor(64, 1);
const grid = gridFor(AREA, m);
const entry = (name, extra = {}) => ({ key: name, name, kind: 'file', contentType: 'text/plain', kindLabel: 'Text', mtime: 0, ctime: 0, size: 0, ...extra });
const cellsOf = r => Object.fromEntries([...r.cells].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, c]) => [k, [c.col, c.row]]));

test('metrics: a 64 px icon gets a roomy cell, and everything scales', () => {
    eq([m.icon, m.cellW, m.margin], [64, 100, 12]);
    const big = metricsFor(64, 2);
    eq([big.icon, big.cellW, big.cellH], [128, 200, m.cellH * 2]);
    eq(metricsFor(32, 1).cellW, 80, 'a small icon keeps a cell wide enough for its label');
});

test('the grid hangs from the top right of the usable area', () => {
    eq(grid.right, 1280 - 12);
    eq(grid.top, 32 + 12);
    eq(grid.cols, Math.floor((1280 - 24) / 100));
    eq(grid.rows, Math.floor((768 - 24) / m.cellH));
    eq(cellRect({ col: 0, row: 0 }, grid), { x: 1268 - 100, y: 44, width: 100, height: m.cellH });
    eq(cellRect({ col: 1, row: 2 }, grid).x, 1268 - 200);
    eq(cellRect({ col: 1, row: 2 }, grid).y, 44 + 2 * m.cellH);
});

test('cellAt is the inverse of cellRect and clamps into the grid', () => {
    for (const cell of [{ col: 0, row: 0 }, { col: 3, row: 4 }, { col: grid.cols - 1, row: grid.rows - 1 }]) {
        const r = cellRect(cell, grid);
        eq(cellAt(r.x + 5, r.y + 5, grid), cell);
        eq(cellAt(r.x + r.width - 1, r.y + r.height - 1, grid), cell);
    }
    eq(cellAt(5000, -50, grid), { col: 0, row: 0 });
    eq(cellAt(-50, 5000, grid), { col: grid.cols - 1, row: grid.rows - 1 });
    eq(inGrid({ col: grid.cols, row: 0 }, grid), false);
    eq(inGrid({ col: 0, row: -1 }, grid), false);
});

test('the flow goes down the right-most column, then left', () => {
    eq(flowCell(0, grid), { col: 0, row: 0 });
    eq(flowCell(1, grid), { col: 0, row: 1 });
    eq(flowCell(grid.rows - 1, grid), { col: 0, row: grid.rows - 1 });
    eq(flowCell(grid.rows, grid), { col: 1, row: 0 });
});

test('ten new files fill the top-right column in name order', () => {
    const entries = ['d.txt', 'a.png', 'c', 'b.jpg', 'e', 'f', 'g', 'h', 'i', 'j'].map(n => entry(n));
    const r = layoutCells({ entries, stored: new Map(), grid, sort: 'none' });
    eq(cellsOf(r)['a.png'], [0, 0]);
    eq(cellsOf(r)['b.jpg'], [0, 1]);
    eq(cellsOf(r)['j'], [flowCell(9, grid).col, flowCell(9, grid).row], 'then on to the next column to the left');
    eq(r.assigned.size, 10, 'all got automatic cells, which the caller remembers');
    eq(new Set([...r.cells.values()].map(c => `${c.col},${c.row}`)).size, 10, 'no two share a cell');
});

test('a remembered cell is kept; a new file takes the first free cell', () => {
    const stored = new Map([['b', { col: 0, row: 0, user: true }]]);
    const r = layoutCells({ entries: [entry('a'), entry('b'), entry('c')], stored, grid, sort: 'none' });
    eq(cellsOf(r), { a: [0, 1], b: [0, 0], c: [0, 2] });
    eq([...r.assigned.keys()], ['a', 'c']);
});

test('two icons remembered in one cell: the first by name keeps it', () => {
    const stored = new Map([['a', { col: 0, row: 0, user: true }], ['b', { col: 0, row: 0, user: true }]]);
    const r = layoutCells({ entries: [entry('b'), entry('a')], stored, grid, sort: 'none' });
    eq(cellsOf(r), { a: [0, 0], b: [0, 1] });
});

test('a remembered cell outside a smaller grid is treated as new', () => {
    const stored = new Map([['a', { col: 99, row: 99, user: true }]]);
    const r = layoutCells({ entries: [entry('a')], stored, grid, sort: 'none' });
    eq(cellsOf(r), { a: [0, 0] });
});

test('automatic places move out from under a widget; places the user chose stay', () => {
    const rects = [cellRect({ col: 0, row: 0 }, grid)];
    const blocked = blockedCells(rects, grid);
    eq([...blocked], ['0,0']);
    const stored = new Map([['auto', { col: 0, row: 0, user: false }], ['mine', { col: 0, row: 0, user: true }]]);
    const r = layoutCells({ entries: [entry('auto'), entry('mine')], stored, grid, sort: 'none', blocked });
    eq(cellsOf(r).mine, [0, 0]);
    eq(cellsOf(r).auto, [0, 1]);
});

test('new icons skip blocked cells', () => {
    const blocked = new Set(['0,0', '0,1']);
    const r = layoutCells({ entries: [entry('a'), entry('b')], stored: new Map(), grid, sort: 'none', blocked });
    eq(cellsOf(r), { a: [0, 2], b: [0, 3] });
});

test('blockedCells covers every cell a rectangle touches, and none outside the grid', () => {
    const r = { x: grid.right - 2 * 100 + 10, y: grid.top + m.cellH + 5, width: 150, height: m.cellH };
    const cells = [...blockedCells([r], grid)].sort();
    eq(cells, ['0,1', '0,2', '1,1', '1,2']);
    eq(blockedCells([{ x: -500, y: -500, width: 10, height: 10 }], grid).size, 0);
    eq(blockedCells([{ x: 5000, y: 5000, width: 10, height: 10 }], grid).size, 0);
});

test('sorting arranges everything in order and ignores remembered cells', () => {
    const entries = [entry('b', { size: 5 }), entry('a', { size: 50 }), entry('c', { size: 1 })];
    const stored = new Map([['a', { col: 5, row: 5, user: true }]]);
    eq(cellsOf(layoutCells({ entries, stored, grid, sort: 'name' })), { a: [0, 0], b: [0, 1], c: [0, 2] });
    eq(cellsOf(layoutCells({ entries, stored, grid, sort: 'size' })), { a: [0, 0], b: [0, 1], c: [0, 2] });
    eq(layoutCells({ entries, stored, grid, sort: 'name' }).assigned.size, 0, 'a sort remembers nothing');
});

test('sort orders: name is natural, dates and size newest or largest first, kind groups', () => {
    const e = [
        entry('file10', { mtime: 1, ctime: 3, size: 10, kindLabel: 'B' }),
        entry('file2', { mtime: 3, ctime: 1, size: 30, kindLabel: 'A' }),
        entry('File1', { mtime: 2, ctime: 2, size: 20, kindLabel: 'B' }),
    ];
    const names = mode => sortEntries(e, mode).map(x => x.name);
    eq(names('name'), ['File1', 'file2', 'file10']);
    eq(names('date-modified'), ['file2', 'File1', 'file10']);
    eq(names('date-created'), ['file10', 'File1', 'file2']);
    eq(names('size'), ['file2', 'File1', 'file10']);
    eq(names('kind'), ['file2', 'File1', 'file10']);
    eq(names('unknown'), ['File1', 'file2', 'file10']);
});

test('drives come first in every order', () => {
    const entries = [entry('a'), entry('z', { kind: 'drive', key: 'drive:z' }), entry('b')];
    eq(sortEntries(entries, 'name').map(e => e.name), ['z', 'a', 'b']);
    const r = layoutCells({ entries, stored: new Map(), grid, sort: 'none' });
    eq(cellsOf(r)['drive:z'], [0, 0]);
});

test('dragging moves icons by a number of cells and avoids occupied ones', () => {
    const cells = new Map([['a', { col: 0, row: 0 }], ['b', { col: 0, row: 1 }], ['c', { col: 2, row: 2 }]]);
    eq([...moveCells(cells, ['a'], { col: 2, row: 3 }, grid)], [['a', { col: 2, row: 3 }]]);
    // a lands on c's cell: it takes the nearest free one
    const onto = moveCells(cells, ['a'], { col: 2, row: 2 }, grid).get('a');
    eq(inGrid(onto, grid) && !(onto.col === 2 && onto.row === 2), true);
    eq(Math.abs(onto.col - 2) + Math.abs(onto.row - 2), 1);
});

test('dragging a group keeps its shape and clamps at the grid edge', () => {
    const cells = new Map([['a', { col: 0, row: 0 }], ['b', { col: 0, row: 1 }]]);
    const r = moveCells(cells, ['a', 'b'], { col: 3, row: 2 }, grid);
    eq([r.get('a'), r.get('b')], [{ col: 3, row: 2 }, { col: 3, row: 3 }]);
    const far = moveCells(cells, ['a', 'b'], { col: -5, row: -5 }, grid);
    eq(inGrid(far.get('a'), grid) && inGrid(far.get('b'), grid), true);
    eq(far.get('a') !== far.get('b') && JSON.stringify(far.get('a')) !== JSON.stringify(far.get('b')), true, 'two icons never share a cell');
});

test('a full grid leaves a dragged icon where it was', () => {
    const tiny = { right: 100, top: 0, cellW: 100, cellH: 100, cols: 1, rows: 2 };
    const cells = new Map([['a', { col: 0, row: 0 }], ['b', { col: 0, row: 1 }]]);
    eq(moveCells(cells, ['a'], { col: 0, row: 1 }, tiny).get('a'), { col: 0, row: 0 });
});

test('the arrangement round-trips and drops malformed data', () => {
    const stored = new Map([['a.txt', { col: 1, row: 2, user: true }], ['b', { col: 0, row: 0, user: false }]]);
    const text = serializeArrangement(stored);
    eq([...parseArrangement(text)], [...stored]);
    eq(serializeArrangement(new Map()), '');
    eq(parseArrangement('').size, 0);
    eq(parseArrangement('{not json').size, 0);
    eq(parseArrangement('{"version":9,"cells":{"a":[0,0]}}').size, 0);
    eq([...parseArrangement('{"version":1,"cells":{"a":[0,0],"b":[-1,0],"c":"x","d":[1.5,0],"e":[2,3,1]}}').keys()], ['a', 'e']);
});

test('pruning forgets deleted files and keeps unmounted drives', () => {
    const stored = new Map([['gone', { col: 0, row: 0, user: true }], ['here', { col: 0, row: 1, user: true }],
        ['drive:USB', { col: 1, row: 0, user: true }]]);
    eq([...pruneArrangement(stored, [entry('here')]).keys()], ['here', 'drive:USB']);
});

test('selection: click, Ctrl toggles, Shift selects a range in flow order', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const s = new Selection();
    s.click('b', {}, order);
    eq([...s.keys], ['b']);
    s.click('d', { shift: true }, order);
    eq([...s.keys], ['b', 'c', 'd']);
    s.click('a', { ctrl: true }, order);
    eq([...s.keys].sort(), ['a', 'b', 'c', 'd']);
    s.click('b', { ctrl: true }, order);
    eq(s.has('b'), false);
    s.click('e', {}, order);
    eq([...s.keys], ['e']);
    s.click('b', { shift: true }, order);
    eq([...s.keys], ['b', 'c', 'd', 'e']);
    s.clear();
    eq([s.size, s.focus, s.anchor], [0, null, null]);
});

test('selection: a press on a selected icon keeps the group for a drag; a plain click collapses', () => {
    const order = ['a', 'b', 'c'];
    const s = new Selection();
    s.set(['a', 'b']);
    eq(s.press('b', {}, order), false);
    eq([...s.keys].sort(), ['a', 'b']);
    s.collapseTo('b');
    eq([...s.keys], ['b']);
    eq(s.press('c', {}, order), true);
    eq([...s.keys], ['c']);
});

test('selection: retain drops what no longer exists', () => {
    const s = new Selection();
    s.set(['a', 'b']);
    s.click('b', { ctrl: true }, []);
    s.set(['a', 'b']);
    s.retain(['a']);
    eq([...s.keys], ['a']);
    eq(s.focus, null);
});

test('the rubber band selects every icon it touches', () => {
    const rects = new Map([['a', { x: 0, y: 0, width: 10, height: 10 }], ['b', { x: 20, y: 0, width: 10, height: 10 }],
        ['c', { x: 0, y: 20, width: 10, height: 10 }]]);
    eq(rubberBandHits({ x: 5, y: 5, width: 20, height: 3 }, rects), ['a', 'b']);
    eq(rubberBandHits({ x: 100, y: 100, width: 5, height: 5 }, rects), []);
    eq(rubberBandHits({ x: 10, y: 0, width: 10, height: 10 }, rects), [], 'touching edges do not count');
    eq(bandRect(30, 40, 10, 5), { x: 10, y: 5, width: 20, height: 35 });
    eq(isDrag(5, 5), true);
    eq(isDrag(2, 2), false);
});

test('a double click is two presses on one icon, close in time and place', () => {
    const lim = { time: 400, distance: 5 };
    const a = { key: 'a', time: 1000, x: 10, y: 10 };
    eq(isDoubleClick(a, { key: 'a', time: 1300, x: 12, y: 9 }, lim), true);
    eq(isDoubleClick(a, { key: 'a', time: 1500, x: 10, y: 10 }, lim), false);
    eq(isDoubleClick(a, { key: 'b', time: 1100, x: 10, y: 10 }, lim), false);
    eq(isDoubleClick(a, { key: 'a', time: 1100, x: 30, y: 10 }, lim), false);
    eq(isDoubleClick(null, a, lim), false);
});

test('arrow keys move to the nearest icon that way', () => {
    // screen: col 1 is left of col 0
    const cells = new Map([['tr', { col: 0, row: 0 }], ['below', { col: 0, row: 1 }], ['left', { col: 1, row: 0 }],
        ['far', { col: 3, row: 4 }]]);
    eq(neighbour('tr', 'down', cells), 'below');
    eq(neighbour('tr', 'left', cells), 'left');
    eq(neighbour('tr', 'right', cells), null);
    eq(neighbour('tr', 'up', cells), null);
    eq(neighbour('below', 'up', cells), 'tr');
    eq(neighbour('left', 'right', cells), 'tr');
    eq(neighbour('below', 'left', cells), 'left', 'the nearest on the left, not the same row');
    eq(neighbour(null, 'down', cells), 'tr', 'with nothing selected the first of the flow');
    eq(neighbour('ghost', 'down', cells), 'tr');
    eq(neighbour('x', 'down', new Map()), null);
});

test('type to select jumps to the next name with that start, wrapping', () => {
    const ordered = [{ key: 'a', name: 'Alpha' }, { key: 'b', name: 'beta' }, { key: 'c', name: 'Bravo' }];
    eq(typeAhead('b', ordered), 'b');
    eq(typeAhead('b', ordered, 'b'), 'c');
    eq(typeAhead('b', ordered, 'c'), 'b');
    eq(typeAhead('zz', ordered), null);
    eq(typeAhead('', ordered), null);
});

test('flowOrder lists icons from the top right, down then left', () => {
    const cells = new Map([['c', { col: 1, row: 0 }], ['b', { col: 0, row: 1 }], ['a', { col: 0, row: 0 }]]);
    eq(flowOrder(cells, grid), ['a', 'b', 'c']);
});

test('rename: trims, refuses empty, slashes, dots, long and taken names', () => {
    const sib = ['a.txt', 'b.txt'];
    eq(validateName('  new.txt ', 'a.txt', sib), { ok: true, name: 'new.txt', changed: true });
    eq(validateName('a.txt', 'a.txt', sib), { ok: true, name: 'a.txt', changed: false });
    eq(validateName('   ', 'a.txt', sib).error, 'empty');
    eq(validateName('..', 'a.txt', sib).error, 'dots');
    eq(validateName('x/y', 'a.txt', sib).error, 'slash');
    eq(validateName('b.txt', 'a.txt', sib).error, 'exists');
    eq(validateName('é'.repeat(200), 'a.txt', sib).error, 'long');
});

test('new folder names count up like Finder', () => {
    eq(uniqueName('untitled folder', ['a']), 'untitled folder');
    eq(uniqueName('untitled folder', ['untitled folder']), 'untitled folder 2');
    eq(uniqueName('untitled folder', ['untitled folder', 'untitled folder 2']), 'untitled folder 3');
});

test('rename selects the name without its extension', () => {
    eq(stemLength('photo.jpg', false), 5);
    eq(stemLength('archive.tar.gz', false), 7);
    eq(stemLength('.bashrc', false), 7);
    eq(stemLength('Makefile', false), 8);
    eq(stemLength('my.folder', true), 9);
    eq(stemLength('notes.final.txt', false), 11);
});

test('menus: files offer Open, Show in Files, Rename, Move to Trash; drives Eject; the wallpaper New Folder and Sort By', () => {
    eq(menuActions([{ kind: 'file' }]), ['open', 'show-in-files', 'rename', '-', 'trash', '-', 'new-folder']);
    eq(menuActions([{ kind: 'file' }, { kind: 'folder' }]), ['open', 'show-in-files', '-', 'trash', '-', 'new-folder']);
    eq(menuActions([{ kind: 'drive' }]), ['open', 'show-in-files', '-', 'eject', '-', 'new-folder']);
    eq(menuActions([{ kind: 'drive' }, { kind: 'file' }]), ['open', 'show-in-files', '-', '-', 'new-folder']);
    eq(menuActions([]), ['new-folder', 'sort']);
});

test('drives: the system mounts are not shown', () => {
    eq(showsAsDrive({ rootPath: '/run/media/me/USB', isShadowed: false }), true);
    eq(showsAsDrive({ rootPath: '/', isShadowed: false }), false);
    eq(showsAsDrive({ rootPath: '/boot/efi', isShadowed: false }), false);
    eq(showsAsDrive({ rootPath: '/run/media/me/USB', isShadowed: true }), false);
    eq(showsAsDrive({ rootPath: null, isShadowed: false }), false);
    eq(showsAsDrive({ rootPath: '/bootcamp', isShadowed: false }), true);
});

test('the desktop is in front unless a normal window has the focus', () => {
    eq(desktopInFront(null), true);
    eq(desktopInFront({ type: 'normal', minimized: false }), false);
    eq(desktopInFront({ type: 'dialog', minimized: false }), false);
    eq(desktopInFront({ type: 'normal', minimized: true }), true);
    eq(desktopInFront({ type: 'dock', minimized: false }), true);
});

test('DING is found by uuid, unless extensions are switched off', () => {
    eq(dingEnabled(['guava-os@blueyzx64', 'ding@rastersoft.com']), true);
    eq(dingEnabled(['gtk4-ding@smedius.gitlab.com']), true);
    eq(dingEnabled(['guava-os@blueyzx64']), false);
    eq(dingEnabled(['ding@rastersoft.com'], true), false);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
