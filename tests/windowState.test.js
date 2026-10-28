// Run: gjs -m tests/windowState.test.js
import { WindowStateRegistry, FLAGS } from '../core/windowState.js';

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

// A window stand-in with the one GObject signal the registry uses.
class FakeWin {
    constructor() {
        this._h = new Map();
        this._next = 1;
    }
    connect(sig, fn) {
        const id = this._next++;
        this._h.set(id, [sig, fn]);
        return id;
    }
    disconnect(id) {
        this._h.delete(id);
    }
    emit(sig) {
        for (const [s, fn] of [...this._h.values()]) {
            if (s === sig)
                fn();
        }
    }
    get handlers() {
        return this._h.size;
    }
}

test('flags are the reasons a window is out of place', () =>
    eq([...FLAGS], ['staged', 'isolatedFullscreen', 'tiled', 'parkedInDock', 'splitView', 'hidden', 'guavaHelper']));
test('set and has', () => {
    const r = new WindowStateRegistry();
    const w = {};
    eq(r.has(w, 'staged'), false);
    eq(r.set(w, 'staged'), true);
    eq(r.has(w, 'staged'), true);
    eq(r.has(w, 'tiled'), false);
});
test('set to the same value reports no change', () => {
    const r = new WindowStateRegistry();
    const w = {};
    r.set(w, 'tiled', true);
    eq(r.set(w, 'tiled', true), false);
    eq(r.set(w, 'staged', false), false);
});
test('unknown flag throws', () => {
    let threw = false;
    try {
        new WindowStateRegistry().set({}, 'nope');
    } catch (_e) {
        threw = true;
    }
    eq(threw, true);
});
test('null window is ignored', () => eq(new WindowStateRegistry().set(null, 'staged'), false));
test('flags are in FLAGS order', () => {
    const r = new WindowStateRegistry();
    const w = {};
    r.set(w, 'parkedInDock');
    r.set(w, 'staged');
    eq(r.flags(w), ['staged', 'parkedInDock']);
});
test('list by flag', () => {
    const r = new WindowStateRegistry();
    const a = {}, b = {}, c = {};
    r.set(a, 'tiled');
    r.set(b, 'staged');
    r.set(c, 'tiled');
    eq(r.list('tiled').length, 2);
    eq(r.list('tiled')[0] === a && r.list('tiled')[1] === c, true);
    r.set(a, 'tiled', false);
    eq(r.list('tiled').length, 1);
});
test('change signal carries window, flag and value', () => {
    const r = new WindowStateRegistry();
    const seen = [];
    r.watch((w, f, on) => seen.push([f, on]));
    const w = {};
    r.set(w, 'staged');
    r.set(w, 'staged');
    r.set(w, 'staged', false);
    eq(seen, [['staged', true], ['staged', false]]);
});
test('watch stops via the returned function', () => {
    const r = new WindowStateRegistry();
    let n = 0;
    const stop = r.watch(() => n++);
    r.set({}, 'tiled');
    stop();
    r.set({}, 'tiled');
    eq(n, 1);
});
test('watch removes itself when the cleanup registry disposes', () => {
    const r = new WindowStateRegistry();
    const fns = [];
    const reg = { add: fn => fns.push(fn) };
    let n = 0;
    r.watch(reg, () => n++);
    r.set({}, 'tiled');
    fns.forEach(f => f());
    r.set({}, 'tiled');
    eq(n, 1);
});
test('a throwing listener does not stop the others', () => {
    const r = new WindowStateRegistry();
    let n = 0;
    r.watch(() => {
        throw new Error('boom');
    });
    r.watch(() => n++);
    r.set({}, 'tiled');
    eq(n, 1);
});
test('staged mirrors win._guavaStaged', () => {
    const r = new WindowStateRegistry();
    const w = {};
    r.set(w, 'staged');
    eq(w._guavaStaged, true);
    r.set(w, 'staged', false);
    eq('_guavaStaged' in w, false);
});
test('mirror survives a frozen window', () => {
    const r = new WindowStateRegistry();
    const w = Object.freeze({});
    eq(r.set(w, 'staged'), true);
    eq(r.has(w, 'staged'), true);
});
test('clear drops every flag, emitting each', () => {
    const r = new WindowStateRegistry();
    const w = {};
    r.set(w, 'staged');
    r.set(w, 'tiled');
    const seen = [];
    r.watch((_w, f, on) => seen.push([f, on]));
    r.clear(w);
    eq(r.flags(w), []);
    eq(seen, [['staged', false], ['tiled', false]]);
});
test('clearFlag clears one flag everywhere and keeps the others', () => {
    const r = new WindowStateRegistry();
    const a = {}, b = {};
    r.set(a, 'staged');
    r.set(a, 'tiled');
    r.set(b, 'staged');
    r.clearFlag('staged');
    eq(r.list('staged').length, 0);
    eq(r.has(a, 'tiled'), true);
});
test('unmanaged drops the flags and the signal handler', () => {
    const r = new WindowStateRegistry();
    const w = new FakeWin();
    r.set(w, 'parkedInDock');
    eq(w.handlers, 1);
    w.emit('unmanaged');
    eq(r.flags(w), []);
    eq(w.handlers, 0);
});
test('one handler per window however many flags', () => {
    const r = new WindowStateRegistry();
    const w = new FakeWin();
    r.set(w, 'staged');
    r.set(w, 'tiled');
    eq(w.handlers, 1);
    r.set(w, 'staged', false);
    eq(w.handlers, 1);
    r.set(w, 'tiled', false);
    eq(w.handlers, 0);
});
test('stageActive toggles once and signals', () => {
    const r = new WindowStateRegistry();
    const seen = [];
    r.watch((w, f, on) => seen.push([w, f, on]));
    eq(r.stageActive, false);
    r.setStageActive(true);
    r.setStageActive(true);
    eq(r.stageActive, true);
    r.setStageActive(false);
    eq(seen, [[null, 'stageActive', true], [null, 'stageActive', false]]);
});
test('reset clears flags and stage mode', () => {
    const r = new WindowStateRegistry();
    const w = {};
    r.set(w, 'staged');
    r.setStageActive(true);
    r.reset();
    eq(r.flags(w), []);
    eq(r.stageActive, false);
});

test('interceptMinimize is false without an interceptor or without stage mode', () => {
    const r = new WindowStateRegistry();
    eq(r.interceptMinimize({}), false);
    r.setMinimizeInterceptor(() => true);
    eq(r.interceptMinimize({}), false);
    r.setStageActive(true);
    eq(r.interceptMinimize({}), true);
});
test('interceptMinimize passes the window and honours false', () => {
    const r = new WindowStateRegistry();
    r.setStageActive(true);
    const w = {};
    let got = null;
    r.setMinimizeInterceptor(win => {
        got = win;
        return false;
    });
    eq(r.interceptMinimize(w), false);
    eq(got === w, true);
    r.setMinimizeInterceptor(null);
    eq(r.interceptMinimize(w), false);
});
test('a throwing interceptor means "not handled"', () => {
    const r = new WindowStateRegistry();
    r.setStageActive(true);
    r.setMinimizeInterceptor(() => {
        throw new Error('boom');
    });
    eq(r.interceptMinimize({}), false);
});
test('reset removes the interceptor', () => {
    const r = new WindowStateRegistry();
    r.setStageActive(true);
    r.setMinimizeInterceptor(() => true);
    r.reset();
    r.setStageActive(true);
    eq(r.interceptMinimize({}), false);
});

if (failed)
    throw new Error(`${failed} failed`);
