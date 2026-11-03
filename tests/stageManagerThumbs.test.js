// Run: gjs -m tests/stageManagerThumbs.test.js
// Thumbnails on fractional and HiDPI monitors (RV1-9): positions on the physical pixel grid, and the
// box filter that follows the monitor's scale.
import { layerRect, slotBox, snapPx, stackLayers, stripLayout, thumbFilter } from '../src/features/stageManager/geometry.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}\n${e.stack}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const onGrid = (v, s) => Math.abs(v * s - Math.round(v * s)) < 1e-6;

test('RV1-9 snapPx puts a coordinate on the physical grid', () => {
    eq(snapPx(10.3, 1), 10);
    eq(snapPx(10.3, 2), 10.5);
    eq(snapPx(8, 1.25), 8);          // 10 physical px
    eq(snapPx(10, 1.25), 10.4);      // 12.5 physical px is half a pixel: round to 13
    eq(snapPx(10.3, 1.25), 10.4);
    eq(snapPx(5, 0), 5);
    eq(snapPx(5, NaN), 5);
});

test('RV1-9 the strip layout sits on whole physical pixels at 125%, 150% and 200%', () => {
    const wa = { x: 0, y: 32, width: 1280, height: 800 - 32 };
    for (const grid of [1.25, 1.5, 2]) {
        for (const count of [1, 3, 6]) {
            const l = stripLayout({ workArea: wa, side: 'left', count, grid });
            for (const s of l.slots) {
                for (const k of ['x', 'y', 'width', 'height'])
                    eq(onGrid(s[k], grid), true, `grid ${grid} count ${count} ${k}=${s[k]}`);
            }
        }
    }
});

test('RV1-9 the layout at scale 1 is what it was (whole logical pixels)', () => {
    const wa = { x: 0, y: 32, width: 1280, height: 768 };
    const a = stripLayout({ workArea: wa, side: 'left', count: 3 });
    const b = stripLayout({ workArea: wa, side: 'left', count: 3, grid: 1 });
    eq(a, b);
    for (const s of a.slots) {
        for (const k of ['x', 'y', 'width', 'height'])
            eq(Number.isInteger(s[k]), true, k);
    }
});

test('RV1-9 a layer rect sits on the physical grid', () => {
    const slot = { x: 0, y: 0, width: 180, height: 130 };
    const box = slotBox(slot, 1);
    for (const grid of [1.25, 2]) {
        for (const layer of stackLayers(3, 'left', { set: false })) {
            const r = layerRect({ width: 800, height: 500 }, box, layer, 1, grid);
            for (const k of ['x', 'y', 'width', 'height'])
                eq(onGrid(r[k], grid), true, `grid ${grid} ${k}=${r[k]}`);
        }
    }
    eq(layerRect({ width: 800, height: 500 }, box, stackLayers(1, 'left', { set: false })[0], 1),
        layerRect({ width: 800, height: 500 }, box, stackLayers(1, 'left', { set: false })[0], 1, 1));
});

test('RV1-9 the thumbnail filter: one output pixel wide, as many taps as texels under it', () => {
    eq(thumbFilter(0.25, 1), { span: 4, taps: 4 });
    // 200%: an output pixel is half a logical pixel, the texture has 2 texels per logical px
    eq(thumbFilter(0.25, 2), { span: 2, taps: 4 });
    eq(thumbFilter(0.5, 1.25).taps, 2);
    eq(Math.abs(thumbFilter(0.5, 1.25).span - 1.6) < 1e-9, true);
    // never a zero or infinite span
    eq(Number.isFinite(thumbFilter(0, 1).span), true);
    eq(thumbFilter(0.25, NaN), { span: 4, taps: 4 });
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
