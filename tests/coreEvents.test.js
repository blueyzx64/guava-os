// Run: gjs -m tests/coreEvents.test.js
import { EventHub, EVENTS } from '../core/events.js';
import { CleanupRegistry } from '../lib/disposables.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn, what) {
    try { fn(); } catch (_e) { return; }
    throw new Error(`expected a throw: ${what}`);
}

test('on / emit / off', () => {
    const hub = new EventHub();
    const got = [];
    const off = hub.on('app-focused', ({ appId }) => got.push(appId));
    hub.emit('app-focused', { appId: 'a' });
    off();
    off();
    hub.emit('app-focused', { appId: 'b' });
    eq(got, ['a']);
    eq(hub.listenerCount('app-focused'), 0);
});
test('typos fail fast: unknown events and missing payload fields throw', () => {
    const hub = new EventHub();
    throws(() => hub.on('app-focussed', () => {}), 'unknown on');
    throws(() => hub.emit('window-added', {}), 'missing field');
    throws(() => hub.emit('nope', {}), 'unknown emit');
});
test('the same function twice is two subscriptions', () => {
    const hub = new EventHub();
    let n = 0;
    const fn = () => n++;
    const off1 = hub.on('feature-changed', fn);
    hub.on('feature-changed', fn);
    hub.emit('feature-changed', { id: 'x', active: true });
    off1();
    hub.emit('feature-changed', { id: 'x', active: true });
    eq(n, 3);
});
test('once runs one time', () => {
    const hub = new EventHub();
    let n = 0;
    hub.once('motion-changed', () => n++);
    hub.emit('motion-changed', { reducedMotion: true, animations: true });
    hub.emit('motion-changed', { reducedMotion: false, animations: true });
    eq(n, 1);
});
test('a throwing listener does not stop the others', () => {
    const hub = new EventHub();
    let reached = false;
    hub.on('work-area-changed', () => { throw new Error('boom'); });
    hub.on('work-area-changed', () => (reached = true));
    hub.emit('work-area-changed', { monitor: 0 });
    eq(reached, true);
});
test('an owner registry removes its listeners on dispose', () => {
    const hub = new EventHub();
    const cleanup = new CleanupRegistry();
    hub.on('window-removed', () => {}, cleanup);
    hub.on('window-added', () => {}, cleanup);
    cleanup.dispose();
    eq(hub.listenerCount('window-removed') + hub.listenerCount('window-added'), 0);
});
test('a listener that unsubscribes another during emit does not break the loop', () => {
    const hub = new EventHub();
    const got = [];
    let offB = null;
    hub.on('app-focused', () => { got.push('a'); offB(); });
    offB = hub.on('app-focused', () => got.push('b'));
    hub.emit('app-focused', { appId: null });
    eq(got, ['a', 'b'], 'this emit still reaches b');
    hub.emit('app-focused', { appId: null });
    eq(got, ['a', 'b', 'a']);
});
test('every declared event has a field map', () => {
    for (const [name, fields] of Object.entries(EVENTS)) {
        if (typeof fields !== 'object')
            throw new Error(name);
    }
});

test('unknown names throw on once() and on() too, including inherited keys', () => {
    const hub = new EventHub();
    throws(() => hub.once('nope', () => {}), 'unknown once');
    throws(() => hub.on('toString', () => {}), 'inherited key');
    throws(() => hub.on('__proto__', () => {}), '__proto__ key');
    throws(() => hub.emit('constructor', {}), 'inherited emit');
    eq(hub.listenerCount('nope'), 0);
});
test('a rejected subscription leaves nothing in the owner', () => {
    const hub = new EventHub();
    const cleanup = new CleanupRegistry();
    throws(() => hub.on('nope', () => {}, cleanup), 'unknown with owner');
    eq(cleanup.size, 0);
});
test('a missing payload field throws before any listener runs', () => {
    const hub = new EventHub();
    let ran = false;
    hub.on('app-focused', () => (ran = true));
    throws(() => hub.emit('app-focused', {}), 'missing appId');
    eq(ran, false);
});
test('disposing an owner removes only its own listeners', () => {
    const hub = new EventHub();
    const mine = new CleanupRegistry();
    const got = [];
    hub.on('app-focused', () => got.push('mine'), mine);
    hub.on('app-focused', () => got.push('other'));
    mine.dispose();
    hub.emit('app-focused', { appId: 'x' });
    eq(got, ['other']);
    eq(hub.listenerCount('app-focused'), 1);
});
test('a handle used after its owner was disposed is harmless', () => {
    const hub = new EventHub();
    const mine = new CleanupRegistry();
    let n = 0;
    const off = hub.on('app-focused', () => n++, mine);
    mine.dispose();
    off();
    off();
    hub.emit('app-focused', { appId: null });
    eq(n, 0);
    eq(hub.listenerCount('app-focused'), 0);
});
test('two owners of the same event are independent', () => {
    const hub = new EventHub();
    const a = new CleanupRegistry();
    const b = new CleanupRegistry();
    let n = 0;
    const fn = () => n++;
    hub.on('app-focused', fn, a);
    hub.on('app-focused', fn, b);
    a.dispose();
    hub.emit('app-focused', { appId: null });
    eq(n, 1);
    b.dispose();
    hub.emit('app-focused', { appId: null });
    eq(n, 1);
});
test('an owned once() that is disposed before it fires never runs', () => {
    const hub = new EventHub();
    const mine = new CleanupRegistry();
    let n = 0;
    hub.once('motion-changed', () => n++, mine);
    mine.dispose();
    hub.emit('motion-changed', { reducedMotion: false, animations: true });
    eq(n, 0);
    eq(hub.listenerCount('motion-changed'), 0);
});
test('an owner disposed from its own listener removes itself; the others keep running', () => {
    const hub = new EventHub();
    const mine = new CleanupRegistry();
    let owned = 0;
    let other = 0;
    hub.on('app-focused', () => { owned++; mine.dispose(); }, mine);
    hub.on('app-focused', () => other++);
    hub.emit('app-focused', { appId: null });
    hub.emit('app-focused', { appId: null });
    eq(owned, 1);
    eq(other, 2);
});
test('a registry can be reused after dispose', () => {
    const hub = new EventHub();
    const mine = new CleanupRegistry();
    hub.on('app-focused', () => {}, mine);
    mine.dispose();
    hub.on('app-focused', () => {}, mine);
    eq(hub.listenerCount('app-focused'), 1);
    mine.dispose();
    eq(hub.listenerCount('app-focused'), 0);
});
test('clear() drops the listeners of every event', () => {
    const hub = new EventHub();
    hub.on('app-focused', () => {});
    hub.on('window-added', () => {});
    hub.clear();
    eq(hub.listenerCount('app-focused') + hub.listenerCount('window-added'), 0);
});
test('an emit from inside a listener delivers its own payload, then the outer emit goes on', () => {
    const hub = new EventHub();
    const log = [];
    hub.on('app-focused', ({ appId }) => {
        log.push(`a:${appId}`);
        if (appId === 'outer')
            hub.emit('app-focused', { appId: 'inner' });
    });
    hub.on('app-focused', ({ appId }) => log.push(`b:${appId}`));
    hub.emit('app-focused', { appId: 'outer' });
    eq(log, ['a:outer', 'a:inner', 'b:inner', 'b:outer']);
});
test('a listener added during emit runs on the next emit, not this one', () => {
    const hub = new EventHub();
    let added = false;
    let late = 0;
    hub.on('app-focused', () => {
        if (!added) {
            added = true;
            hub.on('app-focused', () => late++);
        }
    });
    hub.emit('app-focused', { appId: null });
    eq(late, 0, 'after the first emit');
    hub.emit('app-focused', { appId: null });
    eq(late, 1, 'after the second emit');
});
test('a listener that throws in a nested emit does not stop the outer emit', () => {
    const hub = new EventHub();
    const reached = [];
    hub.on('app-focused', ({ appId }) => {
        if (appId === 'outer')
            hub.emit('app-focused', { appId: 'inner' });
    });
    hub.on('app-focused', ({ appId }) => {
        if (appId === 'inner')
            throw new Error('boom');
    });
    hub.on('app-focused', ({ appId }) => reached.push(appId));
    hub.emit('app-focused', { appId: 'outer' });
    eq(reached, ['inner', 'outer']);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
