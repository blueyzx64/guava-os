// Run: gjs -m tests/lockModel.test.js
import { SurfaceLedger, isGuavaActor, isSuspended, lockPlan, sweepTargets } from '../lib/lockModel.js';
import { CleanupRegistry } from '../lib/disposables.js';
import { FeatureRegistry } from '../lib/featureRegistry.js';

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
const actor = (visible = true, reactive = true) => ({ visible, reactive });

test('isSuspended: only while locked and without lockScreen', () => {
    eq(isSuspended({}, true), true);
    eq(isSuspended({ lockScreen: true }, true), false);
    eq(isSuspended({}, false), false);
});

test('lockPlan splits entries', () => {
    const entries = [{ id: 'a' }, { id: 'b', lockScreen: true }];
    eq(lockPlan(entries, true), { suspend: ['a'], resume: [], notify: ['b'] });
    eq(lockPlan(entries, false), { suspend: [], resume: ['a'], notify: ['b'] });
});

test('ledger hides, then restores visibility and reactivity', () => {
    const l = new SurfaceLedger();
    const a = actor(true, true), b = actor(true, false), c = actor(false, true);
    l.hide([a, b, c]);
    eq([a.visible, a.reactive, b.visible, c.visible], [false, false, false, false]);
    l.restore();
    eq([a.visible, a.reactive, b.visible, b.reactive, c.visible, c.reactive], [true, true, true, false, false, true]);
    eq(l.hidden, false);
});

test('ledger: hiding twice keeps the first state; dead actors are skipped', () => {
    const dead = new Set();
    const l = new SurfaceLedger(a => !dead.has(a));
    const a = actor(), b = actor();
    l.hide([a, b]);
    l.hide([a, b]);
    dead.add(b);
    l.restore();
    eq([a.visible, a.reactive, b.visible], [true, true, false]);
});

test('CleanupRegistry.suspend hides surfaces, restores them, dispose restores', () => {
    const c = new CleanupRegistry();
    const a = actor(), b = actor();
    c.surface(a);
    c.surface(b);
    c.suspend(true);
    eq([a.visible, b.visible], [false, false]);
    c.suspend(false);
    eq([a.visible, b.visible], [true, true]);
    c.suspend(true);
    c.dispose();
    eq([a.visible, a.reactive], [true, true]);
});

test('sweepTargets: Guava-named actors that no lockScreen feature owns', () => {
    const a = { name: 'guava-dock' }, b = { name: null, style_class: 'panel-button guava-menubar-logo' };
    const c = { name: 'panel', style_class: 'panel' }, d = { name: 'x', style_class: 'my-guava-x' };
    const own = { name: 'guava-lock-clock' };
    eq(isGuavaActor(d), false);
    eq(sweepTargets([a, b, c, d, own], new Set([own])), [a, b]);
    const wrapper = { name: null, style_class: 'panel-button', get_children: () => [b] };
    eq(sweepTargets([wrapper, c], new Set()), [wrapper], 'a wrapper of a Guava child');
});

function feature(log, id, cleanups) {
    return class {
        constructor(ctx, cleanup) {
            cleanups[id] = cleanup;
            cleanup.surface(actor());
        }

        enable() { log.push(`+${id}`); }
        disable() { log.push(`-${id}`); }
        lock() { log.push(`lock:${id}`); }
        unlock() { log.push(`unlock:${id}`); }
    };
}

test('registry: setLocked suspends normal features, notifies lockScreen ones', () => {
    const log = [], cleanups = {};
    const reg = new FeatureRegistry(CleanupRegistry);
    reg.register({ id: 'a', cls: feature(log, 'a', cleanups) });
    reg.register({ id: 'b', lockScreen: true, cls: feature(log, 'b', cleanups) });
    reg.start({ settings: { get_boolean: () => true } });
    const vis = id => [...cleanups[id]._surfaces][0].visible;
    reg.setLocked(true);
    eq([vis('a'), vis('b')], [false, true]);
    reg.setLocked(true);
    reg.setLocked(false);
    eq([vis('a'), vis('b')], [true, true]);
    eq(log, ['+a', '+b', 'lock:b', 'unlock:b']);   // no teardown, one notification each
});

test('registry: a feature that starts while locked starts suspended', () => {
    const log = [], cleanups = {};
    const flags = { a: false };
    const reg = new FeatureRegistry(CleanupRegistry);
    reg.register({ id: 'a', setting: 'a', cls: feature(log, 'a', cleanups) });
    reg.register({ id: 'b', lockScreen: true, setting: 'b', cls: feature(log, 'b', cleanups) });
    const ctx = { settings: { get_boolean: k => k === 'b' || !!flags[k] } };
    reg.start(ctx);
    reg.setLocked(true);
    flags.a = true;
    reg.refresh('a');
    eq([...cleanups.a._surfaces][0].visible, false);
    eq(log, ['+b', 'lock:b', '+a']);
    reg.setLocked(false);
    eq([...cleanups.a._surfaces][0].visible, true);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
