// Run: gjs -m tests/stageManagerDrag.test.js
// Drop targets of Stage Manager drag and drop (features/stageManager/dragModel.js), SM-34.
import {
    CARD_SLACK, DRAG_PX, dragStarted, nearStripEdge, sameFrame, thumbDropTarget, windowDropTarget,
} from '../features/stageManager/dragModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const workArea = { x: 0, y: 30, width: 1920, height: 1050 };
const band = { x: 0, y: 100, width: 200, height: 700 };
const cards = [
    { id: 1, rect: { x: 10, y: 130, width: 180, height: 120 } },
    { id: 2, rect: { x: 10, y: 270, width: 180, height: 120 } },
];

test('SM-34 a press that barely moves is a click, not a drag', () => {
    eq(dragStarted({ x: 50, y: 50 }, { x: 53, y: 52 }), false);
    eq(dragStarted({ x: 50, y: 50 }, { x: 50 + DRAG_PX, y: 50 }), true);
});

test('SM-34 a thumbnail dropped on the stage joins it', () => {
    eq(thumbDropTarget({ x: 900, y: 500 }, { band, workArea }), 'stage');
});

test('SM-34 a thumbnail dropped on the strip or off the screen goes back', () => {
    eq(thumbDropTarget({ x: 100, y: 300 }, { band, workArea }), null);
    eq(thumbDropTarget({ x: 2500, y: 300 }, { band, workArea }), null);
    eq(thumbDropTarget({ x: 900, y: 10 }, { band, workArea }), null, 'the top bar');
});

test('SM-34 a window over a thumbnail joins its set', () => {
    eq(windowDropTarget({ x: 100, y: 300 }, { band, cards }), { kind: 'set', id: 2 });
    eq(windowDropTarget({ x: 100, y: 130 - CARD_SLACK }, { band, cards }), { kind: 'set', id: 1 }, 'slack');
});

test('SM-34 a window over the strip between thumbnails becomes its own set (SM-25)', () => {
    eq(windowDropTarget({ x: 100, y: 780 }, { band, cards }), { kind: 'strip' });
});

test('SM-34 a window dropped elsewhere does nothing', () => {
    eq(windowDropTarget({ x: 900, y: 500 }, { band, cards }), null);
    eq(windowDropTarget({ x: 100, y: 300 }, { band: null, cards: [] }), null);
});

test('SM-34 the edge zone follows the strip side', () => {
    eq(nearStripEdge({ x: 3, y: 500 }, { workArea, side: 'left', reach: 24 }), true);
    eq(nearStripEdge({ x: 3, y: 500 }, { workArea, side: 'right', reach: 24 }), false);
    eq(nearStripEdge({ x: 1910, y: 500 }, { workArea, side: 'right', reach: 24 }), true);
});

test('SM-34 Esc ends the grab with the window where it began: not a drop', () => {
    const f = { x: 300, y: 200, width: 800, height: 600 };
    eq(sameFrame(f, { ...f }), true);
    eq(sameFrame(f, { ...f, x: 301 }), false);
    eq(sameFrame(null, f), false);
});

if (failed > 0)
    imports.system.exit(1);
