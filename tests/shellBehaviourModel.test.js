// Run: gjs -m tests/shellBehaviourModel.test.js
import { clampSnapPoints } from '../features/shellBehaviour/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

// ControlsState: HIDDEN 0, WINDOW_PICKER 1, APP_GRID 2
const ALL = [0, 1, 2];
const WP = 1;

test('from the desktop: no app grid point', () => eq(clampSnapPoints(ALL, 0, 0, WP), [0, 1]));
test('in the window picker: a swipe up has nowhere to go', () => eq(clampSnapPoints(ALL, 1, 1, WP), [0, 1]));
test('float noise at the window picker still clamps', () => eq(clampSnapPoints(ALL, 1.0000001, 1, WP), [0, 1]));
test('mid-swipe between desktop and picker clamps', () => eq(clampSnapPoints(ALL, 0.4, 1, WP), [0, 1]));
test('in the app grid: stock points, so a swipe down works', () => eq(clampSnapPoints(ALL, 2, 2, WP), ALL));
test('on the way to the app grid (cancel target 2): stock points', () => eq(clampSnapPoints(ALL, 0.6, 2, WP), ALL));
test('leaving the app grid (progress above the picker): stock points', () => eq(clampSnapPoints(ALL, 1.5, 1, WP), ALL));
test('input is not mutated', () => {
    const pts = [0, 1, 2];
    clampSnapPoints(pts, 0, 0, WP);
    eq(pts, [0, 1, 2]);
});
test('never fewer than two points', () => eq(clampSnapPoints([1, 2], 1, 1, WP), [1, 2]));
test('junk input is passed through', () => {
    eq(clampSnapPoints([], 0, 0, WP), []);
    eq(clampSnapPoints(null, 0, 0, WP), null);
    eq(clampSnapPoints(ALL, NaN, 0, WP), ALL);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
