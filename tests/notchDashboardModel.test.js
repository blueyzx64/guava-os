// Run: gjs -m tests/notchDashboardModel.test.js
import {
    cardSize, formatTrackTime, trackProgress, seekTarget, formatClock, DASH_SIZE,
} from '../features/notch/dashboardModel.js';

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

test('track times: m:ss, h:mm:ss, unknown', () => {
    eq(formatTrackTime(0), '0:00');
    eq(formatTrackTime(5_400_000), '0:05');
    eq(formatTrackTime(83_999_999), '1:23');
    eq(formatTrackTime(3_725_000_000), '1:02:05');
    eq(formatTrackTime(NaN), '');
    eq(formatTrackTime(-1), '');
    eq(formatTrackTime(null), '');
});

test('progress needs a length and a position', () => {
    eq(trackProgress(null, 200e6), null);
    eq(trackProgress(10e6, null), null);
    eq(trackProgress(10e6, 0), null);
    eq(trackProgress(50e6, 200e6), { fraction: 0.25, elapsed: '0:50', remaining: '-2:30' });
});

test('progress clamps a position past the end', () => {
    eq(trackProgress(300e6, 200e6), { fraction: 1, elapsed: '3:20', remaining: '-0:00' });
});

test('clock: 24h pads the hour, 12h has a suffix and no 0', () => {
    eq(formatClock(7, 5, '24h'), { time: '07:05', suffix: '' });
    eq(formatClock(0, 0, '12h'), { time: '12:00', suffix: 'AM' });
    eq(formatClock(12, 30, '12h'), { time: '12:30', suffix: 'PM' });
    eq(formatClock(23, 9, '12h'), { time: '11:09', suffix: 'PM' });
});

test('one expanded size for every tab, on the 4px grid', () => {
    eq(DASH_SIZE.w % 4, 0);
    eq(DASH_SIZE.h % 4, 0);
    eq(DASH_SIZE.w, 340 + 248 + 20 + 2 * 20);
});

test('card: taller only with actions', () => {
    eq(cardSize({ actions: false }).h < cardSize({ actions: true }).h, true);
    eq(cardSize({ actions: true }).w, cardSize({ actions: false }).w);
});

test('seekTarget: clamps the fraction, needs a length', () => {
    eq(seekTarget(0.5, 200e6), 100e6);
    eq(seekTarget(-0.2, 200e6), 0);
    eq(seekTarget(1.7, 200e6), 200e6);
    eq(seekTarget(0.333, 34_000_000), 11_322_000);
    eq(seekTarget(0.5, null), null);
    eq(seekTarget(0.5, 0), null);
    eq(seekTarget(NaN, 200e6), null);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
