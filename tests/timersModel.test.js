// Run: gjs -m tests/timersModel.test.js
import {
    startTimer, pauseTimer, resumeTimer, removeTimer, expire, nextDue, remaining, serialize, parse, MAX_TIMERS,
} from '../core/timersModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('start, remaining, ring', () => {
    const l = startTimer([], { id: 'a', label: 'Tea', durationMs: 180000 }, 1000);
    eq(remaining(l[0], 61000), 120000);
    eq(nextDue(l), 181000);
    let r = expire(l, 180999);
    eq(r.finished.length, 0);
    eq(r.list, l, 'unchanged list is the same object');
    r = expire(l, 181000);
    eq(r.finished.map(t => t.id), ['a']);
    eq(r.list[0].state, 'finished');
    eq(nextDue(r.list), null);
});
test('pause keeps the time left, resume restarts the clock', () => {
    let l = startTimer([], { id: 'a', durationMs: 60000 }, 0);
    l = pauseTimer(l, 'a', 20000);
    eq(remaining(l[0], 999999), 40000);
    eq(nextDue(l), null);
    eq(expire(l, 999999).finished.length, 0, 'paused never rings');
    l = resumeTimer(l, 'a', 100000);
    eq(l[0].endsAt, 140000);
});
test('cancel, replace by id, the cap drops finished first', () => {
    let l = [];
    for (let i = 0; i < MAX_TIMERS; i++)
        l = startTimer(l, { id: `t${i}`, durationMs: 1000 * (i + 1) }, 0);
    l = expire(l, 1500).list; // t0 finished
    l = startTimer(l, { id: 'new', durationMs: 5000 }, 1500);
    eq(l.length, MAX_TIMERS);
    eq(l.some(t => t.id === 't0'), false);
    l = startTimer(l, { id: 'new', durationMs: 9000 }, 1500);
    eq(l.filter(t => t.id === 'new').length, 1);
    eq(removeTimer(l, 'new').length, MAX_TIMERS - 1);
});
test('bad durations throw; huge ones are clamped', () => {
    let threw = false;
    try { startTimer([], { id: 'x', durationMs: 0 }, 0); } catch (_e) { threw = true; }
    eq(threw, true);
    eq(startTimer([], { id: 'x', durationMs: 1e12 }, 0)[0].durationMs, 24 * 3600 * 1000);
});
test('serialize round trip; malformed input is dropped', () => {
    let l = startTimer([], { id: 'a', label: 'x', durationMs: 5000 }, 10);
    l = startTimer(l, { id: 'b', durationMs: 9000 }, 10);
    l = pauseTimer(l, 'b', 1010);
    eq(parse(serialize(l)), l);
    eq(parse('nope'), []);
    eq(parse('{"a":1}'), []);
    eq(parse('[{"id":"z","durationMs":5000,"state":"running"}]'), [], 'running without endsAt');
});
if (failed) { print(`${failed} failed`); imports.system.exit(1); }
