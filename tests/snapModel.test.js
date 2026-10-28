// Run: gjs -m tests/snapModel.test.js
import { SNAP_LAYOUTS, ZONES } from '../core/tileActions.js';
import {
    SNAP_STATES as S, BAR_RADIUS, HANDLE_RADIUS, HANDLE_W, ZONE_GAP, THUMB_MAX_W, THUMB_MIN_W,
    nextSnapState, radiusAt, snapGeometry, snapZoneAt,
} from '../features/windows/snapModel.js';

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

const MON = { x: 0, y: 0, width: 1280, height: 800 };
const TOP = 32;
const geom = snapGeometry(MON, TOP);
const centre = 640;

// --- the layout data
test('Windows 11 set: six layouts in order', () =>
    eq(SNAP_LAYOUTS.map(l => l.id), ['halves', 'wide-left', 'wide-right', 'thirds', 'main-left', 'quarters']));
test('every layout zone is a tile action', () => {
    for (const l of SNAP_LAYOUTS) {
        for (const z of l.zones) {
            if (!(z in ZONES))
                throw new Error(`${l.id}: unknown zone ${z}`);
        }
    }
});
test('the zones of a layout cover the screen exactly once', () => {
    for (const l of SNAP_LAYOUTS) {
        // Sample a grid of points: each lies in exactly one zone
        for (let x = 0.01; x < 1; x += 0.0625) {
            for (let y = 0.01; y < 1; y += 0.0625) {
                const n = l.zones.filter(z => {
                    const f = ZONES[z];
                    return x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h;
                }).length;
                if (n !== 1)
                    throw new Error(`${l.id}: ${n} zones at ${x},${y}`);
            }
        }
    }
});
test('layout ids are unique', () => eq(new Set(SNAP_LAYOUTS.map(l => l.id)).size, SNAP_LAYOUTS.length));

// --- geometry
test('handle and bar are centred under the top bar and share their top', () => {
    eq(geom.handle.x + geom.handle.width / 2, centre);
    eq(geom.bar.x + geom.bar.width / 2, centre);
    eq(geom.handle.y, geom.bar.y);
    eq(geom.bar.y > TOP, true);
});
test('thumbnails fit in the bar, in a row, in order', () => {
    let last = -1;
    for (const t of geom.thumbs) {
        eq(t.rect.x > last, true);
        last = t.rect.x + t.rect.width;
        eq(t.rect.x + t.rect.width <= geom.bar.width, true);
        eq(t.rect.y + t.rect.height <= geom.bar.height, true);
    }
});
test('thumbnails keep the monitor ratio and stay within limits', () => {
    const t = geom.thumbs[0].rect;
    eq(Math.abs(t.width / t.height - 1280 / 800) < 0.03, true);
    const small = snapGeometry({ x: 0, y: 0, width: 400, height: 300 }, 20).thumbs[0].rect.width;
    const huge = snapGeometry({ x: 0, y: 0, width: 7680, height: 4320 }, 20).thumbs[0].rect.width;
    eq([small, huge], [THUMB_MIN_W, THUMB_MAX_W]);
});
test('zones inside a thumbnail keep a gap and stay inside it', () => {
    const halves = geom.thumbs[0];
    const [l, r] = halves.zones.map(z => z.rect);
    eq(r.x - (l.x + l.width), ZONE_GAP);
    eq(l.x, ZONE_GAP);
    eq(r.x + r.width, halves.rect.width - ZONE_GAP);
});
test('the geometry follows a second monitor', () => {
    const g = snapGeometry({ x: 1280, y: 0, width: 1920, height: 1080 }, 32);
    eq(g.handle.x + g.handle.width / 2, 1280 + 960);
});

// --- state
const at = (x, y) => ({ x, y });
const overHandle = at(centre, geom.handle.y + 5);
test('top centre reveals the handle; elsewhere on the top does not', () => {
    eq(nextSnapState(S.HIDDEN, at(centre, 3), geom), S.HANDLE);
    eq(nextSnapState(S.HIDDEN, at(centre + 400, 3), geom), S.HIDDEN);
    eq(nextSnapState(S.HIDDEN, at(centre, 300), geom), S.HIDDEN);
});
test('the handle expands only when the pointer is on it', () => {
    eq(nextSnapState(S.HANDLE, overHandle, geom), S.BAR);
    eq(nextSnapState(S.HANDLE, at(centre, 3), geom), S.HANDLE);
});
test('the handle stays near it and hides when the pointer goes away', () => {
    eq(nextSnapState(S.HANDLE, at(centre + 60, geom.handle.y), geom), S.HANDLE);
    eq(nextSnapState(S.HANDLE, at(centre, 400), geom), S.HIDDEN);
    eq(nextSnapState(S.HANDLE, at(centre + 500, 3), geom), S.HIDDEN);
});
test('the bar stays while the pointer is on it, collapses to the handle above it, hides below', () => {
    const inside = at(geom.bar.x + 20, geom.bar.y + geom.bar.height - 5);
    eq(nextSnapState(S.BAR, inside, geom), S.BAR);
    eq(nextSnapState(S.BAR, at(centre, 3), geom), S.HANDLE);
    eq(nextSnapState(S.BAR, at(centre, geom.bar.y + geom.bar.height + 60), geom), S.HIDDEN);
    eq(nextSnapState(S.BAR, at(geom.bar.x - 100, geom.bar.y + 20), geom), S.HIDDEN);
});

// --- zone hit
function centreOf(layoutId, zone) {
    const t = geom.thumbs.find(x => x.id === layoutId);
    const r = t.zones.find(z => z.zone === zone).rect;
    return at(geom.bar.x + t.rect.x + r.x + r.width / 2, geom.bar.y + t.rect.y + r.y + r.height / 2);
}
test('each zone of each layout is found by its centre, with its layout', () => {
    for (const l of SNAP_LAYOUTS) {
        for (const z of l.zones)
            eq(snapZoneAt(centreOf(l.id, z), geom), { layoutId: l.id, zone: z });
    }
});
test('the gap between two zones of a thumbnail still hits one', () => {
    const t = geom.thumbs[0];
    const [l] = t.zones.map(z => z.rect);
    const p = at(geom.bar.x + t.rect.x + l.x + l.width + ZONE_GAP / 2 - 0.5, geom.bar.y + t.rect.y + 20);
    eq(snapZoneAt(p, geom) !== null, true);
});
test('the bar padding and the space between thumbnails hit nothing', () => {
    eq(snapZoneAt(at(geom.bar.x + 2, geom.bar.y + 2), geom), null);
    const first = geom.thumbs[0].rect;
    eq(snapZoneAt(at(geom.bar.x + first.x + first.width + 5, geom.bar.y + first.y + 20), geom), null);
});

// --- corner morph
test('the radius goes from the handle\'s to the bar\'s with the width', () => {
    eq(radiusAt(HANDLE_W, geom.bar.width), HANDLE_RADIUS);
    eq(radiusAt(geom.bar.width, geom.bar.width), BAR_RADIUS);
    eq(radiusAt(0, geom.bar.width), HANDLE_RADIUS);
    eq(radiusAt(9999, geom.bar.width), BAR_RADIUS);
    const mid = radiusAt((HANDLE_W + geom.bar.width) / 2, geom.bar.width);
    eq(mid > HANDLE_RADIUS && mid < BAR_RADIUS, true);
});

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
print('all passed');
