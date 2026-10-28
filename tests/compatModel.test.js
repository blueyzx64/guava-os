// Run: gjs -m tests/compatModel.test.js
import { pickReducedMotionSource, readReducedMotion, reducedMotionSignal } from '../lib/compatModel.js';

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

// Stub Gio.Settings: an enum key is only readable as a string, like the real one
// (get_boolean on it is a GLib critical and reads false).
function stubSettings(values) {
    return {
        get_string: k => {
            if (typeof values[k] !== 'string')
                throw new Error(`${k} is not a string key`);
            return values[k];
        },
        get_boolean: k => {
            if (typeof values[k] !== 'boolean')
                throw new Error(`${k} is not a boolean key`);
            return values[k];
        },
    };
}

test('source order: St, then a11y enum, then enable-animations', () => {
    eq(pickReducedMotionSource({ st: true, a11y: true, iface: true }), 'st');
    eq(pickReducedMotionSource({ st: false, a11y: true, iface: true }), 'a11y');
    eq(pickReducedMotionSource({ st: false, a11y: false, iface: true }), 'iface');
    eq(pickReducedMotionSource({ st: false, a11y: false, iface: false }), null);
});

test('a11y reduced-motion is an enum: reduce -> true, no-preference -> false', () => {
    eq(readReducedMotion('a11y', stubSettings({ 'reduced-motion': 'reduce' })), true);
    eq(readReducedMotion('a11y', stubSettings({ 'reduced-motion': 'no-preference' })), false);
});

test('enable-animations is inverted', () => {
    eq(readReducedMotion('iface', stubSettings({ 'enable-animations': false })), true);
    eq(readReducedMotion('iface', stubSettings({ 'enable-animations': true })), false);
});

test('St.Settings reduced_motion compared with the REDUCE value', () => {
    eq(readReducedMotion('st', { reduced_motion: 1 }, 1), true);
    eq(readReducedMotion('st', { reduced_motion: 0 }, 1), false);
});

test('no source reads false; signals match the source', () => {
    eq(readReducedMotion(null, null), false);
    eq(reducedMotionSignal('st'), 'notify::reduced-motion');
    eq(reducedMotionSignal('a11y'), 'changed::reduced-motion');
    eq(reducedMotionSignal('iface'), 'changed::enable-animations');
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
