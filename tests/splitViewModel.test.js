// Run: gjs -m tests/splitViewModel.test.js
import { isCandidate, splitRects, survivorAfter, thumbnailRects, preSplitRect } from '../features/splitView/model.js';

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

const AREA = { x: 0, y: 32, width: 1281, height: 768 };

test('splitRects: halves meet, odd widths go right', () => {
    eq(splitRects(AREA, 'left'), {
        tiled: { x: 0, y: 32, width: 640, height: 768 }, other: { x: 640, y: 32, width: 641, height: 768 },
    });
    const r = splitRects(AREA, 'right');
    eq(r.tiled.x, 640);
    eq(r.other.x, 0);
});

test('splitRects: second monitor origin', () => {
    eq(splitRects({ x: 1280, y: 0, width: 1000, height: 500 }, 'right').tiled, { x: 1780, y: 0, width: 500, height: 500 });
});

test('isCandidate', () => {
    const base = { type: 'normal', skipTaskbar: false, fullscreen: false, inSplit: false, isTiled: false };
    ok(isCandidate(base));
    ok(!isCandidate({ ...base, type: 'dialog' }));
    ok(!isCandidate({ ...base, skipTaskbar: true }));
    ok(!isCandidate({ ...base, fullscreen: true }));
    ok(!isCandidate({ ...base, inSplit: true }));
    ok(!isCandidate({ ...base, isTiled: true }));
});

test('thumbnailRects: inside the half, never enlarged, no overlap', () => {
    const area = { x: 640, y: 0, width: 640, height: 800 };
    const rects = thumbnailRects([{ width: 800, height: 600 }, { width: 500, height: 300 }, { width: 200, height: 100 }], area);
    eq(rects.length, 3);
    for (const r of rects) {
        ok(r.x >= area.x && r.x + r.width <= area.x + area.width, `x ${JSON.stringify(r)}`);
        ok(r.y >= area.y && r.y + r.height <= area.y + area.height, `y ${JSON.stringify(r)}`);
        ok(r.scale <= 1);
    }
    eq(rects[2].width, 200);   // small windows keep their size
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'overlap');
        }
    }
    eq(thumbnailRects([], area), []);
});

test('preSplitRect: the windowed frame, never a whole-area one', () => {
    const area = { x: 0, y: 32, width: 1280, height: 768 };
    eq(preSplitRect({ x: 100, y: 80, width: 800, height: 600 }, area), { x: 100, y: 80, width: 800, height: 600 });
    eq(preSplitRect({ x: 0, y: 32, width: 1280, height: 768 }, area), null);
    eq(preSplitRect(null, area), null);
});

test('survivorAfter', () => {
    const pair = { a: 'A', b: 'B' };
    eq(survivorAfter(pair, 'A'), 'B');
    eq(survivorAfter(pair, 'B'), 'A');
    eq(survivorAfter(pair, 'C'), null);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
