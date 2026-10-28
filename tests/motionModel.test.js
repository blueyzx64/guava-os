// Run: gjs -m tests/motionModel.test.js
import { DURATIONS, CURVES, SPRINGS, REDUCED_MAX_MS, TRANSFORM_PROPS, resolve, splitProps, springAt, springDuration, springKeyframes } from '../core/motionModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(c, msg) {
    if (!c)
        throw new Error(msg);
}
const ON = { reducedMotion: false, animations: true };

test('named durations and curves', () => {
    eq(resolve({ duration: 'short', curve: 'emphasized' }, ON), { duration: DURATIONS.short, mode: CURVES.emphasized, spring: null, transforms: true });
    eq(resolve({}, ON).duration, DURATIONS.medium);
    eq(resolve({ duration: 123 }, ON).duration, 123);
});
test('unknown names throw', () => {
    for (const bad of [{ duration: 'slowish' }, { curve: 'bouncy' }, { spring: 'wobbly' }]) {
        let threw = false;
        try { resolve(bad, ON); } catch (_e) { threw = true; }
        ok(threw, JSON.stringify(bad));
    }
});
test('animations off: everything at once', () => {
    eq(resolve({ duration: 'long', spring: 'bouncy' }, { reducedMotion: false, animations: false }),
        { duration: 0, mode: CURVES.linear, spring: null, transforms: false });
});
test('reduced motion: short crossfade, no transforms, no springs', () => {
    const r = resolve({ duration: 'extraLong', spring: 'bouncy' }, { reducedMotion: true, animations: true });
    eq(r.transforms, false);
    eq(r.spring, null);
    ok(r.duration <= REDUCED_MAX_MS, 'capped');
    eq(resolve({ duration: 'micro' }, { reducedMotion: true, animations: true }).duration, DURATIONS.micro);
});
test('splitProps moves transforms to jump only when asked', () => {
    eq(splitProps({ opacity: 255, scale_x: 1, translation_y: 0 }, false),
        { animate: { opacity: 255 }, jump: { scale_x: 1, translation_y: 0 } });
    eq(splitProps({ opacity: 0, x: 5 }, true), { animate: { opacity: 0, x: 5 }, jump: {} });
});
test('springs: start at 0, settle at 1; under-damped overshoots, critical does not', () => {
    for (const s of Object.values(SPRINGS)) {
        eq(springAt(s, 0), 0);
        ok(Math.abs(springAt(s, 5) - 1) < 1e-4, 'settles');
    }
    let peak = 0;
    for (let t = 0; t < 2; t += 0.005)
        peak = Math.max(peak, springAt(SPRINGS.bouncy, t));
    ok(peak > 1.02, `bouncy overshoots (${peak})`);
    let max = 0;
    for (let t = 0; t < 2; t += 0.005)
        max = Math.max(max, springAt(SPRINGS.smooth, t));
    ok(max <= 1 + 1e-9, 'smooth never overshoots');
});
test('spring durations are bounded and ordered by response', () => {
    const snappy = springDuration(SPRINGS.snappy);
    const bouncy = springDuration(SPRINGS.bouncy);
    ok(snappy > 100 && snappy < 1500, `snappy ${snappy}`);
    ok(bouncy > snappy, 'a slower spring takes longer');
    eq(resolve({ spring: 'snappy' }, ON).duration, snappy);
});
test('keyframes: evenly spaced, end exactly at the target', () => {
    const k = springKeyframes(SPRINGS.bouncy, 10);
    eq(k.keys.length, 10);
    eq(k.keys[0], 0);
    eq(k.keys[9], 1);
    eq(k.values[0], 0);
    eq(k.values[9], 1);
});

// ---- hardening (H2) ---------------------------------------------------------------------
const REDUCED = { reducedMotion: true, animations: true };
const OFF = { reducedMotion: false, animations: false };
function throws(fn) {
    try { fn(); } catch (_e) { return true; }
    return false;
}

test('presets are frozen and every curve name maps to a mode', () => {
    for (const o of [DURATIONS, CURVES, SPRINGS, TRANSFORM_PROPS, ...Object.values(SPRINGS)])
        ok(Object.isFrozen(o), 'frozen');
    for (const name of Object.keys(CURVES))
        eq(resolve({ curve: name }, ON).mode, CURVES[name]);
    for (const name of Object.keys(DURATIONS))
        eq(resolve({ duration: name }, ON).duration, DURATIONS[name]);
});
test('zero durations: instant, 0 and negatives resolve to 0 in every env', () => {
    for (const env of [ON, REDUCED, OFF]) {
        eq(resolve({ duration: 'instant' }, env).duration, 0);
        eq(resolve({ duration: 0 }, env).duration, 0);
        eq(resolve({ duration: -50 }, env).duration, 0, 'negative clamped');
    }
    eq(resolve({ duration: 0 }, ON).transforms, true, 'zero duration still keeps transforms on');
});
test('numeric strings are not durations', () => {
    ok(throws(() => resolve({ duration: '100' }, ON)), "'100' is not a name");
});
test('default arguments: resolve() is medium, standard, animated', () => {
    eq(resolve(), { duration: DURATIONS.medium, mode: CURVES.standard, spring: null, transforms: true });
    eq(resolve(undefined, ON), resolve());
});
test('validation happens before env: a bad name throws even with animations off', () => {
    for (const env of [OFF, REDUCED]) {
        ok(throws(() => resolve({ spring: 'wobbly' }, env)), 'spring');
        ok(throws(() => resolve({ curve: 'nope' }, env)), 'curve');
        ok(throws(() => resolve({ duration: 'nope' }, env)), 'duration');
    }
});
test('animations off wins over reduced motion', () => {
    eq(resolve({ duration: 'long' }, { reducedMotion: true, animations: false }),
        { duration: 0, mode: CURVES.linear, spring: null, transforms: false });
});
test('reduced motion: crossfade easing, exact cap, short requests kept', () => {
    eq(resolve({ duration: 'long', curve: 'emphasized' }, REDUCED),
        { duration: REDUCED_MAX_MS, mode: CURVES.enter, spring: null, transforms: false });
    eq(resolve({ duration: REDUCED_MAX_MS }, REDUCED).duration, REDUCED_MAX_MS);
    eq(resolve({ duration: REDUCED_MAX_MS + 1 }, REDUCED).duration, REDUCED_MAX_MS);
    eq(resolve({ duration: 1 }, REDUCED).duration, 1);
    const custom = { response: 0.05, damping: 1 };
    ok(resolve({ spring: custom }, REDUCED).duration <= Math.min(springDuration(custom), REDUCED_MAX_MS),
        'a quick spring is not lengthened');
});
test('springs: custom preset passes through by reference and overrides duration', () => {
    const custom = { response: 0.2, damping: 0.9 };
    const r = resolve({ spring: custom, duration: 'extraLong', curve: 'move' }, ON);
    ok(r.spring === custom, 'same object');
    eq(r.duration, springDuration(custom));
    eq(r.mode, CURVES.move, 'the curve is still reported');
    ok(resolve({ spring: 'snappy' }, ON).spring === SPRINGS.snappy, 'named preset');
});
test('springAt: negative time is at rest; response scales time', () => {
    eq(springAt(SPRINGS.bouncy, -1), 0);
    for (const s of Object.values(SPRINGS)) {
        const slow = { response: s.response * 2, damping: s.damping };
        for (const t of [0.05, 0.1, 0.3, 0.7])
            ok(Math.abs(springAt(s, t) - springAt(slow, 2 * t)) < 1e-9, `scaling at ${t}`);
    }
});
test('springAt: over-damped is treated as critical (monotonic, no overshoot)', () => {
    const over = { response: 0.4, damping: 3 };
    const crit = { response: 0.4, damping: 1 };
    let prev = 0;
    for (let t = 0.01; t < 3; t += 0.01) {
        const v = springAt(over, t);
        ok(v >= prev - 1e-12 && v <= 1 + 1e-12, `monotonic at ${t}`);
        eq(v, springAt(crit, t));
        prev = v;
    }
});
test('springAt: lower damping overshoots more', () => {
    const peak = d => {
        let p = 0;
        for (let t = 0; t < 2; t += 0.002)
            p = Math.max(p, springAt({ response: 0.5, damping: d }, t));
        return p;
    };
    ok(peak(0.3) > peak(0.6) && peak(0.6) > peak(0.9), 'ordered by damping');
});
test('springDuration: tighter tolerance takes longer; result stays bounded', () => {
    const s = SPRINGS.bouncy;
    ok(springDuration(s, 0.0001) > springDuration(s, 0.01), 'tolerance');
    ok(springDuration(SPRINGS.smooth) < springDuration({ response: 0.42, damping: 0.3 }), 'less damping, longer');
    const undamped = springDuration({ response: 0.5, damping: 0 }); // never settles
    ok(Number.isFinite(undamped) && undamped <= 10010, `bounded by the 10 s search (${undamped})`);
    for (const p of Object.values(SPRINGS)) {
        const d = springDuration(p);
        for (let t = d / 1000; t < d / 1000 + 1; t += 0.01)
            ok(Math.abs(1 - springAt(p, t)) <= 0.001 + 1e-9, `stays settled after ${d} ms`);
    }
});
test('keyframes: two keys is the minimum; values follow springAt; durations match', () => {
    const two = springKeyframes(SPRINGS.smooth, 2);
    eq(two.keys, [0, 1]);
    eq(two.values, [0, 1]);
    const k = springKeyframes(SPRINGS.snappy);
    eq(k.keys.length, 24);
    eq(k.duration, springDuration(SPRINGS.snappy));
    for (let i = 1; i < k.keys.length; i++)
        ok(k.keys[i] > k.keys[i - 1], 'strictly increasing keys');
    for (let i = 1; i < k.keys.length - 1; i++)
        ok(Math.abs(k.values[i] - springAt(SPRINGS.snappy, k.keys[i] * k.duration / 1000)) < 1e-12, `key ${i}`);
    const smooth = springKeyframes(SPRINGS.smooth, 30).values;
    for (let i = 1; i < smooth.length; i++)
        ok(smooth[i] >= smooth[i - 1], 'critically damped keyframes never go back');
});
test('cancellation in the pure model: resolve and keyframes are pure and repeatable', () => {
    // core/motion.js cancels by stopping the timeline where it is (onDone(false)) and a
    // retarget simply resolves again; the model must give the same plan each time and never
    // mutate its inputs, so a cancelled request can be replayed.
    const req = Object.freeze({ duration: 'long', curve: 'move' });
    eq(resolve(req, ON), resolve(req, ON));
    const spring = Object.freeze({ response: 0.35, damping: 0.75 });
    eq(springKeyframes(spring, 12), springKeyframes(spring, 12));
    const props = Object.freeze({ opacity: 0, x: 10, scale_y: 0.5 });
    const a = splitProps(props, false);
    const b = splitProps(props, false);
    ok(a.jump !== b.jump, 'fresh objects each call');
    eq(a, b);
    // A spring cut off part way is somewhere finite between rest and a bounded overshoot.
    for (let t = 0; t < 1; t += 0.02) {
        const v = springAt(SPRINGS.bouncy, t);
        ok(Number.isFinite(v) && v >= 0 && v < 1.5, `cut at ${t}`);
    }
});
test('splitProps: every transform prop jumps; opacity and unknown props animate', () => {
    const props = Object.fromEntries(TRANSFORM_PROPS.map(p => [p, 1]));
    props.opacity = 255;
    props.background_color = 'red';
    const { animate, jump } = splitProps(props, false);
    eq(Object.keys(jump).sort(), [...TRANSFORM_PROPS].sort());
    eq(animate, { opacity: 255, background_color: 'red' });
    eq(splitProps({}, false), { animate: {}, jump: {} });
    eq(splitProps({ x: 0 }, resolve({}, OFF).transforms), { animate: {}, jump: { x: 0 } }, 'off: jump');
});

// ---- bug fixes (board F1): a missing `animations` field means animations are on ----------
test('F1: reduced motion without an animations field stays reduced (animations default on)', () => {
    eq(resolve({ duration: 'extraLong', spring: 'bouncy' }, { reducedMotion: true }),
        resolve({ duration: 'extraLong', spring: 'bouncy' }, REDUCED));
    eq(resolve({ duration: 'long' }, { reducedMotion: true }).transforms, false);
    eq(resolve({ duration: 'long' }, { reducedMotion: true }).duration, REDUCED_MAX_MS);
});
test('F1: an env with neither field, or only reducedMotion false, is animated', () => {
    eq(resolve({ duration: 'long' }, {}), resolve({ duration: 'long' }, ON));
    eq(resolve({ duration: 'long' }, { reducedMotion: false }), resolve({ duration: 'long' }, ON));
    eq(resolve({ duration: 'long' }, { reducedMotion: false }).duration, DURATIONS.long);
});
test('F1: animations false still switches off with or without the other field', () => {
    eq(resolve({ duration: 'long' }, { animations: false }), resolve({ duration: 'long' }, OFF));
    eq(resolve({ duration: 'long' }, { reducedMotion: true, animations: false }).duration, 0);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
