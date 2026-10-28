// Run: gjs -m tests/widgetsModel.test.js
import {
    SIZES, SIZE_ORDER, SIZE_PX, CELL, GAP, DEFAULT_WIDGETS, ProviderPool, WidgetRegistry, Emitter, gridFor, rectOf, snap, fits,
    collides, nearestFree, findSlot, addItem, removeItem, moveItem, resizeItem, setConfig, fitItems,
    parseLayout, serializeLayout, monitorKey, stepSize, sizeUnits, newId,
} from '../core/widgets/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const AREA = { x: 0, y: 32, width: 1440, height: 928 };
const grid = gridFor(AREA, 1);
const spec = (kind, size) => ({ kind, size, monitor: 'm0' });

test('size classes follow Sonoma', () => {
    eq(SIZE_ORDER, ['small', 'medium', 'large', 'extraLarge']);
    eq(SIZES.small, { cols: 1, rows: 1 });
    eq(SIZES.extraLarge, { cols: 4, rows: 2 });
    eq(sizeUnits('large'), { w: 4, h: 4 });
    eq(stepSize('medium', ['small', 'medium', 'large'], 1), 'large');
    eq(stepSize('large', ['small', 'medium', 'large'], 1), null);
    eq(stepSize('small', ['small', 'medium'], -1), null);
});

test('the grid hangs from the top right and counts cells', () => {
    // 1440 wide: floor((1440 - 40 + 24) / 194) = 7 cells; 928 high: floor((928 - 40 + 24) / 194) = 4
    eq(grid.units, { w: 14, h: 8 });
    eq(grid.y, 52);
    eq(grid.x + 7 * 194 - 24, 1440 - 20);
    const r = rectOf({ x: 0, y: 0, size: 'medium' }, grid);
    eq([r.width, r.height], [364, 170]);
});

test('sizes are the macOS ones: 170, 364 x 170, 364 x 382, 715 x 382', () => {
    eq([SIZE_PX.small, SIZE_PX.medium, SIZE_PX.large, SIZE_PX.extraLarge].map(s => [s.width, s.height]),
        [[170, 170], [364, 170], [364, 382], [715, 382]]);
    eq(2 * CELL + GAP, SIZE_PX.medium.width, 'a medium is two smalls and the gap');
    const edge = grid.x + grid.units.w * grid.unit - GAP;
    const big = rectOf({ x: 6, y: 2, size: 'extraLarge' }, grid);
    eq([big.width, big.height], [715, 382]);
    eq(big.x + big.width, edge, 'an extra-large card sits against the right edge of its footprint');
    const large = rectOf({ x: 10, y: 0, size: 'large' }, grid);
    eq(large.x + large.width, edge);
    const scaled = rectOf({ x: 0, y: 0, size: 'small' }, gridFor(AREA, 2));
    eq([scaled.width, scaled.height], [340, 340]);
});

test('the grid scales with the UI scale and always has one cell', () => {
    const g2 = gridFor({ x: 0, y: 0, width: 2560, height: 1440 }, 2);
    eq(g2.cell, 340);
    const tiny = gridFor({ x: 0, y: 0, width: 50, height: 50 }, 1);
    eq(tiny.units, { w: 2, h: 2 });
});

test('snapping rounds to whole cells, Ctrl loosens it to half cells, and clamps', () => {
    const near = snap(grid.x + 3 * grid.unit + 5, grid.y + 2 * grid.unit + 7, 'small', grid);
    eq(near, { x: 4, y: 2 });
    const loose = snap(grid.x + 3 * grid.unit - 5, grid.y + 2 * grid.unit + 7, 'small', grid, { loose: true });
    eq(loose, { x: 3, y: 2 });
    eq(snap(-500, -500, 'small', grid), { x: 0, y: 0 });
    // a large widget cannot hang over the right edge
    eq(snap(5000, 5000, 'large', grid), { x: 10, y: 4 });
    eq(fits(10, 4, 'large', grid), true);
    eq(fits(12, 4, 'large', grid), false);
});

test('overlap and the nearest free place', () => {
    const items = [{ id: 'a', x: 0, y: 0, size: 'large' }];
    eq(collides(2, 2, 'small', items), true);
    eq(collides(4, 0, 'small', items), false);
    eq(collides(2, 2, 'small', items, 'a'), false);
    eq(nearestFree(0, 0, 'small', items, grid), { x: 4, y: 0 });
    eq(nearestFree(0, 0, 'small', items, grid, { self: 'a' }), { x: 0, y: 0 });
    const full = [{ id: 'f', x: 0, y: 0, size: 'extraLarge' }];
    eq(nearestFree(0, 0, 'extraLarge', [{ id: 'g', x: 0, y: 0, size: 'extraLarge' }], { units: { w: 4, h: 2 } }), null);
    eq(full.length, 1);
});

test('new widgets fill from the top right, down the column, then left', () => {
    let items = [];
    const placed = [];
    for (let i = 0; i < 5; i++) {
        const r = addItem(items, { ...spec('clock', 'small'), id: `c${i}` }, grid);
        items = r.items;
        placed.push([r.item.x, r.item.y]);
    }
    eq(placed, [[12, 0], [12, 2], [12, 4], [12, 6], [10, 0]]);
    eq(findSlot('large', items, grid), { x: 8, y: 2 });
});

test('a full grid refuses a widget without changing anything', () => {
    const small = gridFor({ x: 0, y: 0, width: 200, height: 200 }, 1);
    const one = addItem([], { ...spec('clock', 'small'), id: 'a' }, small);
    const two = addItem(one.items, { ...spec('clock', 'small'), id: 'b' }, small);
    eq(two.item, null);
    eq(two.items, one.items);
});

test('items of other monitors do not block a grid', () => {
    const a = addItem([], { ...spec('clock', 'small'), id: 'a' }, grid);
    const b = addItem(a.items, { kind: 'clock', size: 'small', monitor: 'm1', id: 'b' }, grid);
    eq([b.item.x, b.item.y], [12, 0]);
});

test('moving snaps, rejects overlap by taking the nearest free place', () => {
    let items = addItem([], { ...spec('clock', 'small'), id: 'a' }, grid).items;
    items = addItem(items, { ...spec('clock', 'small'), id: 'b' }, grid).items; // 12,2
    const moved = moveItem(items, 'a', grid.x + 8 * grid.unit, grid.y + 4 * grid.unit, grid);
    eq(moved.find(i => i.id === 'a'), { id: 'a', kind: 'clock', size: 'small', config: {}, monitor: 'm0', x: 8, y: 4 });
    const onB = moveItem(items, 'a', grid.x + 12 * grid.unit, grid.y + 2 * grid.unit, grid).find(i => i.id === 'a');
    eq(collides(onB.x, onB.y, 'small', items, 'a'), false);
    eq(moveItem(items, 'nope', 0, 0, grid), null);
});

test('resize keeps the corner, or moves to free room, or is refused', () => {
    const items = addItem([], { ...spec('weather', 'small'), id: 'a' }, grid).items; // 12,0
    let r = resizeItem(items, 'a', 'medium', grid);
    eq(r.find(i => i.id === 'a').x, 12 - 2 + 0 === 10 ? 10 : -1); // medium is 4 units wide: 10
    r = resizeItem(items, 'a', 'large', grid);
    eq([r[0].x, r[0].y, r[0].size], [10, 0, 'large']);
    eq(resizeItem(items, 'a', 'extraLarge', grid, ['small', 'medium']), null);
    eq(resizeItem(items, 'a', 'huge', grid), null);
});

test('config merges and removal works', () => {
    let items = addItem([], { ...spec('clock', 'small'), id: 'a', config: { analog: false } }, grid).items;
    items = setConfig(items, 'a', { analog: true, city: 'Oslo' });
    eq(items[0].config, { analog: true, city: 'Oslo' });
    eq(removeItem(items, 'a'), []);
});

test('a layout survives a round trip and an empty one is an empty string', () => {
    let items = addItem([], { ...spec('clock', 'small'), id: 'a' }, grid).items;
    items = addItem(items, { ...spec('now-playing', 'medium'), id: 'b' }, grid).items;
    const text = serializeLayout(items);
    eq(parseLayout(text), items);
    eq(serializeLayout([]), '');
    eq(parseLayout(''), []);
});

test('parsing drops what is malformed and keeps the rest', () => {
    const good = { id: 'a', kind: 'clock', size: 'small', monitor: 'm0', x: 0, y: 0, config: {} };
    const bad = [
        'not json', '{}', '[]', 'null', JSON.stringify({ version: 2, items: [good] }),
        JSON.stringify({ version: 1, items: 'x' }),
    ];
    for (const b of bad)
        eq(parseLayout(b), [], b);
    const text = JSON.stringify({
        version: 1,
        items: [good, good, null, 4, { ...good, id: 'b', size: 'huge' }, { ...good, id: 'c', x: -1 },
            { ...good, id: 'd', x: 1.5 }, { ...good, id: 'e', kind: 'gone' }, { ...good, id: 'f', monitor: 7 },
            { ...good, id: 'g', config: [1] }, { ...good, id: '' }],
    });
    const out = parseLayout(text, k => k !== 'gone');
    eq(out.map(i => i.id), ['a', 'g']);
    eq(out[1].config, {});
});

test('a resolution change keeps what fits and moves what does not', () => {
    const items = [
        { id: 'a', kind: 'clock', size: 'small', monitor: 'm0', x: 12, y: 0, config: {} },
        { id: 'b', kind: 'clock', size: 'small', monitor: 'm0', x: 12, y: 2, config: {} },
        { id: 'c', kind: 'clock', size: 'small', monitor: 'm0', x: 12, y: 2, config: {} }, // on top of b
    ];
    const smaller = gridFor({ x: 0, y: 0, width: 600, height: 500 }, 1);
    const out = fitItems(items, smaller);
    eq(out.length, 3);
    for (const i of out)
        eq(fits(i.x, i.y, i.size, smaller), true, i.id);
    const set = new Set(out.map(i => `${i.x},${i.y}`));
    eq(set.size, 3);
    const tiny = gridFor({ x: 0, y: 0, width: 200, height: 200 }, 1);
    eq(fitItems(items, tiny).length, 1);
});

test('monitor keys name connector, vendor, product and serial', () => {
    eq(monitorKey({ connector: 'DP-1', vendor: 'DEL', product: 'U2720Q', serial: 'ABC' }), 'DP-1|DEL|U2720Q|ABC');
    eq(monitorKey({ connector: 'Meta-0' }), 'Meta-0|-|-|-');
});

test('ids do not repeat', () => {
    const items = [];
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
        const id = newId(items, 'clock');
        ids.add(id);
        items.push({ id });
    }
    eq(ids.size, 50);
});

function fakeProvider(log, name) {
    return {
        start() { log.push(`start ${name}`); },
        stop() { log.push(`stop ${name}`); },
        snapshot() { return 1; },
        onChange() { return () => {}; },
    };
}

test('a provider starts with the first user and stops with the last', () => {
    const log = [];
    const pool = new ProviderPool({ weather: () => fakeProvider(log, 'weather'), media: () => fakeProvider(log, 'media') });
    const a = pool.acquire('weather');
    const b = pool.acquire('weather');
    eq(log, ['start weather']);
    eq(pool.active(), ['weather']);
    a.release();
    a.release(); // idempotent: must not drop b's reference
    eq(log, ['start weather']);
    b.release();
    eq(log, ['start weather', 'stop weather']);
    eq(pool.active(), []);
    const c = pool.acquire('weather');
    eq(log.length, 3);
    c.release();
});

test('stopAll stops everything and a late release is harmless', () => {
    const log = [];
    const pool = new ProviderPool({ a: () => fakeProvider(log, 'a'), b: () => fakeProvider(log, 'b') });
    const ha = pool.acquire('a');
    pool.acquire('b');
    pool.stopAll();
    eq(log, ['start a', 'start b', 'stop a', 'stop b']);
    ha.release();
    eq(log.length, 4);
    eq(pool.active(), []);
});

test('a provider that fails to start is not kept, and unknown ids throw', () => {
    let n = 0;
    const pool = new ProviderPool({ bad: () => ({ start() { n++; throw new Error('no'); }, stop() {} }) });
    for (let i = 0; i < 2; i++) {
        try { pool.acquire('bad'); } catch (_e) { /* expected */ }
    }
    eq(n, 2);
    eq(pool.active(), []);
    let threw = false;
    try { pool.acquire('x'); } catch (_e) { threw = true; }
    eq(threw, true);
});

test('the emitter survives a failing listener', () => {
    const e = new Emitter();
    const got = [];
    e.connect(() => { throw new Error('x'); });
    const off = e.connect(v => got.push(v));
    e.emit(1);
    off();
    e.emit(2);
    eq(got, [1]);
    eq(e.size, 1);
});

test('the registry searches by title and category and limits sizes per surface', () => {
    const reg = new WidgetRegistry();
    reg.register({ id: 'clock', title: 'Clock', category: 'Clock', sizes: ['small', 'medium', 'large'], defaultSize: 'small' });
    reg.register({ id: 'cal', title: 'Calendar', category: 'Calendar', sizes: ['small', 'extraLarge'], defaultSize: 'small' });
    eq(reg.find({ query: 'cal' }).map(k => k.id), ['cal']);
    eq(reg.find({ category: 'Clock' }).map(k => k.id), ['clock']);
    eq(reg.find().length, 2);
    eq(reg.categories(), ['Clock', 'Calendar']);
    eq(reg.sizesFor('cal', 'desktop'), ['small', 'extraLarge']);
    eq(reg.sizesFor('cal', 'center'), ['small']);
    eq(reg.sizesFor('none'), []);
    let threw = 0;
    for (const bad of [{ id: 'clock', sizes: ['small'], defaultSize: 'small' },
        { id: 'x', sizes: ['tiny'], defaultSize: 'tiny' }, { id: 'y', sizes: ['small'], defaultSize: 'large' }]) {
        try { reg.register({ title: 't', category: 'c', ...bad }); } catch (_e) { threw++; }
    }
    eq(threw, 3);
});

test('the default set is small enough to fit any screen', () => {
    let items = [];
    for (const d of DEFAULT_WIDGETS)
        items = addItem(items, { ...d, monitor: 'm0' }, grid).items;
    eq(items.length, DEFAULT_WIDGETS.length);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
