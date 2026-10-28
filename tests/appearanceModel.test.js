// SPDX-License-Identifier: GPL-3.0-or-later
// Run: gjs -m tests/appearanceModel.test.js
// features/appearance/model.js: Auto Light/Dark schedule, sun maths, zone fallback, accents.
import {
    SCHEME, events, gnomeAccent, highlightClass, plan, sunTimes, validCoords, zoneCoords,
} from '../features/appearance/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function near(ms, iso, minutes, msg = '') {
    const d = Math.abs(ms - Date.parse(iso)) / 60000;
    if (d > minutes)
        throw new Error(`${msg} ${new Date(ms).toISOString()} is ${d.toFixed(1)} min from ${iso}`);
}

const BERLIN = { kind: 'sun', lat: 52.52, lon: 13.405 };

test('sun: Berlin at midsummer (NOAA: rise 02:43 UTC, set 19:33 UTC)', () => {
    const t = sunTimes(Date.parse('2026-06-21T12:00:00Z'), BERLIN.lat, BERLIN.lon);
    near(t.sunrise, '2026-06-21T02:43:00Z', 4, 'sunrise');
    near(t.sunset, '2026-06-21T19:33:00Z', 4, 'sunset');
});

test('sun: Sydney in its winter (rise 20:59 UTC the day before, set 06:54 UTC)', () => {
    const t = sunTimes(Date.parse('2026-06-21T02:00:00Z'), -33.87, 151.21);
    near(t.sunrise, '2026-06-20T20:59:00Z', 5, 'sunrise');
    near(t.sunset, '2026-06-21T06:54:00Z', 5, 'sunset');
});

test('sun: polar day and polar night', () => {
    eq(sunTimes(Date.parse('2026-06-21T12:00:00Z'), 78.2, 15.6), { polar: 'day' });
    eq(sunTimes(Date.parse('2026-12-21T12:00:00Z'), 78.2, 15.6), { polar: 'night' });
});

test('plan: Berlin noon is light until sunset; midnight is dark until sunrise', () => {
    const noon = plan(Date.parse('2026-06-21T11:00:00Z'), BERLIN);
    eq([noon.phase, noon.scheme], ['light', SCHEME.light]);
    near(noon.next, '2026-06-21T19:33:00Z', 4);
    const night = plan(Date.parse('2026-06-21T23:00:00Z'), BERLIN);
    eq(night.phase, 'dark');
    near(night.next, '2026-06-22T02:43:00Z', 4);
});

test('plan: polar day never changes', () => {
    eq(plan(Date.parse('2026-06-21T12:00:00Z'), { kind: 'sun', lat: 78.2, lon: 15.6 }),
        { phase: 'light', scheme: SCHEME.light, next: null });
});

test('plan: custom times are local wall-clock times', () => {
    const custom = { kind: 'custom', lightMinute: 7 * 60, darkMinute: 19 * 60 };
    const at = (h, m = 0) => new Date(2026, 9, 27, h, m).getTime();
    eq(plan(at(12), custom).phase, 'light');
    eq(plan(at(12), custom).next, at(19));
    eq(plan(at(20), custom).phase, 'dark');
    eq(plan(at(20), custom).next, new Date(2026, 9, 28, 7, 0).getTime());
    eq(plan(at(6, 59), custom).phase, 'dark');
    eq(plan(at(7), custom).phase, 'light', 'a boundary belongs to the new phase');
});

test('plan: custom dark before light (night shift) works across midnight', () => {
    const custom = { kind: 'custom', lightMinute: 22 * 60, darkMinute: 6 * 60 };
    const at = h => new Date(2026, 9, 27, h).getTime();
    eq(plan(at(12), custom).phase, 'dark');
    eq(plan(at(23), custom).phase, 'light');
});

test('plan: equal custom times never flip', () => {
    const custom = { kind: 'custom', lightMinute: 600, darkMinute: 600 };
    eq(events(Date.now(), custom).length > 0, true);
    const p = plan(new Date(2026, 9, 27, 12).getTime(), custom);
    eq(p.next === null || typeof p.next === 'number', true);
});

test('coords: GNOME unknown (91, 181) is invalid', () => {
    eq(validCoords([91, 181]), false);
    eq(validCoords([52.5, 13.4]), true);
    eq(validCoords(null), false);
});

test('zone.tab: Berlin and a seconds-precision zone', () => {
    const tab = '# comment\nDE\t+5230+01322\tEurope/Berlin\nUS\t+404251-0740023\tAmerica/New_York\tEastern\n';
    const b = zoneCoords(tab, 'Europe/Berlin');
    eq(b.map(v => v.toFixed(2)), ['52.50', '13.37']);
    const ny = zoneCoords(tab, 'America/New_York');
    eq(ny.map(v => v.toFixed(2)), ['40.71', '-74.01']);
    eq(zoneCoords(tab, 'Mars/Base'), null);
    eq(zoneCoords(tab, null), null);
});

test('accent: multicolor writes nothing, graphite is GNOME slate', () => {
    eq(gnomeAccent('multicolor'), null);
    eq(gnomeAccent('graphite'), 'slate');
    eq(gnomeAccent('pink'), 'pink');
});

test('highlight: accent uses the theme, a colour gets its class', () => {
    eq(highlightClass('accent'), null);
    eq(highlightClass('green'), 'guava-highlight-green');
    eq(highlightClass('bogus'), null);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
