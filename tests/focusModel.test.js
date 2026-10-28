// Run: gjs -m tests/focusModel.test.js
import {
    BUILT_IN, HOUR_MS, URGENCY_CRITICAL, allows, automatic, choose, customId, evaluate, nextEdge,
    normalizeAppId, parseProfiles, parseState, scheduleActive, serializeProfiles, serializeState,
    textToMinutes, minutesToText, toggleApp, untilTomorrow,
} from '../features/focus/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// A fake clock: local wall times. 2026-10-26 is a Monday.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
const MON = 26, TUE = 27, SAT = 31, SUN = 25;
const withSleep = schedule => {
    const profiles = parseProfiles('');
    profiles.find(p => p.id === 'sleep').schedules = [schedule];
    return profiles;
};

test('defaults: four built-ins, all off (no apps, no schedules, no triggers)', () => {
    const p = parseProfiles('');
    eq(p.map(x => x.id), BUILT_IN.map(x => x.id));
    eq(p.every(x => !x.allowedApps.length && !x.schedules.length && !x.appTriggers.length && x.allowTimeSensitive), true);
    eq(serializeProfiles(p), '', 'defaults store nothing');
    eq(evaluate({ profiles: p, manual: null, now: at(MON, 12), openApps: [] }).active, null);
});
test('profiles: bad JSON and bad schedules fall back; customs kept; built-in names fixed', () => {
    eq(parseProfiles('{oops').length, 4);
    const p = parseProfiles(JSON.stringify([
        { id: 'work', name: 'Hacked', allowedApps: ['Org.Gnome.Calendar.desktop', 'org.gnome.calendar'],
            schedules: [{ days: [1, 9], start: 540, end: 1020 }, { days: [1], start: 60, end: 60 }] },
        { id: 'custom-gym', name: ' Gym ', icon: 'emblem-favorite-symbolic' },
    ]));
    const work = p.find(x => x.id === 'work');
    eq(work.name, 'Work');
    eq(work.allowedApps, ['org.gnome.calendar']);
    eq(work.schedules, [{ days: [1], start: 540, end: 1020 }]);
    eq(p[4].name, 'Gym');
    eq(parseProfiles(serializeProfiles(p)), p, 'round trip');
});
test('custom ids are unique', () => {
    const p = parseProfiles(JSON.stringify([{ id: 'custom-gym', name: 'Gym' }]));
    eq(customId(p, 'Gym'), 'custom-gym-2');
    eq(customId(p, 'Deep Work!'), 'custom-deep-work');
});
test('state: parse and serialize', () => {
    eq(parseState(''), null);
    eq(parseState('nope'), null);
    eq(parseState('{"id":"work","until":5}'), { id: 'work', until: 5 });
    eq(parseState('{"id":null}'), { id: null, until: 0 });
    eq(parseState(serializeState({ id: 'dnd', until: 0 })), { id: 'dnd', until: 0 });
});
test('schedule: same-day window, by weekday', () => {
    const s = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };
    eq(scheduleActive(s, new Date(at(MON, 9))), true);
    eq(scheduleActive(s, new Date(at(MON, 16, 59))), true);
    eq(scheduleActive(s, new Date(at(MON, 17))), false);
    eq(scheduleActive(s, new Date(at(SAT, 10))), false);
});
test('schedule: overnight window belongs to the day it starts', () => {
    const s = { days: [0], start: 22 * 60, end: 7 * 60 };     // Sunday night
    eq(scheduleActive(s, new Date(at(SUN, 23))), true);
    eq(scheduleActive(s, new Date(at(MON, 6, 30))), true, 'Monday morning still Sunday night');
    eq(scheduleActive(s, new Date(at(MON, 23))), false, 'Monday night not scheduled');
    eq(scheduleActive(s, new Date(at(SUN, 6))), false, 'Sunday morning is Saturday night');
});
test('evaluate with a fake clock: Sleep turns on and off by schedule', () => {
    const profiles = withSleep({ days: [0, 1, 2, 3, 4, 5, 6], start: 22 * 60 + 30, end: 7 * 60 });
    const run = now => evaluate({ profiles, manual: null, now, openApps: [] });
    eq(run(at(MON, 22)).active, null);
    eq(run(at(MON, 22, 30)).active, { id: 'sleep', reason: 'schedule' });
    eq(run(at(MON, 23)).until, at(TUE, 7), 'ends at 07:00');
    eq(run(at(TUE, 7)).active, null);
    eq(nextEdge(profiles, null, at(MON, 12)), at(MON, 22, 30), 'next timer at the start');
    eq(nextEdge(profiles, null, at(MON, 23)), at(TUE, 7), 'then at the end');
});
test('evaluate: adjacent schedules of one mode join', () => {
    const profiles = parseProfiles('');
    profiles[2].schedules = [{ days: [1], start: 540, end: 720 }, { days: [1], start: 720, end: 1020 }];
    eq(automatic(profiles, at(MON, 10), []).endsAt, at(MON, 17));
});
test('evaluate: manual for 1 hour expires; manual beats schedule', () => {
    const profiles = withSleep({ days: [1], start: 600, end: 720 });
    const manual = choose(null, 'work', HOUR_MS, at(MON, 9), false);
    eq(manual, { id: 'work', until: at(MON, 10) });
    eq(evaluate({ profiles, manual, now: at(MON, 9, 30), openApps: [] }).active, { id: 'work', reason: 'manual' });
    const after = evaluate({ profiles, manual, now: at(MON, 10, 5), openApps: [] });
    eq(after.manual, null, 'expired choice dropped');
    eq(after.active, { id: 'sleep', reason: 'schedule' });
    eq(nextEdge(profiles, manual, at(MON, 9)), at(MON, 10));
});
test('evaluate: turning off during a schedule stays off until it ends', () => {
    const profiles = withSleep({ days: [1], start: 600, end: 720 });
    const before = evaluate({ profiles, manual: null, now: at(MON, 10, 30), openApps: [] });
    const off = choose(before.active, null, 0, at(MON, 10, 30), true);
    eq(off, { id: null, until: 0 });
    eq(evaluate({ profiles, manual: off, now: at(MON, 11), openApps: [] }).active, null);
    const later = evaluate({ profiles, manual: off, now: at(MON, 12, 1), openApps: [] });
    eq(later.manual, null, 'override gone once the schedule is over');
    eq(choose({ id: 'work' }, null, 0, at(MON, 9), false), null, 'plain off clears');
});
test('evaluate: app trigger wins over schedule; removed modes drop', () => {
    const profiles = withSleep({ days: [1], start: 600, end: 720 });
    profiles.find(p => p.id === 'work').appTriggers = ['org.gnome.texteditor'];
    eq(evaluate({ profiles, manual: null, now: at(MON, 11), openApps: ['org.gnome.TextEditor.desktop'] }).active,
        { id: 'work', reason: 'app' });
    eq(evaluate({ profiles, manual: { id: 'custom-x', until: 0 }, now: at(MON, 9), openApps: [] }).active, null);
});
test('allows: allowed apps pass, others silenced, critical breaks through', () => {
    const p = parseProfiles('')[2];
    p.allowedApps = ['org.gnome.calendar'];
    eq(allows(null, { appId: 'x', urgency: 1 }), true, 'no Focus');
    eq(allows(p, { appId: 'org.gnome.Calendar.desktop', urgency: 1 }), true);
    eq(allows(p, { appId: 'org.gnome.Nautilus', urgency: 2 }), false);
    eq(allows(p, { appId: null, urgency: 1 }), false);
    eq(allows(p, { appId: 'org.gnome.Nautilus', urgency: URGENCY_CRITICAL }), true);
    p.allowTimeSensitive = false;
    eq(allows(p, { appId: 'org.gnome.Nautilus', urgency: URGENCY_CRITICAL }), false);
});
test('helpers', () => {
    eq(normalizeAppId('Org.App.desktop'), 'org.app');
    eq(toggleApp(['a'], 'B.desktop'), ['a', 'b']);
    eq(toggleApp(['a', 'b'], 'b'), ['a']);
    eq(minutesToText(7 * 60 + 5), '07:05');
    eq(textToMinutes('22:30'), 1350);
    eq(textToMinutes('25:00'), null);
    eq(untilTomorrow(at(MON, 20)), at(TUE, 7));
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
