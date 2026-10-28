// Run: gjs -m tests/modalLook.test.js
import { FROM_SCALE, HIDE_MS, SHOW_MS, frameClasses, motionFor } from '../lib/modalLook.js';

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

test('dark and light frames', () => {
    eq(frameClasses({ dark: true }).join(' '), 'guava-modal guava-modal-dark');
    eq(frameClasses({ dark: false }).join(' '), 'guava-modal guava-modal-light');
});

test('high contrast makes the frame opaque', () => {
    eq(frameClasses({ dark: true, highContrast: true }).join(' '), 'guava-modal guava-modal-dark guava-modal-opaque');
});

test('show scales up from 0.96 and fades in', () => {
    const m = motionFor('show');
    eq(m.duration, SHOW_MS);
    eq(m.scaleFrom, FROM_SCALE);
    eq(m.scaleTo, 1);
    eq(m.opacityFrom, 0);
    eq(m.opacityTo, 255);
});

test('hide scales down and fades out', () => {
    const m = motionFor('hide');
    eq(m.duration, HIDE_MS);
    eq(m.scaleFrom, 1);
    eq(m.scaleTo, FROM_SCALE);
    eq(m.opacityTo, 0);
});

test('reduced motion keeps the fade only', () => {
    const m = motionFor('show', { reducedMotion: true });
    eq(m.duration, SHOW_MS);
    eq(m.scaleFrom, 1);
    eq(m.scaleTo, 1);
    eq(m.opacityFrom, 0);
});

test('animations off is instant', () => {
    eq(motionFor('show', { animations: false }).duration, 0);
    eq(motionFor('hide', { animations: false }).duration, 0);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
