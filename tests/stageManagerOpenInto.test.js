// Run: gjs -m tests/stageManagerOpenInto.test.js
// Option-click on an app opens it into the current Stage Manager stage (RV1-1, SM-29).
import { opensIntoStage } from '../src/lib/clickModel.js';
import { StageModel } from '../src/features/stageManager/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}\n${e.stack}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const win = (id, appId) => ({
    id, appId, type: 'normal', parent: null, workspace: 0, monitor: 0, fullscreen: false, above: false,
    skipTaskbar: false, title: `w${id}`, minimized: false,
});

test('SM-29 only Alt + primary click while Stage Manager runs opens into the stage', () => {
    eq(opensIntoStage({ button: 1, alt: true, stageActive: true }), true);
    eq(opensIntoStage({ alt: true, stageActive: true }), true);
    eq(opensIntoStage({ button: 1, alt: false, stageActive: true }), false);
    eq(opensIntoStage({ button: 1, alt: true, stageActive: false }), false);
    eq(opensIntoStage({ button: 2, alt: true, stageActive: true }), false);
});

function three() {
    const sm = new StageModel({});
    const fx = ev => sm.dispatch({ now: 1000, ...ev });
    fx({ type: 'init', windows: [], focus: null, active: 0, primary: 0 });
    for (const [id, app] of [[1, 'a.desktop'], [2, 'b.desktop'], [3, 'c.desktop']])
        fx({ type: 'add', window: win(id, app) });
    return { sm, fx };
}

test('SM-29 waitingSetOf finds the strip set of a running app, not the stage app or an unknown one', () => {
    const { sm } = three();
    eq(sm.stage().windows, [3]);
    eq(sm.waitingSetOf('c.desktop'), null);
    eq(sm.waitingSetOf('zzz.desktop'), null);
    eq(sm.waitingSetOf(null), null);
    const a = sm.waitingSetOf('a.desktop');
    eq(sm.waiting().find(s => s.id === a).windows, [1]);
});

test('SM-29 the waiting set joins the stage (an activate with add)', () => {
    const { sm, fx } = three();
    const out = fx({ type: 'activate', set: sm.waitingSetOf('a.desktop'), add: true });
    sm.checkInvariants();
    eq(sm.stage().windows.slice().sort(), [1, 3]);
    eq(sm.waiting().map(s => s.windows), [[2]]);
    eq(out.find(f => f.type === 'show').ids, [1]);
});

test('SM-29 an app that is not running joins the stage set with its next window', () => {
    const { sm, fx } = three();
    fx({ type: 'join-next', appId: 'd.desktop' });
    fx({ type: 'add', window: win(4, 'd.desktop') });
    eq(sm.stage().windows.slice().sort(), [3, 4]);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
