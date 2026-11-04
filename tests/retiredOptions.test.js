// Run: gjs -m tests/retiredOptions.test.js
// lib/retiredOptions.js: the options without a switch are reset once.
import { RETIRED, retireOptions } from '../src/lib/retiredOptions.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const fake = (rev = 0) => {
    const resets = [];
    let r = rev;
    return { resets, get_int: () => r, set_int: (_k, v) => { r = v; }, reset: k => resets.push(k) };
};

test('first start after the change: every retired option reset, once', () => {
    const s = fake();
    eq(retireOptions(s), RETIRED);
    eq(s.resets, RETIRED);
    eq(retireOptions(s), [], 'second start: nothing');
    eq(s.resets.length, RETIRED.length);
});

test('already done: nothing touched', () => {
    const s = fake(1);
    eq(retireOptions(s), []);
    eq(s.resets, []);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
