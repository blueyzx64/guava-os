// Run: gjs -m tests/panelLayoutModel.test.js
import { targetIndex } from '../core/panelLayoutModel.js';

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

const keys = ['activities', null, 'window-title'];

test('first', () => eq(targetIndex(keys, { first: true }), 0));
test('last is default', () => eq(targetIndex(keys), 3));
test('last explicit', () => eq(targetIndex(keys, { last: true }), 3));
test('before a present neighbour', () => eq(targetIndex(keys, { before: ['window-title'] }), 2));
test('before the first of several matches', () =>
    eq(targetIndex(keys, { before: ['window-title', 'activities'] }), 0));
test('before a missing neighbour falls back to last', () =>
    eq(targetIndex(keys, { before: ['nope'] }), 3));
test('before a missing neighbour, fallback first', () =>
    eq(targetIndex(keys, { before: ['nope'], fallback: 'first' }), 0));
test('after a present neighbour', () => eq(targetIndex(keys, { after: ['activities'] }), 1));
test('after takes the last match', () =>
    eq(targetIndex(keys, { after: ['activities', 'window-title'] }), 3));
test('after missing falls back', () => eq(targetIndex(keys, { after: ['x'], fallback: 'first' }), 0));
test('unnamed children never match', () => eq(targetIndex([null, null], { before: ['x'] }), 2));
test('empty box', () => eq(targetIndex([], { before: ['x'] }), 0));

test('right box: lock first, media right after it, whatever the enable order', () => {
    const lock = { first: true };
    const media = { after: ['lock-indicator'], fallback: 'first' };
    // media enabled first, no lock yet: leftmost
    eq(targetIndex(['a11y', 'quickSettings'], media), 0);
    // lock arrives: it goes first, media (re-placed) sits right behind it
    eq(targetIndex(['guava-media', 'a11y', 'quickSettings'], lock), 0);
    eq(targetIndex(['lock-indicator', 'a11y', 'quickSettings'], media), 1);
    // lock enabled first, media later: same result
    eq(targetIndex(['lock-indicator', 'a11y', 'quickSettings'], media), 1);
});

if (failed)
    throw new Error(`${failed} failed`);
