// Run: gjs -m tests/debugLogModel.test.js
// core/debugLogModel.js: the debug log's lines, privacy filter, stall and slow-frame rules.
import {
    PREFIX, RateLimit, formatLine, slowFrameMs, slowestFeatures, stallMs, summarize,
} from '../src/core/debugLogModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb)
        throw new Error(`${msg} expected ${sb}, got ${sa}`);
}
function ok(v, msg = '') {
    if (!v)
        throw new Error(msg || 'not true');
}

test('summarize: scalars, arrays, nesting', () => {
    eq(summarize(3), '3');
    eq(summarize(1.23456), '1.23');
    eq(summarize(true), 'true');
    eq(summarize(null), 'null');
    eq(summarize('dock'), '"dock"');
    eq(summarize([1, 2]), '[1,2]');
    eq(summarize({ id: 'dock', active: true }), '{id:"dock",active:true}');
    eq(summarize([1, 2, 3, 4, 5, 6, 7, 8]), '[1,2,3,4,5,6,…+2]');
    eq(summarize({ a: { b: { c: { d: 1 } } } }), '{a:{b:{c:{…}}}}');
});

test('summarize: private text is never written, only its length', () => {
    const s = summarize({ window: { id: 7, appId: 'org.gnome.TextEditor', title: 'secret plans.txt' } });
    ok(!s.includes('secret'), s);
    ok(s.includes('title:<16 chars>'), s);
    ok(s.includes('appId:"org.gnome.TextEditor"'), s);
    const n = summarize({ summary: 'Mail from Bob', body: 'hello', password: 'x' });
    ok(!n.includes('Bob') && !n.includes('hello') && !n.includes(':"x"'), n);
});

test('summarize: class instances show their type; long strings are cut', () => {
    class MetaWindowLike {}
    eq(summarize({ window: new MetaWindowLike() }), '{window:<MetaWindowLike>}');
    eq(summarize(new Error('boom')), 'Error("boom")');
    const long = 'x'.repeat(200);
    eq(summarize(long).length, 80 + 3);
});

test('formatLine: prefix, timeline, scope, data', () => {
    eq(formatLine(12345, 'events', 'window-focused', { id: 3 }), `${PREFIX} +12.345s events: window-focused {id:3}`);
    eq(formatLine(-5, 'shell', 'overview showing'), `${PREFIX} +0.000s shell: overview showing`);
});

test('stalls: late by the threshold or more', () => {
    eq(stallMs(50, 50, 100), 0);
    eq(stallMs(149, 50, 100), 0);
    eq(stallMs(150, 50, 100), 100);
    eq(stallMs(812.4, 50, 100), 762);
});

test('slow frames: only inside an animation, and not a stall', () => {
    eq(slowFrameMs(80, 50, 3), 80);
    eq(slowFrameMs(80, 50, 2), 0, 'one quick pair of frames at idle is no animation');
    eq(slowFrameMs(30, 50, 5), 0);
    eq(slowFrameMs(287, 50, 5), 0, 'a long pause is a main-loop stall, reported as one');
});

test('feature start times: the slowest, as id:ms', () => {
    const t = { passes: 2, features: [
        { id: 'dock', enableMs: 40.4 }, { id: 'notch', enableMs: 120 }, { id: 'later', enableMs: null },
        { id: 'glass', enableMs: 52 },
    ] };
    eq(slowestFeatures(t, 2), { started: 3, slowest: ['notch:120', 'glass:52'] });
    eq(slowestFeatures(null), { started: 0, slowest: [] });
});

test('rate limit: at most max per window, then a count of what was dropped', () => {
    const r = new RateLimit(2, 1000);
    eq(r.check('k', 0), { pass: true, dropped: 0 });
    eq(r.check('k', 10), { pass: true, dropped: 0 });
    eq(r.check('k', 20), { pass: false, dropped: 0 });
    eq(r.check('k', 30), { pass: false, dropped: 0 });
    eq(r.check('other', 30), { pass: true, dropped: 0 }, 'keys are separate');
    eq(r.check('k', 1000), { pass: true, dropped: 2 }, 'next window reports the drops');
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
