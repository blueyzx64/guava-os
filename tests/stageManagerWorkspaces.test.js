// Run: gjs -m tests/stageManagerWorkspaces.test.js
// Stage Manager across workspace renumbering (RV1-4): Mutter removes an empty workspace in the middle,
// every window behind it reports an index one lower (no event says so), and the adapter sends
// 'renumber' with the live indexes. The stages and strips must come out as they were.
import { StageModel } from '../src/features/stageManager/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}\n${e.stack}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const win = (id, workspace, app = `app${id}`) => ({
    id, appId: app, type: 'normal', parent: null, workspace, monitor: 0, fullscreen: false, above: false,
    skipTaskbar: false, title: `w${id}`, minimized: false,
});

// Workspace 0: window 1. Workspace 1: empty. Workspace 2: 2 and 3 (focused 3: its set is the stage)
// with 4 in the strip, windows 5 and 6 behind 4 in the same strip. Workspace 3: window 7.
// The user is on workspace 2.
function setup(cfg = { newWindows: 'separate' }) {
    const sm = new StageModel(cfg);
    const w = [win(1, 0), win(2, 2), win(3, 2), win(4, 2), win(7, 3)];
    sm.dispatch({ type: 'init', now: 1000, windows: w, focus: 3, active: 2, primary: 0 });
    sm.checkInvariants();
    return { sm, w };
}

// Windows behind removed workspace `r` report one index lower
const liveAfterRemoval = (w, r) => new Map(w.map(x => [x.id, x.workspace > r ? x.workspace - 1 : x.workspace]));
const shape = (sm, ws) => ({ stage: sm.stage(ws)?.windows ?? null, strip: sm.waiting(ws).map(s => s.windows) });

test('RV1-4 baseline: workspace 2 has window 3 on its stage, 2 and 4 wait', () => {
    const { sm } = setup();
    eq(sm.stage(2).windows, [3]);
    eq(sm.waiting(2).map(s => s.windows).sort(), [[2], [4]]);
});

test('RV1-4 removing the empty workspace 1 moves the sets of workspaces 2 and 3 down as they are', () => {
    const { sm, w } = setup();
    const before2 = shape(sm, 2);
    const before3 = shape(sm, 3);
    const hidden = [...sm.hiddenIds()].sort();
    const fx = sm.dispatch({ type: 'renumber', now: 2000, live: liveAfterRemoval(w, 1) });
    sm.dispatch({ type: 'workspace', now: 2000, active: 1 });
    sm.checkInvariants();
    eq(shape(sm, 1), before2);
    eq(shape(sm, 2), before3);
    eq(sm.activeWorkspace, 1);
    eq([...sm.hiddenIds()].sort(), hidden);
    eq(fx.filter(f => f.type === 'hide' || f.type === 'show'), []);
});

test('RV1-4 window events that follow a renumbering change nothing, in any order', () => {
    const orders = [[2, 3, 4, 7], [4, 3, 2, 7], [7, 4, 3, 2], [3, 7, 2, 4]];
    for (const order of orders) {
        const { sm, w } = setup();
        const live = liveAfterRemoval(w, 1);
        sm.dispatch({ type: 'renumber', now: 2000, live });
        sm.dispatch({ type: 'workspace', now: 2000, active: 1 });
        for (const id of order) {
            const x = w.find(v => v.id === id);
            sm.dispatch({ type: 'change', now: 2001, window: { ...x, workspace: live.get(id) } });
            sm.checkInvariants();
        }
        eq(sm.stage(1).windows, [3], `order ${order}`);
        eq(sm.waiting(1).map(s => s.windows).sort(), [[2], [4]], `order ${order}`);
        eq(sm.stage(2).windows, [7], `order ${order}`);
    }
});

test('RV1-4 a set of two windows stays one set', () => {
    const { sm, w } = setup({ newWindows: 'join' });
    const extra = win(5, 2);
    sm.dispatch({ type: 'add', now: 1500, window: extra });
    w.push(extra);
    const before = shape(sm, 2);
    eq(before.stage.length, 2);
    sm.dispatch({ type: 'renumber', now: 2000, live: liveAfterRemoval(w, 1) });
    sm.dispatch({ type: 'workspace', now: 2000, active: 1 });
    sm.checkInvariants();
    eq(shape(sm, 1), before);
});

test('RV1-4 removing the last workspace, or one with nothing behind it, changes nothing', () => {
    const { sm, w } = setup();
    const before = shape(sm, 2);
    sm.dispatch({ type: 'renumber', now: 2000, live: liveAfterRemoval(w, 5) });
    sm.checkInvariants();
    eq(shape(sm, 2), before);
});

test('RV1-4 one window that moved alone is no renumbering (its set stays, its event moves it)', () => {
    const { sm, w } = setup();
    const before = shape(sm, 2);
    // window 4 alone is on workspace 0 now, the rest of workspace 2 has not moved
    const live = new Map(w.map(x => [x.id, x.workspace]));
    live.set(4, 0);
    sm.dispatch({ type: 'renumber', now: 2000, live });
    sm.checkInvariants();
    eq(shape(sm, 2), before);
});

test('RV1-4 a shift onto a workspace that stays is refused', () => {
    const { sm, w } = setup();
    const before = shape(sm, 2);
    // windows of workspace 3 claim index 2 while workspace 2 keeps its own windows
    const live = new Map(w.map(x => [x.id, x.workspace]));
    live.set(7, 2);
    sm.dispatch({ type: 'renumber', now: 2000, live });
    sm.checkInvariants();
    eq(shape(sm, 2), before);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
