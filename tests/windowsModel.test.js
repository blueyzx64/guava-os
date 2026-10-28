// Run: gjs -m tests/windowsModel.test.js
import {
    ZONES, ARRANGEMENTS, parseAction, zoneRect, centerRect, placeIn, hitZone, dropZone, planArrangement, needsDwell, nearRect,
    untileRect, rectChanged, TileBook, SHORTCUTS, pickBindable, TILE_MARGIN, EDGE_PX,
} from '../features/windows/model.js';
import { planHide, HiddenApps, HIDE_MODES } from '../features/windows/hideModel.js';
import { EVENTS } from '../core/events.js';

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

// Work area of a 1280x800 monitor under a 32px menu bar, above a 72px dock
const AREA = { x: 0, y: 32, width: 1280, height: 696 };
const MON = { x: 0, y: 0, width: 1280, height: 800 };
const TOP = 32;

// --- actions
test('dropZone: the top zones tile at once, edges only after their outline showed', () => {
    eq(dropZone({ live: 'fill', shown: null, buttonDown: false }), 'fill');
        eq(dropZone({ live: 'left', shown: 'left', buttonDown: false }), 'left');
    eq(dropZone({ live: 'left', shown: null, buttonDown: false }), null);
    eq(dropZone({ live: 'left', shown: 'right', buttonDown: false }), null);
});
test('dropZone: cancelled (button still down) or nowhere does not tile', () => {
    eq(dropZone({ live: 'fill', shown: 'fill', buttonDown: true }), null);
    eq(dropZone({ live: null, shown: 'left', buttonDown: false }), null);
});
test('needsDwell: only edges and corners wait', () => {
    eq(['fill', 'left', 'top-left'].map(needsDwell), [false, true, true]);
});

test('parseAction knows zones, center, restore and arrangements', () => {
    eq(parseAction('left'), { kind: 'zone', name: 'left' });
    eq(parseAction('fill'), { kind: 'zone', name: 'fill' });
    eq(parseAction('center'), { kind: 'center' });
    eq(parseAction('restore'), { kind: 'restore' });
    eq(parseAction('arrange-quarters'), { kind: 'arrange', name: 'quarters' });
});
test('parseAction rejects unknown actions', () => {
    eq(parseAction('arrange-thirds'), null);
    eq(parseAction('middle'), null);
    eq(parseAction(null), null);
});
test('every arrangement uses known zones', () =>
    eq(Object.values(ARRANGEMENTS).flat().every(z => z in ZONES), true));
test('the tiling events are declared', () => {
    eq(Object.keys(EVENTS['window-tile-requested']), ['window', 'mode']);
    eq(Object.keys(EVENTS['app-hide-requested']), ['appId', 'mode']);
    eq('window-tiled' in EVENTS && 'app-hidden' in EVENTS, true);
});

// --- zone rects
test('halves split the work area exactly', () => {
    const l = zoneRect('left', AREA);
    const r = zoneRect('right', AREA);
    eq(l, { x: 0, y: 32, width: 640, height: 696 });
    eq(r, { x: 640, y: 32, width: 640, height: 696 });
});
test('fill is the work area, never under the dock', () => {
    const f = zoneRect('fill', AREA);
    eq(f, AREA);
    eq(f.y + f.height <= 800 - 72, true);
});
test('quarters meet at the centre', () => {
    const tl = zoneRect('top-left', AREA);
    const br = zoneRect('bottom-right', AREA);
    eq([tl.x + tl.width, tl.y + tl.height], [br.x, br.y]);
});
test('odd sizes leave no gap between halves', () => {
    const a = { x: 3, y: 30, width: 1279, height: 701 };
    const l = zoneRect('left', a);
    const r = zoneRect('right', a);
    eq(l.x + l.width, r.x);
    eq(r.x + r.width, a.x + a.width);
    const t = zoneRect('top', a);
    const b = zoneRect('bottom', a);
    eq(t.y + t.height, b.y);
});
test('margins: full margin outside, one margin between tiles', () => {
    const m = TILE_MARGIN;
    const l = zoneRect('left', AREA, m);
    const r = zoneRect('right', AREA, m);
    eq(l.x, AREA.x + m);
    eq(l.y, AREA.y + m);
    eq(r.x - (l.x + l.width), m);
    eq(AREA.x + AREA.width - (r.x + r.width), m);
    eq(AREA.y + AREA.height - (l.y + l.height), m);
});
test('fill with margins is inset on every side', () =>
    eq(zoneRect('fill', AREA, 8), { x: 8, y: 40, width: 1264, height: 680 }));
test('centerRect keeps the size and centres', () =>
    eq(centerRect(AREA, 400, 300), { x: 440, y: 230, width: 400, height: 300 }));
test('centerRect never exceeds the area', () =>
    eq(centerRect(AREA, 2000, 300), { x: 0, y: 230, width: 1280, height: 300 }));

// --- windows that do not fit
test('a fixed-size window is centred in its tile', () => {
    const t = zoneRect('right', AREA);
    eq(placeIn('right', t, { width: 360, height: 520 }, AREA), { x: 780, y: 120, width: 360, height: 520 });
});
test('a too-large window keeps the outer edge of a right tile', () => {
    const t = zoneRect('right', AREA);
    const p = placeIn('right', t, { width: 800, height: 696 }, AREA);
    eq([p.x + p.width, p.y], [1280, 32]);
});
test('a too-large window keeps the outer edge of a left tile', () => {
    const t = zoneRect('left', AREA);
    eq(placeIn('left', t, { width: 800, height: 400 }, AREA).x, 0);
});
test('a window larger than the work area starts at its origin', () => {
    const t = zoneRect('top-right', AREA);
    const p = placeIn('top-right', t, { width: 1500, height: 900 }, AREA);
    eq([p.x, p.y], [0, 32]);
});

// --- drag hit testing
const hit = (x, y, o = {}) => hitZone({ x, y }, MON, { topEdge: TOP, ...o });
test('left and right edges are halves', () => {
    eq(hit(0, 400), 'left');
    eq(hit(1279, 400), 'right');
});
test('edge corners are quarters', () => {
    eq(hit(0, 40), 'top-left');
    eq(hit(1279, 790), 'bottom-right');
    eq(hit(1279, 40), 'top-right');
});
test('top and bottom edge near a corner are quarters', () => {
    eq(hit(60, 0), 'top-left');
    eq(hit(1230, 799), 'bottom-right');
});
test('the menu bar is Fill', () => {
    eq(hit(640, 10), 'fill');
    eq(hit(640, TOP), 'fill');
    eq(hit(640, TOP + 1), null);
});
test('the middle of the screen is nothing', () => eq(hit(640, 400), null));
test('the bottom edge away from the corners is nothing', () => eq(hit(640, 799), null));
test('edges off: no halves or quarters, Fill stays', () => {
    eq(hit(0, 400, { edges: false }), null);
    eq(hit(640, 5, { edges: false }), 'fill');
});
test('menu bar off: no Fill', () => eq(hit(640, 5, { menuBar: false }), null));
test('modifier: outer quarters are halves without the edge', () => {
    eq(hit(200, 400, { modifier: true }), 'left');
    eq(hit(1100, 400, { modifier: true }), 'right');
    eq(hit(640, 400, { modifier: true }), null);
    eq(hit(200, 400), null);
});
test('modifier still needs the edge for quarters', () =>
    eq(hit(200, 40, { modifier: true }), 'left'));
test('edge tolerance', () => {
    eq(hit(EDGE_PX, 400), 'left');
    eq(hit(EDGE_PX + 1, 400), null);
});
test('second monitor offsets', () => {
    const m2 = { x: 1280, y: 0, width: 1920, height: 1080 };
    eq(hitZone({ x: 1280, y: 500 }, m2, { topEdge: 6 }), 'left');
    eq(hitZone({ x: 3199, y: 500 }, m2, { topEdge: 6 }), 'right');
    eq(hitZone({ x: 2000, y: 3 }, m2, { topEdge: 6 }), 'fill');
});

test('the whole top bar fills, the snap bar is not the hit test\'s business', () => {
    eq(hit(640, 3), 'fill');
    eq(hit(640, 3, { menuBar: false }), null);
});
test('nearRect pads a rect on every side', () => {
    const rect = { x: 10, y: 0, width: 10, height: 10 };
    eq(nearRect({ x: 25, y: 5 }, rect, 6), true);
    eq(nearRect({ x: 25, y: 5 }, rect), false);
});

// --- arrangements
test('left & right: active left, previous right', () =>
    eq(planArrangement('left-right', [5, 9, 2]), [{ id: 5, zone: 'left' }, { id: 9, zone: 'right' }]));
test('quarters with four windows', () =>
    eq(planArrangement('quarters', [1, 2, 3, 4, 5]).map(p => p.zone),
        ['top-left', 'top-right', 'bottom-left', 'bottom-right']));
test('quarters with two windows fill two quarters', () =>
    eq(planArrangement('quarters', [1, 2]).length, 2));
test('left & quarters: half then the two right quarters', () =>
    eq(planArrangement('left-quarters', [1, 2, 3]).map(p => p.zone), ['left', 'top-right', 'bottom-right']));
test('unknown arrangement plans nothing', () => eq(planArrangement('thirds', [1, 2]), []));

// --- untile on drag
test('untile keeps the pointer at its relative place', () => {
    const r = untileRect({ x: 640, y: 32, width: 640, height: 696 }, { width: 400, height: 300 }, { x: 960, y: 50 });
    eq(r, { x: 760, y: 32, width: 400, height: 300 });
    eq(r.x <= 960 && 960 <= r.x + r.width, true);
});
test('rectChanged has slack', () => {
    eq(rectChanged({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 0, width: 10, height: 11 }), false);
    eq(rectChanged({ x: 0, y: 0, width: 10, height: 10 }, { x: 3, y: 0, width: 10, height: 10 }), true);
});

// --- tile book
test('the first restore rect is kept across re-tiles', () => {
    const b = new TileBook();
    b.tile(1, { zone: 'left', monitor: 0, restore: { x: 10, y: 20, width: 300, height: 200 } });
    b.tile(1, { zone: 'right', monitor: 0, restore: { x: 640, y: 32, width: 640, height: 696 } });
    eq(b.get(1).zone, 'right');
    eq(b.untile(1), { x: 10, y: 20, width: 300, height: 200 });
    eq(b.has(1), false);
    eq(b.untile(1), null);
});
test('onMonitor lists tiles per monitor', () => {
    const b = new TileBook();
    const r = { x: 0, y: 0, width: 1, height: 1 };
    b.tile(1, { zone: 'left', monitor: 0, restore: r });
    b.tile(2, { zone: 'right', monitor: 1, restore: r });
    eq(b.onMonitor(0), [1]);
    eq(b.onMonitor(1), [2]);
});
test('neighbours: halves share the middle edge', () => {
    const b = new TileBook();
    const r = { x: 0, y: 0, width: 1, height: 1 };
    b.tile(1, { zone: 'left', monitor: 0, restore: r });
    b.tile(2, { zone: 'right', monitor: 0, restore: r });
    b.tile(3, { zone: 'right', monitor: 1, restore: r });
    eq(b.neighbours(1), [{ id: 2, side: 'right' }]);
    eq(b.neighbours(2), [{ id: 1, side: 'left' }]);
});
test('neighbours: quarters touch on two sides', () => {
    const b = new TileBook();
    const r = { x: 0, y: 0, width: 1, height: 1 };
    ['top-left', 'top-right', 'bottom-left', 'bottom-right'].forEach((zone, i) =>
        b.tile(i + 1, { zone, monitor: 0, restore: r }));
    eq(b.neighbours(1), [{ id: 2, side: 'right' }, { id: 3, side: 'bottom' }]);
    eq(b.neighbours(4), [{ id: 2, side: 'top' }, { id: 3, side: 'left' }]);
});
test('neighbours: fill and center have none', () => {
    const b = new TileBook();
    const r = { x: 0, y: 0, width: 1, height: 1 };
    b.tile(1, { zone: 'fill', monitor: 0, restore: r });
    b.tile(2, { zone: 'center', monitor: 0, restore: r });
    b.tile(3, { zone: 'left', monitor: 0, restore: r });
    eq(b.neighbours(1), []);
    eq(b.neighbours(3), []);
});

// --- shortcuts
test('every shortcut key maps to a valid action', () =>
    eq(SHORTCUTS.every(s => parseAction(s.action) !== null && s.key.startsWith('windows-')), true));
test('pickBindable leaves taken accelerators unbound', () => {
    const taken = new Map([['<super><ctrl>down', 'Guava stage-manager-remove-shortcut']]);
    const r = pickBindable([
        { key: 'a', accels: ['<Control><Super>Left'] },
        { key: 'b', accels: ['<Control><Super>Down'] },
        { key: 'c', accels: [] },
    ], taken);
    eq(r.bind, ['a']);
    eq(r.skipped, [{ key: 'b', accel: '<Control><Super>Down', with: 'Guava stage-manager-remove-shortcut' }]);
});
test('pickBindable: two keys with one accelerator, the first wins', () => {
    const r = pickBindable([
        { key: 'a', accels: ['<Super><Control>f'] },
        { key: 'b', accels: ['<Control><Super>F'] },
    ], new Map());
    eq(r.bind, ['a']);
    eq(r.skipped[0].with, 'a');
});

// --- hide
const W = (id, appId, extra = {}) => ({ id, appId, type: 'normal', minimized: false, skipTaskbar: false, ...extra });
const WINS = [W(1, 'ed'), W(2, 'files'), W(3, 'ed'), W(4, 'calc'), W(5, 'files', { minimized: true }),
    W(6, 'ed', { type: 'dialog' }), W(7, 'music', { skipTaskbar: true })];
test('hide picks the visible normal windows of the app', () =>
    eq([...planHide('hide', 'ed', WINS)], [['ed', [1, 3]]]));
test('hide others picks every other app, in MRU order', () =>
    eq([...planHide('others', 'ed', WINS)], [['files', [2]], ['calc', [4]]]));
test('hide without an app does nothing', () => eq(planHide('hide', null, WINS).size, 0));
test('hide modes', () => eq([...HIDE_MODES], ['hide', 'others', 'all']));
test('HiddenApps: show gives back what was hidden, once', () => {
    const h = new HiddenApps();
    h.hide('ed', [1, 3]);
    eq(h.has('ed'), true);
    eq(h.appOf(3), 'ed');
    eq(h.show('ed'), [1, 3]);
    eq(h.has('ed'), false);
    eq(h.show('ed'), []);
    eq(h.appOf(3), null);
});
test('HiddenApps: hiding again adds without duplicates', () => {
    const h = new HiddenApps();
    h.hide('ed', [1]);
    h.hide('ed', [1, 3]);
    eq(h.show('ed'), [1, 3]);
});
test('HiddenApps: the last closed window forgets the app', () => {
    const h = new HiddenApps();
    h.hide('ed', [1, 3]);
    eq(h.forgetWindow(1), null);
    eq(h.forgetWindow(3), 'ed');
    eq(h.has('ed'), false);
    eq(h.forgetWindow(9), null);
});
test('HiddenApps survives a disable through toJSON/from', () => {
    const h = new HiddenApps();
    h.hide('ed', [1, 3]);
    h.hide('files', [2]);
    const back = HiddenApps.from(h.toJSON(), id => id !== 3);
    eq(back.toJSON(), [['ed', [1]], ['files', [2]]]);
    eq(HiddenApps.from([['x', [9]]], () => false).apps(), []);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
