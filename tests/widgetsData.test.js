// Run: gjs -m tests/widgetsData.test.js
import {
    handAngles, msToNextMinute, offsetLabel, cityFromTimezone, worldLabel, highLow, upcomingEvents, monthGrid, batteryList, batteryLevel,
    parseCpu, cpuUsage, parseMemory, formatBytes, mediaState,
} from '../core/widgets/data.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('clock hands and the minute tick', () => {
    eq(handAngles(3, 0), { hour: 90, minute: 0 });
    eq(handAngles(15, 30), { hour: 105, minute: 180 });
    eq(msToNextMinute(0), 60000);
    eq(msToNextMinute(59, 500), 1000);
    eq(msToNextMinute(30, 250), 29750);
});
test('world clock offsets', () => {
    eq(offsetLabel(0), 'Same time');
    eq(offsetLabel(3 * 3600), '+3h');
    eq(offsetLabel(-5.5 * 3600), '−5h 30m');
});
test('upcoming events: past dropped, all-day first in its day, limited', () => {
    const now = new Date(2026, 9, 27, 12, 0);
    const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);
    const ev = [
        { id: 'past', summary: 'Gone', date: at(27, 9), end: at(27, 10) },
        { id: 'late', summary: 'Late', date: at(27, 18), end: at(27, 19) },
        { id: 'now', summary: 'Now', date: at(27, 11), end: at(27, 13) },
        { id: 'all', summary: 'Holiday', date: at(27, 0), end: at(28, 0) },
        { id: 'tmr', summary: 'Tomorrow', date: at(28, 9), end: at(28, 10) },
        { id: 'bad', summary: 'x', date: 'nope', end: at(28, 10) },
    ];
    const out = upcomingEvents(ev, now, 10);
    eq(out.map(e => e.id), ['all', 'now', 'late', 'tmr']);
    eq(out[0].allDay, true);
    eq(out[3].today, false);
    eq(upcomingEvents(ev, now, 2).length, 2);
    eq(upcomingEvents(null, now, 2), []);
});
test('month grid starts on the week start and marks today', () => {
    const today = new Date(2026, 9, 27);
    const g = monthGrid(2026, 9, today, 1); // October 2026 starts on a Thursday
    eq(g[0].slice(0, 4).map(d => d.inMonth), [false, false, false, true]);
    eq(g[0][3].day, 1);
    const flat = g.flat();
    eq(flat.filter(d => d.today).length, 1);
    eq(flat.filter(d => d.inMonth).length, 31);
    for (const w of g)
        eq(w.length, 7);
});
test('battery list: laptop first, then devices by name; no line power', () => {
    const list = batteryList([
        { path: 'ac', type: 1, percentage: 0 },
        { path: 'mouse', type: 5, percentage: 42.4, state: 2, model: 'Mouse' },
        { path: 'bat', type: 2, percentage: 64, state: 1, model: 'BAT0', powerSupply: true, isPresent: true },
        { path: 'kbd', type: 6, percentage: 90, state: 2, model: 'Keyboard' },
        { path: 'gone', type: 2, percentage: 0, isPresent: false, powerSupply: true },
        { path: 'nan', type: 17, percentage: undefined },
    ]);
    eq(list.map(b => b.path), ['bat', 'kbd', 'mouse']);
    eq(list[0].name, 'This Computer');
    eq(list[0].charging, true);
    eq(list[2].percent, 42);
    eq(list[2].icon, 'input-mouse-symbolic');
    eq([batteryLevel(5, false), batteryLevel(15, false), batteryLevel(50, false), batteryLevel(5, true)],
        ['critical', 'low', 'normal', 'charging']);
});
test('cpu and memory parsing', () => {
    const a = parseCpu('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4');
    const b = parseCpu('cpu  150 0 150 900 0 0 0 0 0 0\n');
    eq(a, { idle: 800, total: 1000 });
    eq(cpuUsage(a, b), 0.5);
    eq(cpuUsage(null, b), 0);
    eq(cpuUsage(b, a), 0);
    eq(parseCpu('garbage'), null);
    eq(parseMemory('MemTotal:  8000000 kB\nMemFree: 1 kB\nMemAvailable:  2000000 kB\n'), { used: 6000000 * 1024, total: 8000000 * 1024 });
    eq(parseMemory('MemTotal: 1 kB'), null);
    eq(formatBytes(3.24 * 1024 ** 3), '3.2 GB');
    eq(formatBytes(15.6 * 1024 ** 3), '16 GB');
});
test('media state', () => {
    eq(mediaState(null).has, false);
    const m = mediaState({ trackTitle: 'T', trackArtists: ['A', '', 'B'], status: 'Playing', canGoNext: true, appName: 'X' });
    eq([m.has, m.playing, m.title, m.artist, m.canNext, m.canPrev], [true, true, 'T', 'A, B', true, false]);
});

test('a time zone names its city', () => {
    eq(cityFromTimezone('Europe/Riga'), 'Riga');
    eq(cityFromTimezone('America/New_York'), 'New York');
    eq(cityFromTimezone('America/Argentina/Buenos_Aires'), 'Buenos Aires');
    eq(cityFromTimezone('UTC'), '');
    eq(cityFromTimezone(null), '');
});

test('a world clock says the day and the hours ahead', () => {
    eq(worldLabel(0, 0), 'Today, Same time');
    eq(worldLabel(1, 13 * 3600), 'Tomorrow, +13h');
    eq(worldLabel(-1, -5 * 3600 - 1800), 'Yesterday, −5h 30m');
});

test('high and low come from the forecast, or are left out', () => {
    eq(highLow([{ temp: '18°C' }, { temp: '21 °C' }, { temp: '12°C' }]), 'H:21° L:12°');
    eq(highLow([{ temp: '-3°C' }, { temp: '1°C' }]), 'H:1° L:-3°');
    eq(highLow([{ temp: '18°C' }]), '');
    eq(highLow([]), '');
    eq(highLow(null), '');
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
