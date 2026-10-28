// Run: gjs -m tests/keybindingsModel.test.js
import { BindingTable, KNOWN_DEFAULTS, findConflicts, normalizeAccel } from '../lib/keybindingsModel.js';

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
function eq(a, b, msg = '') {
    if (a !== b)
        throw new Error(`${msg} expected ${b}, got ${a}`);
}

test('normalizeAccel orders modifiers and lowercases', () => {
    eq(normalizeAccel('<Shift><Super>V'), '<super><shift>v');
    eq(normalizeAccel('<Super><Shift>v'), '<super><shift>v');
    eq(normalizeAccel('<Primary><Alt>Delete'), '<ctrl><alt>delete');
    eq(normalizeAccel('<Super>space'), '<super>space');
});

test('normalizeAccel rejects junk', () => {
    eq(normalizeAccel(''), '');
    eq(normalizeAccel('<Super>'), '');
    eq(normalizeAccel('<Bogus>a'), '');
    eq(normalizeAccel(null), '');
    eq(normalizeAccel('a b'), '');
});

test('findConflicts matches regardless of spelling', () => {
    const c = findConflicts(['<Shift><Super>space', '<Super><Shift>v'], KNOWN_DEFAULTS);
    eq(c.length, 0, 'shift+super+space not stock');
    const d = findConflicts(['<Super>V'], KNOWN_DEFAULTS);
    eq(d.length, 1);
    eq(d[0].with.includes('toggle-message-tray'), true);
});

test('Super+Shift+V is not a stock accelerator', () => {
    eq(findConflicts(['<Super><Shift>v'], KNOWN_DEFAULTS).length, 0);
});

test('BindingTable refuses double claim and frees on release', () => {
    const t = new BindingTable();
    eq(t.claim('a'), true);
    eq(t.claim('a'), false);
    eq(t.release('a'), true);
    eq(t.claim('a'), true);
    eq(t.names().join(), 'a');
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
