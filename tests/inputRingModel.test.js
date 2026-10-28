// Run: gjs -m tests/inputRingModel.test.js
// lib/inputRingModel.js: the boxes of an input ring around a hole.
import { surround } from '../lib/inputRingModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('surround: no hole is the whole box; a hole leaves four boxes that tile the rest', () => {
    const outer = { x: 0, y: 0, w: 100, h: 50 };
    eq(surround(outer, null), [outer]);
    const rects = surround(outer, { x: 20, y: 10, w: 30, h: 20 });
    eq(rects.length, 4);
    eq(rects.reduce((a, r) => a + r.w * r.h, 0), 100 * 50 - 30 * 20);
});

test('surround: a hole touching an edge drops that box; a hole outside is clipped', () => {
    const outer = { x: 0, y: 0, w: 100, h: 50 };
    eq(surround(outer, { x: 0, y: 0, w: 100, h: 50 }), []);
    eq(surround(outer, { x: 0, y: 0, w: 100, h: 20 }).length, 1);
    const clipped = surround(outer, { x: 80, y: 40, w: 100, h: 100 });
    eq(clipped.reduce((a, r) => a + r.w * r.h, 0), 100 * 50 - 20 * 10);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
