// Run: gjs -m tests/tileMotionModel.test.js
import { planTile, lerpRect, frameTransform, isSettled } from '../features/windows/tileMotionModel.js';

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

const ENV = { animations: true, reducedMotion: false };
const A = { x: 100, y: 100, width: 400, height: 300 };
const B = { x: 0, y: 32, width: 640, height: 700 };
const ok = { visible: true, fullscreen: false, env: ENV };

test('growing and shrinking pick their mode', () => {
    eq(planTile({ from: A, to: B, ...ok }), 'grow');
    eq(planTile({ from: B, to: A, ...ok }), 'shrink');
});

test('no flight with animations off, reduced motion, hidden or full-screen windows', () => {
    eq(planTile({ from: A, to: B, ...ok, env: { animations: false, reducedMotion: false } }), null);
    eq(planTile({ from: A, to: B, ...ok, env: { animations: true, reducedMotion: true } }), null);
    eq(planTile({ from: A, to: B, ...ok, visible: false }), null);
    eq(planTile({ from: A, to: B, ...ok, fullscreen: true }), null);
});

test('no flight for a move under two pixels or an empty rect', () => {
    eq(planTile({ from: A, to: { ...A, x: 101 }, ...ok }), null);
    eq(planTile({ from: A, to: { ...A, x: 102 }, ...ok }), 'grow');
    eq(planTile({ from: { ...A, width: 0 }, to: B, ...ok }), null);
});

test('lerpRect ends and middle', () => {
    eq(lerpRect(A, B, 0), A);
    eq(lerpRect(A, B, 1), B);
    eq(lerpRect(A, B, 0.5), { x: 50, y: 66, width: 520, height: 500 });
});

test('frameTransform puts the current frame on the wanted rect', () => {
    eq(frameTransform(A, B), { scaleX: 400 / 640, scaleY: 300 / 700, tx: 100, ty: 68 });
    eq(frameTransform(B, B), { scaleX: 1, scaleY: 1, tx: 0, ty: 0 });
    eq(frameTransform(A, { x: 0, y: 0, width: 0, height: 0 }).scaleX, 1);
});

test('isSettled tolerates a pixel', () => {
    eq(isSettled({ ...B, width: 639 }, B), true);
    eq(isSettled({ ...B, width: 637 }, B), false);
});

if (failed)
    imports.system.exit(1);
