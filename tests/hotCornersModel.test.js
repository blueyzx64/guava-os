// Run: gjs -m tests/hotCornersModel.test.js
import {
    CORNERS, CORNER_SIZE, atCorner, cornerBarriers, cornerPoint, hasCorner, shouldFire, wantedCorners,
} from '../features/hotCorners/model.js';
import { actionAllowed, normalizeAction } from '../core/desktopActionsModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

const M = (x, y, width, height) => ({ x, y, width, height });
const ONE = [M(0, 0, 1280, 800)];
// Two side by side, the right one lower and smaller
const TWO = [M(0, 0, 1920, 1080), M(1920, 200, 1280, 800)];
const ALL = Object.fromEntries(CORNERS.map(c => [c, 'mission-control']));

test('cornerPoint: the outer corner and its outward direction', () => {
    eq(cornerPoint(ONE[0], 'top-left'), { x: 0, y: 0, sx: -1, sy: -1 });
    eq(cornerPoint(ONE[0], 'bottom-right'), { x: 1280, y: 800, sx: 1, sy: 1 });
});

test('one monitor has four corners', () => {
    eq(CORNERS.map(c => hasCorner(ONE, 0, c)), [true, true, true, true]);
});

test('no corner where another monitor continues an edge', () => {
    eq(hasCorner(TWO, 0, 'top-right'), true);      // nothing right of y=0
    eq(hasCorner(TWO, 0, 'bottom-right'), true);   // the right monitor ends at y=1000
    eq(hasCorner(TWO, 1, 'top-left'), false);      // monitor 0 continues left of it
    eq(hasCorner([M(0, 0, 1920, 1080), M(1920, 0, 1280, 800)], 0, 'top-right'), false);
    eq(hasCorner(TWO, 1, 'bottom-left'), false);
    eq(hasCorner(TWO, 1, 'top-right'), true);
    // Stacked: the top monitor has no bottom corners, the lower one no top corners
    const STACK = [M(0, 0, 1280, 800), M(0, 800, 1280, 800)];
    eq(CORNERS.map(c => hasCorner(STACK, 0, c)), [true, true, false, false]);
    eq(CORNERS.map(c => hasCorner(STACK, 1, c)), [false, false, true, true]);
});

test('cornerBarriers: two short barriers, allowed back into the screen', () => {
    eq(cornerBarriers(ONE[0], 'top-left', 8), [
        { x1: 0, x2: 0, y1: 0, y2: 8, allow: 'positive-x' },
        { x1: 0, x2: 8, y1: 0, y2: 0, allow: 'positive-y' },
    ]);
    eq(cornerBarriers(ONE[0], 'bottom-right', 8), [
        { x1: 1280, x2: 1280, y1: 792, y2: 800, allow: 'negative-x' },
        { x1: 1272, x2: 1280, y1: 800, y2: 800, allow: 'negative-y' },
    ]);
});

test('wantedCorners: only corners with an action', () => {
    eq(wantedCorners(ONE, { 'top-left': 'none', 'bottom-right': 'desktop' }), [{ monitor: 0, corner: 'bottom-right' }]);
    eq(wantedCorners(ONE, {}), []);
    eq(wantedCorners(TWO, ALL).length, 6);
});

test('atCorner: near the corner point only', () => {
    eq(atCorner(0, 0, ONE[0], 'top-left'), true);
    eq(atCorner(CORNER_SIZE + 4, 0, ONE[0], 'top-left'), false); // over the logo menu
    eq(atCorner(1279, 799, ONE[0], 'bottom-right'), true);
    eq(atCorner(1279, 0, ONE[0], 'top-right'), true);
    eq(atCorner(1279, 400, ONE[0], 'top-right'), false);
});

const S = { action: 'mission-control', modifier: 'none', held: new Set(), fullscreen: false, overview: false, atCorner: true };
test('shouldFire: action, place, modifier, full screen', () => {
    eq(shouldFire(S), true);
    eq(shouldFire({ ...S, action: 'none' }), false);
    eq(shouldFire({ ...S, atCorner: false }), false);
    eq(shouldFire({ ...S, modifier: 'alt' }), false);
    eq(shouldFire({ ...S, modifier: 'alt', held: new Set(['alt']) }), true);
    eq(shouldFire({ ...S, fullscreen: true }), false);
    eq(shouldFire({ ...S, fullscreen: true, overview: true }), true);
});

test('desktop actions: names and when they may run', () => {
    eq(normalizeAction('launchpad'), 'launchpad');
    eq(normalizeAction('quick-note'), 'none');
    eq(actionAllowed('desktop', { overview: false, locked: false }), true);
    eq(actionAllowed('desktop', { overview: false, locked: true }), false);
    eq(actionAllowed('desktop', { overview: true, locked: false }), false);
    eq(actionAllowed('mission-control', { overview: true, locked: false }), true);
    eq(actionAllowed('none', { overview: false, locked: false }), false);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
