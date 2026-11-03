// Run: gjs -m tests/stageManagerGeometry.test.js
import {
    METRICS, balancedFit, clonePose, edgeBarrier, layerRect, overlaps, stackLayers,
    stageRect, stripLayout, stripSide, scaleMs, tiltAngle,
} from '../features/stageManager/geometry.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const wa = { x: 0, y: 32, width: 1280, height: 768 };

test('stageRect: a maximized window already covers the work area, whatever its frame says', () => {
    const frame = { x: 380, y: 209, width: 520, height: 340 };
    eq(stageRect(frame, true, wa), wa);
    eq(stageRect(frame, false, wa), frame);
    eq(stageRect(frame, true, null), frame);
    eq(overlaps(stageRect(frame, true, wa), { x: 0, y: 100, width: 200, height: 600 }), true);
});

test('the strip takes the side opposite a side dock', () => {
    eq(stripSide('left', 'left'), 'right');
    eq(stripSide('right', 'right'), 'left');
    eq(stripSide('right', 'bottom'), 'right');
    eq(stripSide('left', null), 'left');
    eq(stripSide('bogus', null), 'left');
});

test('layout: slots centred in the band, inside the work area, floor around them', () => {
    const l = stripLayout({ workArea: wa, side: 'left', count: 3 });
    eq(l.slots.length, 3);
    for (const s of l.slots)
        eq(s.x >= 0 && s.x + s.width <= METRICS.stripWidth && s.y >= wa.y && s.y + s.height <= wa.y + wa.height, true);
    eq(l.floor.y < l.slots[0].y && l.floor.y + l.floor.height > l.slots[2].y + l.slots[2].height, true);
    const r = stripLayout({ workArea: wa, side: 'right', count: 1 });
    eq(r.band.x, wa.width - METRICS.stripWidth);
    eq(l.floor.x, wa.x);   // the floor reaches the screen edge: a pointer resting there is on it
    eq(r.floor.x + r.floor.width, wa.x + wa.width);
    eq(stripLayout({ workArea: wa, side: 'left', count: 0 }).floor, null);
});

test('layout: six entries always fit the work area, shrinking to the minimum scale', () => {
    const few = stripLayout({ workArea: wa, side: 'left', count: 3 });
    eq(few.scale, 1);
    const six = stripLayout({ workArea: wa, side: 'left', count: 6 });
    eq(six.scale >= METRICS.minScale && six.scale < 1, true);
    const last = six.slots[5];
    eq(last.y + last.height <= wa.y + wa.height, true);
    eq(six.slots[0].y >= wa.y + METRICS.padTop - 1, true);
    const short = stripLayout({ workArea: { ...wa, height: 600 }, side: 'left', count: 6 });
    eq(short.slots[5].y + short.slots[5].height <= 632, true);
});

test('balanced sizes: tall, wide and square windows get similar weight, aspect kept', () => {
    const tall = balancedFit(400, 1000, 150, 100);
    const wide = balancedFit(1600, 400, 150, 100);
    const sq = balancedFit(800, 800, 150, 100);
    for (const f of [tall, wide, sq])
        eq(f.width <= 150.0001 && f.height <= 100.0001, true);
    eq(Math.abs(tall.width / tall.height - 0.4) < 1e-9, true);
    const area = f => f.width * f.height;
    eq(area(sq) > area(tall) * 0.5 && area(sq) < area(tall) * 4, true);
});

test('clone pose: the frame centre lands on the rect centre, pivot on the frame centre', () => {
    const frame = { x: 110, y: 120, width: 800, height: 600 };
    const buffer = { x: 100, y: 100, width: 820, height: 640 };
    const p = clonePose(frame, buffer, { x: 0, y: 0, width: 80, height: 60 });
    eq(p.scale, 0.1);
    eq(Math.round(p.x + p.pivotX * buffer.width), 40);
    eq(Math.round(p.y + p.pivotY * buffer.height), 30);
    eq(clonePose(frame, buffer, { x: 0, y: 0, width: 0, height: 0 }), null);
});

test('stacks peek toward the edge; sets fan out and stay opaque; at most stackMax', () => {
    const l = stackLayers(5, 'left');
    eq(l.length, METRICS.stackMax);
    eq(l[1].dx < 0, true);
    eq(stackLayers(2, 'right')[1].dx > 0, true);
    eq(stackLayers(2, 'left', { set: true })[1].opacity > l[1].opacity, true);
    const r = layerRect({ width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 50 }, l[0], 1);
    eq(r.x >= 0 && r.width <= 50, true);
});

test('tilt turns toward the stage on either side', () => {
    eq(tiltAngle('left', 22), 22);
    eq(tiltAngle('right', 22), -22);
});

test('edge barrier: on the outer edge, none where another monitor continues', () => {
    const mon = { x: 0, y: 0, width: 1280, height: 800 };
    eq(edgeBarrier(wa, mon, [], 'left'), { x1: 0, x2: 0, y1: 32, y2: 800, direction: 'positive' });
    eq(edgeBarrier(wa, mon, [{ x: -1920, y: 0, width: 1920, height: 1080 }], 'left'), null);
    eq(edgeBarrier(wa, mon, [{ x: -1920, y: 0, width: 1920, height: 1080 }], 'right').direction, 'negative');
});

test('small helpers', () => {
    eq(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 }), true);
    eq(overlaps({ x: 0, y: 0, width: 10, height: 10 }, null), false);
    eq(scaleMs(400, 2), 200);
    eq(scaleMs(400, NaN), 400);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
