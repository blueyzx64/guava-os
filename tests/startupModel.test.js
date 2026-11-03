// Run: gjs -m tests/startupModel.test.js
// The login-trace arithmetic of the harness probe (tools/harness/probe/probe@x2/startupModel.js).
import { chromeStats, frameStats, percentile, summarize } from '../tools/harness/probe/probe@x2/startupModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('percentile: nearest rank', () => {
    eq(percentile([], 0.5), 0);
    eq(percentile([1, 2, 3, 4], 0.5), 2);
    eq(percentile([1, 2, 3, 4], 0.95), 4);
});
test('frameStats: intervals inside the window, idle gaps left out', () => {
    const f = frameStats([0, 16, 32, 100, 2000, 2016], 0, 3000);
    eq(f.frames, 6);
    eq(f.max, 68);
    eq(f.over33, 1);
    eq(frameStats([0, 16, 32, 100], 20, 3000).frames, 2);
});
test('chromeStats: shown once in place = no moves; a jump and a re-hide count', () => {
    eq(chromeStats([[0, 0, 0, 0, 0, 0, 0], [10, 0, 760, 1280, 40, 255, 1]]).moves, 0);
    const c = chromeStats([[10, 0, 760, 1280, 40, 255, 1], [20, 0, 700, 1280, 100, 255, 1],
        [30, 0, 700, 1280, 100, 255, 0], [40, 0, 700, 1280, 100, 255, 1]]);
    eq([c.shown, c.moves, c.hides, c.settled], [10, 1, 1, 40]);
    eq(chromeStats([[0, 0, 0, 0, 0, 0, 0]]).shown, null, 'never shown');
    eq(chromeStats([[10, 0, 0, 10, 10, 255, 1], [20, 1, 0, 10, 10, 255, 1]]).moves, 0, 'a 1 px rounding is no move');
});
test('summarize: process clock, ready = the latest of startup, features and chrome', () => {
    const trace = {
        t0: 1000, procOffset: 100, frames: [1, 17, 33], stalls: [[5, 60], [9000, 70]],
        events: [[1, 'startup-prepared', null], [30, 'startup-complete', null], [31, 'workarea', [0, 32, 1, 1]],
            [2, 'guava-state', 1]],
        actors: { dock: [[0, 0, 0, 0, 0, 0, 0], [5, 0, 760, 1280, 40, 255, 1], [50, 0, 700, 1280, 100, 255, 1]] },
    };
    const s = summarize(trace, { passes: 2, features: [{ id: 'a', startedAt: 1010, enableMs: 3 },
        { id: 'b', startedAt: null, enableMs: null }] });
    eq([s.clock, s.startupPrepared, s.startupComplete, s.guavaActive, s.ready], ['process', 101, 130, 102, 150]);
    eq(s.stalls50, 1, 'a stall after the login window is not counted');
    eq(s.features.started, 1);
    eq(s.features.order, ['a@107']);
    eq(s.workarea.steps, ['0,32,1,1@131']);
    eq(s.chrome.dock.moves, 1);
    eq(summarize({ ...trace, procOffset: null }, null).clock, 'probe');
    eq(summarize(trace, null).features, null, 'stock GNOME has no feature timings');
});

test('summarize: an overview hidden before it paints is marked unseen (no flash)', () => {
    const trace = {
        t0: 0, procOffset: 0, frames: [], stalls: [],
        events: [[10, 'overview-shown', 'unseen'], [20, 'overview-hiding', 'unseen'], [30, 'overview-hidden', null]],
        actors: {},
    };
    eq(summarize(trace, null).overview, ['shown~@10', 'hiding~@20', 'hidden@30']);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
