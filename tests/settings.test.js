// Run: gjs -m tests/settings.test.js
import { GuavaSettings } from '../lib/settings.js';
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
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Minimal Gio.Settings stand-in. types: key -> type string; user: key -> value (user-set).
function fakeSettings(types, user = {}, defaults = {}) {
    const handlers = new Map();
    let nextId = 1;
    const gs = {
        user: { ...user },
        settings_schema: { has_key: k => k in types },
        get_user_value: k => (k in gs.user ? { v: gs.user[k] } : null),
        get_value: k => ({ get_type_string: () => types[k] }),
        _get: k => (k in gs.user ? gs.user[k] : defaults[k]),
        connect(sig, fn) { const id = nextId++; handlers.set(id, fn); return id; },
        disconnect(id) { handlers.delete(id); },
        emit(key) { for (const fn of handlers.values()) fn(gs, key); },
        handlerCount: () => handlers.size,
    };
    for (const name of ['boolean', 'int', 'double', 'string', 'uint']) {
        gs[`get_${name}`] = k => gs._get(k);
        gs[`set_${name}`] = (k, v) => { gs.user[k] = v; };
    }
    gs.get_strv = k => gs._get(k);
    gs.set_strv = (k, v) => { gs.user[k] = v; };
    return gs;
}

test('typed getters pass through', () => {
    const gs = fakeSettings({ a: 'b' }, { a: true });
    const s = new GuavaSettings(gs);
    eq(s.bool('a'), true);
    eq(s.has('a'), true);
    eq(s.has('zzz'), false);
});

test('watch dispatches only to the changed key and wildcard', () => {
    const gs = fakeSettings({});
    const s = new GuavaSettings(gs);
    const reg = new CleanupRegistry();
    s.attach(reg);
    const seen = [];
    s.watch('x', k => seen.push(`x:${k}`));
    s.watch(['y', 'z'], k => seen.push(`yz:${k}`));
    s.watch('*', k => seen.push(`*:${k}`));
    gs.emit('y');
    gs.emit('q');
    eq(seen, ['yz:y', '*:y', '*:q']);
});

test('unwatch stops callbacks; dispose disconnects once', () => {
    const gs = fakeSettings({});
    const s = new GuavaSettings(gs);
    const reg = new CleanupRegistry();
    s.attach(reg);
    s.attach(reg);
    eq(gs.handlerCount(), 1);
    let n = 0;
    const off = s.watch('x', () => n++);
    gs.emit('x');
    off();
    gs.emit('x');
    eq(n, 1);
    reg.dispose();
    eq(gs.handlerCount(), 0);
});

test('a throwing watcher does not block the others', () => {
    const gs = fakeSettings({});
    const s = new GuavaSettings(gs);
    s.attach(new CleanupRegistry());
    let ok = false;
    s.watch('x', () => { throw new Error('boom'); });
    s.watch('x', () => { ok = true; });
    gs.emit('x');
    eq(ok, true);
});


if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
