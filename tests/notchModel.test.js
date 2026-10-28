// Run: gjs -m tests/notchModel.test.js
import {
    KINDS, activityTiming, rankActivities, pillActivity, nextActivityExpiry, detectCode, addToShelf,
    removeFromShelf, parseUriList, parseGnomeCopiedFiles, parsePlainFiles, displayName, batteryChange,
    UPOWER, connectedHeadphones, newlyConnected, downloadSummary, formatBytes, nextEvent, minutesUntil,
    formatCountdown, formatElapsed, tabDirection, nowRows, pillWidth, SHELF_LIMIT, DROP_FILE_TYPES, inDropZone,
    dropZone,
} from '../features/notch/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const act = (key, kind, at) => ({ key, kind, at, ...activityTiming(kind, at) });

test('every kind has a priority; unknown kinds throw', () => {
    for (const [k, v] of Object.entries(KINDS))
        eq(typeof v.priority, 'number', k);
    let threw = false;
    try { activityTiming('nope', 0); } catch (_e) { threw = true; }
    eq(threw, true);
});
test('pill priority: recording > timer > media > download > event; quiet ones never', () => {
    const list = [act('m', 'media', 5), act('d', 'download', 6), act('e', 'event-soon', 7), act('t', 'timer', 1),
        act('r', 'recording', 0), act('c', 'charging', 9)];
    eq(pillActivity(list, 10).key, 'r');
    eq(pillActivity(list.filter(a => a.key !== 'r'), 10).key, 't');
    eq(pillActivity(list.filter(a => !['r', 't'].includes(a.key)), 10).key, 'm');
    eq(pillActivity([act('c', 'charging', 0), act('h', 'headphones', 0), act('ev', 'event', 0)], 10), null);
    eq(rankActivities([act('c', 'charging', 0), act('h', 'headphones', 0)], 10).map(a => a.key), ['c', 'h']);
});
test('alerts preempt for their time, then step back', () => {
    const list = [act('r', 'recording', 0), act('code', 'code', 1000)];
    eq(pillActivity(list, 2000).key, 'code');
    eq(nextActivityExpiry(list, 2000), 31000);
    eq(pillActivity(list, 31000).key, 'r');
    eq(nextActivityExpiry(list, 31000), null);
});
test('same priority: newest wins', () => {
    eq(pillActivity([act('a', 'charging-started', 0), act('b', 'headphones-connected', 100)], 200).key, 'b');
});
test('pill widths', () => {
    eq(pillWidth('code'), 300);
    eq(pillWidth('media'), 250);
});
test('codes: found with a keyword', () => {
    eq(detectCode('Your code is 482913'), '482913');
    eq(detectCode('482913 is your verification code'), '482913');
    eq(detectCode('Use 482 913 to sign in'), '482913');
    eq(detectCode('G-482913 is your Google verification code.'), '482913');
    eq(detectCode('Tu código: 7781'), '7781');
    eq(detectCode('<b>OTP</b> 55120983'), '55120983');
});
test('codes: no keyword, amounts, times, years, long numbers, two candidates', () => {
    eq(detectCode('Meeting at 1400 in room 482913'), null);
    eq(detectCode('Your code costs $4829'), null);
    eq(detectCode('Login at 12:30'), null);
    eq(detectCode('Security update 2024'), null);
    eq(detectCode('Your code is 4829131234567'), null);
    eq(detectCode('Code 1234 or code 5678'), null);
    eq(detectCode('Order code 12.50%'), null);
    eq(detectCode(''), null);
    eq(detectCode(null), null);
});
test('shelf: newest first, dedupe, cap, only links', () => {
    let s = addToShelf([], ['file:///a', 'file:///b']);
    s = addToShelf(s, ['file:///c', 'file:///a', 'not a uri']);
    eq(s, ['file:///c', 'file:///a', 'file:///b']);
    eq(removeFromShelf(s, 'file:///a'), ['file:///c', 'file:///b']);
    const many = Array.from({ length: 40 }, (_, i) => `file:///f${i}`);
    eq(addToShelf([], many).length, SHELF_LIMIT);
});
test('clipboard formats', () => {
    eq(parseUriList('# c\r\nfile:///a%20b\r\nfile:///c\r\n'), ['file:///a%20b', 'file:///c']);
    eq(parseGnomeCopiedFiles('copy\nfile:///a\nfile:///b'), ['file:///a', 'file:///b']);
    eq(parseGnomeCopiedFiles('file:///a'), []);
    eq(parsePlainFiles('/home/u/My File.txt'), ['file:///home/u/My%20File.txt']);
    eq(parsePlainFiles('hello world'), []);
    eq(parsePlainFiles('/a\nhello'), []);
    eq(displayName('file:///home/u/My%20File.pdf'), 'My File.pdf');
    eq(displayName('file:///home/u/dir/'), 'dir');
});
test('battery: plugged in, low crossing, not present', () => {
    const d = (state, percentage) => ({ present: true, state, percentage });
    eq(batteryChange(d(UPOWER.CHARGING, 50), d(UPOWER.DISCHARGING, 50)).pluggedIn, true);
    eq(batteryChange(d(UPOWER.CHARGING, 50), null).pluggedIn, false, 'not at start');
    eq(batteryChange(d(UPOWER.DISCHARGING, 19.6), d(UPOWER.DISCHARGING, 20.4)).low, true);
    eq(batteryChange(d(UPOWER.DISCHARGING, 19), d(UPOWER.DISCHARGING, 19.6)).low, false);
    eq(batteryChange(d(UPOWER.DISCHARGING, 9.5), d(UPOWER.DISCHARGING, 10.2)).low, true);
    eq(batteryChange({ present: false }, null), null);
    eq(batteryChange(d(UPOWER.FULL, 100), null).charging, true);
});
test('headphones', () => {
    const devs = [{ path: '/b', name: 'Kbd', icon: 'input-keyboard', connected: true },
        { path: '/a', name: 'Studio', icon: 'audio-headphones', connected: true, battery: 80 },
        { path: '/c', name: 'Buds', icon: 'audio-headset', connected: false }];
    eq(connectedHeadphones(devs).map(d => d.name), ['Studio']);
    eq(newlyConnected([], connectedHeadphones(devs)).length, 1);
    eq(newlyConnected(connectedHeadphones(devs), connectedHeadphones(devs)).length, 0);
});
test('downloads', () => {
    eq(downloadSummary([], []), null);
    eq(downloadSummary([{ appId: 'firefox', progress: 0.5 }], [{ name: 'iso.img.part', bytes: 9 }]),
        { label: 'iso.img', fraction: 0.5, bytes: null, count: 1 });
    eq(downloadSummary([{ appId: 'x', progress: 1 }], [{ name: 'a.crdownload', bytes: 2000 }]),
        { label: 'a', fraction: null, bytes: 2000, count: 1 });
    eq(formatBytes(740000), '740 KB');
    eq(formatBytes(12400000), '12.4 MB');
    eq(formatBytes(512), '512 B');
});
test('next event', () => {
    const now = 1000 * 3600 * 100;
    const ev = (id, startMin, endMin, allDay = false) => ({ id, summary: id, start: now + startMin * 60000, end: now + endMin * 60000, allDay });
    eq(nextEvent([ev('later', 120, 180), ev('soon', 10, 40), ev('all', -60, 2000, true)], now).event.id, 'soon');
    eq(nextEvent([ev('soon', 10, 40)], now).soon, true);
    eq(nextEvent([ev('later', 120, 180)], now).soon, false);
    eq(nextEvent([ev('now', -5, 25)], now).ongoing, true);
    eq(nextEvent([ev('past', -60, -1), ev('far', 3000, 3100)], now), null);
    eq(minutesUntil(now + 61000, now), 2);
    eq(minutesUntil(now - 1, now), 0);
});
test('countdowns and tabs', () => {
    eq(formatCountdown(245000), '4:05');
    eq(formatCountdown(200), '0:01');
    eq(formatCountdown(3723000), '1:02:03');
    eq(formatElapsed(42900), '0:42');
    eq(tabDirection('now', 'widgets'), 1);
    eq(tabDirection('widgets', 'tray'), -1);
    eq(tabDirection('now', 'now'), 0);
    eq(nowRows(1, 1), { activities: 1, notifications: 1, more: 0 });
    eq(nowRows(1, 5), { activities: 1, notifications: 1, more: 4 });
    eq(nowRows(0, 2), { activities: 0, notifications: 2, more: 0 });
    eq(nowRows(4, 2), { activities: 3, notifications: 0, more: 2 });
});
test('drop: uri-list first, the zone grows around a small pill', () => {
    eq(DROP_FILE_TYPES[0][0], 'text/uri-list');
    eq(DROP_FILE_TYPES[0][1]('file:///etc/hostname\r\n'), ['file:///etc/hostname']);
    const z = dropZone({ x: 545, y: 0, w: 190, h: 32 }, { x: 0, y: 0, width: 1280 });
    eq(z, { x: 430, y: 0, w: 420, h: 72 });
    eq(inDropZone(z, 640, 16), true);
    eq(inDropZone(z, 640, 80), false);
    eq(inDropZone(null, 1, 1), false);
    const open = dropZone({ x: 316, y: 0, w: 648, h: 192 }, { x: 0, y: 0, width: 1280 });
    eq(open, { x: 300, y: 0, w: 680, h: 208 });
});
if (failed) { print(`${failed} failed`); imports.system.exit(1); }
