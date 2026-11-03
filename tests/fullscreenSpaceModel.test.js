// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
// Run: gjs -m tests/fullscreenSpaceModel.test.js
import {
    isolateDecision, planTarget, trailingToAppend, canRemove, sweepList, indexAfterRemoval,
    restoreIndex, shouldRedirectNewWindow, reviveSnapshot, lastOccupied,
} from '../src/features/fullscreenSpace/model.js';

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

test('isolateDecision: sticky skips; first workspace always moves; a later one only if shared', () => {
    eq(isolateDecision({ index: 0, others: 0, sticky: true }), 'skip');
    eq(isolateDecision({ index: 0, others: 0, sticky: false }), 'move');
    eq(isolateDecision({ index: 2, others: 1, sticky: false }), 'move');
    eq(isolateDecision({ index: 2, others: 0, sticky: false }), 'alone');
});

test('planTarget: empty right neighbour is used', () => {
    eq(planTarget({ index: 0, occupied: [true, false, false] }), { kind: 'use', target: 1 });
});

test('planTarget: last workspace appends one', () => {
    eq(planTarget({ index: 1, occupied: [true, true] }), { kind: 'append', target: 2 });
});

test('planTarget: occupied neighbour shifts the occupied ones right, last first', () => {
    eq(planTarget({ index: 0, occupied: [true, true, false] }),
        { kind: 'shift', target: 1, moves: [1], append: false });
    eq(planTarget({ index: 0, occupied: [true, true, true] }),
        { kind: 'shift', target: 1, moves: [2, 1], append: true });
    eq(planTarget({ index: 0, occupied: [true, true, false, true] }),
        { kind: 'shift', target: 1, moves: [3, 1], append: true });
});

test('planTarget: the limit aborts', () => {
    eq(planTarget({ index: 1, occupied: [true, true], max: 2 }), { kind: 'abort' });
    eq(planTarget({ index: 0, occupied: [true, true], max: 2 }), { kind: 'abort' });
    eq(planTarget({ index: 0, occupied: [true, false], max: 2 }), { kind: 'use', target: 1 });
});

test('trailingToAppend: at least two, one empty after the last occupied', () => {
    eq(trailingToAppend({ occupied: [false] }), 1);
    eq(trailingToAppend({ occupied: [true, false] }), 0);
    eq(trailingToAppend({ occupied: [true, true] }), 1);
    eq(trailingToAppend({ occupied: [true, false, true] }), 1);
    eq(trailingToAppend({ occupied: [true, true], max: 2 }), 0);
});

test('canRemove: not first, not active, not occupied, not the trailing empty one, not below two', () => {
    const occ = [true, false, true, false, false];
    eq(canRemove({ index: 0, occupied: occ, active: 2 }), false);
    eq(canRemove({ index: 1, occupied: occ, active: 2 }), true);
    eq(canRemove({ index: 1, occupied: occ, active: 1 }), false);
    eq(canRemove({ index: 2, occupied: occ, active: 0 }), false);
    eq(canRemove({ index: 3, occupied: occ, active: 0 }), false);
    eq(canRemove({ index: 4, occupied: occ, active: 0 }), true);
    eq(canRemove({ index: 1, occupied: [true, false], active: 0 }), false);
});

test('sweepList: highest first, keeps the trailing empty and the active', () => {
    eq(sweepList({ occupied: [true, false, true, false, false, false], active: 4 }), [5, 1]);
    eq(sweepList({ occupied: [true, false], active: 0 }), []);
});

test('indexAfterRemoval and restoreIndex', () => {
    eq(indexAfterRemoval(3, 1), 2);
    eq(indexAfterRemoval(1, 1), 1);
    eq(indexAfterRemoval(0, 1), 0);
    eq(restoreIndex(5, 3), 2);
    eq(restoreIndex(1, 3), 1);
    eq(restoreIndex(undefined, 3), 0);
    eq(restoreIndex(-2, 3), 0);
});

test('shouldRedirectNewWindow: dialogs of the full-screen app stay', () => {
    const base = { fullscreen: false, skips: false, sharesSpaceWithFullscreen: true, belongsToApp: false };
    eq(shouldRedirectNewWindow(base), true);
    eq(shouldRedirectNewWindow({ ...base, belongsToApp: true }), false);
    eq(shouldRedirectNewWindow({ ...base, fullscreen: true }), false);
    eq(shouldRedirectNewWindow({ ...base, skips: true }), false);
    eq(shouldRedirectNewWindow({ ...base, sharesSpaceWithFullscreen: false }), false);
});

test('reviveSnapshot: vanished or out of range dropped, still full screen kept isolated', () => {
    const saved = [{ id: 1, home: 0, space: 1 }, { id: 2, home: 0, space: 2 }, { id: 3, home: 1, space: 2 }, { id: 4, home: 0, space: 1 }];
    const live = new Map([
        [1, { index: 1, fullscreen: true }],
        [2, { index: 2, fullscreen: false }],
        [3, { index: 9, fullscreen: true }],
    ]);
    eq(reviveSnapshot(saved, live, 4), {
        isolated: [{ id: 1, home: 0, space: 1 }],
        restore: [{ id: 2, home: 0, space: 2 }],
    });
});

test('lastOccupied', () => {
    eq(lastOccupied([false, false]), -1);
    eq(lastOccupied([true, false, true, false]), 2);
});

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
