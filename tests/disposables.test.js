// Run: gjs -m tests/disposables.test.js
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { CleanupRegistry } from '../lib/disposables.js';

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
function eq(a, b, msg = '') {
    if (a !== b)
        throw new Error(`${msg} expected ${b}, got ${a}`);
}
function pump(ms) {
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    loop.run();
}

const Emitter = GObject.registerClass({
    Signals: { ping: {}, destroy: {} },
}, class Emitter extends GObject.Object {});

test('dispose runs newest first, once', () => {
    const r = new CleanupRegistry();
    const log = [];
    r.add(() => log.push('a'));
    r.add(() => log.push('b'));
    r.dispose();
    r.dispose();
    eq(log.join(), 'b,a');
    eq(r.size, 0);
});

test('error in one cleanup does not stop the rest', () => {
    const r = new CleanupRegistry();
    let ran = false;
    r.add(() => { ran = true; });
    r.add(() => { throw new Error('boom'); });
    r.dispose();
    eq(ran, true);
});

test('connect disconnects on dispose', () => {
    const e = new Emitter();
    const r = new CleanupRegistry();
    let n = 0;
    r.connect(e, 'ping', () => n++);
    e.emit('ping');
    r.dispose();
    e.emit('ping');
    eq(n, 1);
});

test('connect disconnects a plain JS emitter (not a GObject) on dispose', () => {
    // Shape of Signals.EventEmitter (PopupMenu, PressureBarrier)
    class JsEmitter {
        constructor() { this._h = new Map(); this._n = 1; }
        connect(_sig, fn) { const id = this._n++; this._h.set(id, fn); return id; }
        disconnect(id) { this._h.delete(id); }
        emit() { for (const fn of this._h.values()) fn(); }
    }
    const e = new JsEmitter();
    const r = new CleanupRegistry();
    let n = 0;
    r.connect(e, 'open-state-changed', () => n++);
    e.emit();
    r.dispose();
    e.emit();
    eq(n, 1);
    eq(e._h.size, 0);
});

test('release runs one cleanup now', () => {
    const e = new Emitter();
    const r = new CleanupRegistry();
    let n = 0;
    const t = r.connect(e, 'ping', () => n++);
    r.release(t);
    e.emit('ping');
    eq(n, 0);
    eq(r.size, 0);
});

test('one-shot timeout fires and forgets itself', () => {
    const r = new CleanupRegistry();
    let n = 0;
    r.timeout(5, () => { n++; });
    eq(r.size, 1);
    pump(40);
    eq(n, 1);
    eq(r.size, 0);
});

test('repeating timeout stops after dispose', () => {
    const r = new CleanupRegistry();
    let n = 0;
    r.timeout(5, () => { n++; return GLib.SOURCE_CONTINUE; });
    pump(40);
    const seen = n;
    r.dispose();
    pump(40);
    eq(n, seen);
    if (seen < 2)
        throw new Error('timer did not repeat');
});

test('idle cancelled by dispose never runs', () => {
    const r = new CleanupRegistry();
    let n = 0;
    r.idle(() => n++);
    r.dispose();
    pump(20);
    eq(n, 0);
});

test('inject wraps and restores (own method)', () => {
    const obj = { v: 2, f(x) { return x + this.v; } };
    const r = new CleanupRegistry();
    r.inject(obj, 'f', function (orig, x) { return orig.call(this, x) * 10; });
    eq(obj.f(1), 30);
    r.dispose();
    eq(obj.f(1), 3);
});

test('inject restores inherited method by deleting own override', () => {
    class A { f() { return 'a'; } }
    const proto = A.prototype;
    const inst = new A();
    const child = Object.create(proto);
    const r = new CleanupRegistry();
    r.inject(child, 'f', (orig) => `x${orig.call(child)}`);
    eq(child.f(), 'xa');
    r.dispose();
    eq(Object.prototype.hasOwnProperty.call(child, 'f'), false);
    eq(inst.f(), 'a');
});

test('actor destroyed once; early destroy drops registration', () => {
    let destroys = 0;
    const handlers = {};
    const fake = {
        connect(sig, fn) { handlers[sig] = fn; return 1; },
        disconnect() {},
        destroy() { destroys++; handlers.destroy?.(); },
    };
    const r = new CleanupRegistry();
    r.actor(fake);
    r.dispose();
    eq(destroys, 1);

    destroys = 0;
    const r2 = new CleanupRegistry();
    r2.actor(fake);
    fake.destroy();
    eq(r2.size, 0);
    r2.dispose();
    eq(destroys, 1, 'no second destroy');
});

test('file removed on dispose, missing file tolerated', () => {
    const [fd, path] = GLib.file_open_tmp('guava-test-XXXXXX');
    GLib.close(fd);
    const r = new CleanupRegistry();
    r.file(path);
    r.dispose();
    pump(50);
    eq(GLib.file_test(path, GLib.FileTest.EXISTS), false);
    r.file(path);
    r.dispose();
    pump(50);
});

test('connect: after the object emitted destroy, dispose does not touch it', () => {
    const e = new Emitter();
    const r = new CleanupRegistry();
    let calls = 0;
    const origDisconnect = e.disconnect.bind(e);
    e.disconnect = id => { calls++; return origDisconnect(id); };
    r.connect(e, 'ping', () => {});
    r.connect(e, 'ping', () => {});
    eq(r.size, 2);
    e.emit('destroy');
    eq(r.size, 0, 'entries dropped on destroy');
    r.dispose();
    eq(calls, 0);
});

test('connect: live object gets all handlers (and our destroy watcher) disconnected', () => {
    const e = new Emitter();
    const r = new CleanupRegistry();
    let n = 0;
    r.connect(e, 'ping', () => n++);
    r.connect(e, 'destroy', () => n++);
    r.dispose();
    e.emit('ping');
    e.emit('destroy');
    eq(n, 0);
});

test('connect: one destroy watcher per object', () => {
    const e = new Emitter();
    const r = new CleanupRegistry();
    let hooks = 0;
    const real = e.connect.bind(e);
    e.connect = (sig, fn) => { if (sig === 'destroy') hooks++; return real(sig, fn); };
    r.connect(e, 'ping', () => {});
    r.connect(e, 'ping', () => {});
    eq(hooks, 1);
    eq(r.size, 2);
});

test('connect: handler already disconnected by someone else is not disconnected again', () => {
    const e = new Emitter();
    const r = new CleanupRegistry();
    const id = e.connect('ping', () => {});
    let calls = 0;
    const real = e.disconnect.bind(e);
    e.disconnect = i => { calls++; real(i); };
    // simulate: registry owns a token, then someone disconnects the handler behind its back
    const t = r.connect(e, 'ping', () => {});
    r.dispose();
    r.release(t);
    real(id);
    eq(calls, 2, 'watcher + handler, each once');
});

test('actor: destroy emitted first -> dispose never calls destroy()', () => {
    const e = new Emitter();
    let destroyed = 0;
    e.destroy = () => { destroyed++; };
    const r = new CleanupRegistry();
    r.actor(e);
    e.emit('destroy');
    r.dispose();
    eq(destroyed, 0);
});

test('timeout: fired one-shot is forgotten; dispose never removes a gone source', () => {
    const r = new CleanupRegistry();
    r.timeout(1, () => false);
    r.timeout(1, () => { throw new Error('x'); });
    pump(30);
    eq(r.size, 0);
    r.dispose();
});

test('timeout/idle: release twice is harmless', () => {
    const r = new CleanupRegistry();
    const t = r.timeout(500, () => false);
    r.release(t);
    r.release(t);
    const i = r.idle(() => {});
    pump(10);
    r.release(i);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
