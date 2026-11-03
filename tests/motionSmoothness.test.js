// Run: gjs -m tests/motionSmoothness.test.js
// The smoothness contract of core/motionModel.js (the unit level of the perf suite, see
// tools/scenarios/README.md): curves start and end exactly, never go back, take bounded
// time; reduced motion / animations off / load rules hold; and an interrupted motion
// continues from where it is, at the speed it had.
import {
    CURVES, CURVE_FNS, DURATIONS, SPRINGS, REDUCED_MAX_MS, FrameBudget,
    easeState, mustShowFirst, resolve, springAt, springDuration, springPlan, springState,
} from '../core/motionModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function ok(c, msg) {
    if (!c)
        throw new Error(msg);
}
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const ON = { reducedMotion: false, animations: true };
// Numeric derivative (units per second) of a function of time in seconds
const deriv = (f, t, h = 1e-5) => (f(t + h) - f(t - h)) / (2 * h);

// ---- curves ----------------------------------------------------------------------------
test('every named curve has an easing function', () => {
    for (const mode of Object.values(CURVES))
        ok(typeof CURVE_FNS[mode] === 'function', mode);
});
test('curves: exact endpoints', () => {
    for (const [mode, f] of Object.entries(CURVE_FNS)) {
        near(f(0), 0, 1e-12, `${mode}(0)`);
        near(f(1), 1, 1e-12, `${mode}(1)`);
    }
});
test('curves: monotonic, never past the end (no reversal, no overshoot)', () => {
    for (const [mode, f] of Object.entries(CURVE_FNS)) {
        let prev = f(0);
        for (let i = 1; i <= 1000; i++) {
            const v = f(i / 1000);
            ok(v >= prev - 1e-12, `${mode} goes back at ${i / 1000}`);
            ok(v <= 1 + 1e-12, `${mode} overshoots at ${i / 1000}`);
            prev = v;
        }
    }
});
test('curves: no jump inside (largest 1 ms step of a 260 ms ease is small)', () => {
    // A 260 ms ease painted at 1 ms resolution: no step may carry more than ~4% of the motion
    // (EASE_OUT_EXPO's fast start is the steepest; its tail snaps the last 0.1% at p = 1)
    for (const [mode, f] of Object.entries(CURVE_FNS)) {
        let maxStep = 0;
        for (let i = 1; i <= 260; i++)
            maxStep = Math.max(maxStep, f(i / 260) - f((i - 1) / 260));
        ok(maxStep < 0.04, `${mode} step ${maxStep}`);
    }
});
test('curves: ease-outs start fast and land slow; ease-in the reverse', () => {
    for (const mode of ['EASE_OUT_CUBIC', 'EASE_OUT_EXPO', 'EASE_OUT_QUAD']) {
        const f = CURVE_FNS[mode];
        ok(f(0.1) - f(0) > f(1) - f(0.9), `${mode} lands slower than it starts`);
    }
    const f = CURVE_FNS.EASE_IN_CUBIC;
    ok(f(0.1) - f(0) < f(1) - f(0.9), 'EASE_IN_CUBIC');
});

// ---- durations ---------------------------------------------------------------------------
test('durations are bounded: nothing named takes longer than 600 ms', () => {
    for (const [name, ms] of Object.entries(DURATIONS))
        ok(ms >= 0 && ms <= 600, `${name} ${ms}`);
    ok(DURATIONS.micro < DURATIONS.short && DURATIONS.short < DURATIONS.medium &&
        DURATIONS.medium < DURATIONS.long && DURATIONS.long < DURATIONS.extraLong, 'ordered');
});
test('springs settle in bounded time (under 1.5 s), quick ones under 400 ms', () => {
    for (const [name, s] of Object.entries(SPRINGS))
        ok(springDuration(s) <= 1500, `${name} ${springDuration(s)}`);
    ok(springDuration(SPRINGS.quick) <= 400, `quick ${springDuration(SPRINGS.quick)}`);
});
test('critically damped presets never overshoot; quick and smooth are monotonic', () => {
    for (const name of ['quick', 'smooth']) {
        let prev = 0;
        for (let t = 0.002; t < 2; t += 0.002) {
            const v = springAt(SPRINGS[name], t);
            ok(v >= prev - 1e-12 && v <= 1 + 1e-12, `${name} at ${t}`);
            prev = v;
        }
    }
});
test('springs: overshoot of the bouncy preset stays within 15%', () => {
    let peak = 0;
    for (let t = 0; t < 2; t += 0.002)
        peak = Math.max(peak, springAt(SPRINGS.bouncy, t));
    ok(peak > 1 && peak < 1.15, `peak ${peak}`);
});

// ---- environment rules -------------------------------------------------------------------
test('animations off: every request is instant, whatever the load', () => {
    for (const req of [{ duration: 'long' }, { spring: 'bouncy' }, { duration: 'short', decorative: true }])
        ok(resolve(req, { reducedMotion: false, animations: false, degraded: true }).duration === 0, JSON.stringify(req));
});
test('reduced motion: no transforms, crossfade capped', () => {
    for (const req of [{ duration: 'extraLong' }, { spring: 'bouncy' }]) {
        const r = resolve(req, { reducedMotion: true, animations: true });
        ok(!r.transforms && !r.spring && r.duration <= REDUCED_MAX_MS, JSON.stringify(r));
    }
});
test('degraded: decorative motion becomes a short crossfade; core motion is untouched', () => {
    const LOADED = { reducedMotion: false, animations: true, degraded: true };
    const deco = resolve({ duration: 'long', decorative: true }, LOADED);
    ok(!deco.transforms && deco.duration <= REDUCED_MAX_MS, `decorative ${JSON.stringify(deco)}`);
    const decoSpring = resolve({ spring: 'bouncy', decorative: true }, LOADED);
    ok(!decoSpring.spring, 'decorative spring dropped');
    for (const req of [{ duration: 'long', curve: 'move' }, { spring: 'snappy' }])
        ok(JSON.stringify(resolve(req, LOADED)) === JSON.stringify(resolve(req, ON)), `core ${JSON.stringify(req)}`);
    ok(JSON.stringify(resolve({ duration: 'long', decorative: true }, ON)) ===
        JSON.stringify(resolve({ duration: 'long' }, ON)), 'decorative is normal when not loaded');
});

// ---- interruption: springs -----------------------------------------------------------------
test('springState from rest matches springAt', () => {
    for (const s of Object.values(SPRINGS)) {
        for (const t of [0, 0.03, 0.1, 0.25, 0.6, 1.2])
            near(1 + springState(s, t, -1, 0).value, springAt(s, t), 1e-12, `t=${t}`);
    }
});
test('springState velocity is the derivative of its position', () => {
    for (const s of [...Object.values(SPRINGS), { response: 0.4, damping: 2 }]) {
        for (const [e0, v0] of [[-1, 0], [-100, 800], [30, -2500], [0, 400]]) {
            for (const t of [0.01, 0.07, 0.2, 0.5]) {
                const v = springState(s, t, e0, v0).velocity;
                const d = deriv(x => springState(s, x, e0, v0).value, t);
                near(v, d, 1e-3 * (1 + Math.abs(d)), `${JSON.stringify(s)} e0=${e0} v0=${v0} t=${t}`);
            }
        }
    }
});
test('springPlan: starts at from, ends exactly at to, starts with the given velocity', () => {
    for (const s of Object.values(SPRINGS)) {
        const p = springPlan(s, 40, 300, -900);
        near(p.values[0], 40, 1e-9, 'start');
        ok(p.values[p.values.length - 1] === 300, 'exact end');
        near(p.stateAt(0).velocity, -900, 1e-9, 'start velocity');
        near(p.stateAt(p.duration).value, 300, 0.001 * 900, 'settled at the duration');
        ok(p.duration > 0 && p.duration <= 2500, `bounded ${p.duration}`);
    }
});
test('springPlan: nothing to do is instant', () => {
    const p = springPlan(SPRINGS.snappy, 12, 12, 0);
    ok(p.duration === 0 && p.values[p.values.length - 1] === 12, JSON.stringify(p.values));
});
test('retarget mid-flight: position and velocity are continuous (no jump, no dead stop)', () => {
    // A dock icon springs 0 -> 100; at 80 ms the target moves to 40 (the pointer went back).
    // The takeover (core/motion.js spring()) starts the new plan at the current value with the
    // current velocity: the curve must be C1-continuous at the handoff.
    for (const s of Object.values(SPRINGS)) {
        const first = springPlan(s, 0, 100, 0);
        const at = first.stateAt(80);
        const second = springPlan(s, at.value, 40, at.velocity);
        const after = second.stateAt(0);
        near(after.value, at.value, 1e-9, 'position');
        near(after.velocity, at.velocity, 1e-9, 'velocity');
        // Within one 16 ms frame on either side, the step sizes are alike (no jump)
        const before = at.value - first.stateAt(64).value;
        const next = second.stateAt(16).value - at.value;
        ok(Math.abs(next) < Math.abs(before) * 1.6 + 0.5, `step ${before} -> ${next}`);
        near(second.stateAt(second.duration).value, 40, 0.1, 'reaches the new target');
    }
});
test('retarget with a stopped spring (velocity 0) keeps the old behaviour', () => {
    const p = springPlan(SPRINGS.snappy, 0, 1, 0, 24);
    for (let i = 1; i < 23; i++) {
        const t = (i / 23) * p.duration / 1000;
        near(p.values[i], springAt(SPRINGS.snappy, t), 1e-12, `key ${i}`);
    }
});
test('many retargets in a row (hover spam) stay bounded and never run away', () => {
    let plan = springPlan(SPRINGS.quick, 0, 1, 0);
    let st = plan.stateAt(0);
    let min = 0;
    let max = 0;
    for (let i = 0; i < 200; i++) {
        st = plan.stateAt(12);
        min = Math.min(min, st.value);
        max = Math.max(max, st.value);
        plan = springPlan(SPRINGS.quick, st.value, i % 2 ? 1 : 0, st.velocity);
    }
    ok(min > -0.2 && max < 1.2, `range ${min}..${max}`);
});

// ---- interruption: eases ---------------------------------------------------------------------
test('easeState: value follows the curve, velocity is its derivative, end is at rest', () => {
    for (const mode of Object.values(CURVES)) {
        const f = ms => easeState(mode, 10, 210, 260, ms).value;
        near(f(0), 10, 1e-9, `${mode} start`);
        near(easeState(mode, 10, 210, 260, 260).value, 210, 1e-9, `${mode} end`);
        ok(easeState(mode, 10, 210, 260, 400).velocity === 0, 'at rest after');
        for (const ms of [30, 130, 220]) {
            const v = easeState(mode, 10, 210, 260, ms).velocity;
            const d = deriv(t => f(t * 1000), ms / 1000);
            near(v, d, 0.01 * Math.abs(d) + 1, `${mode} at ${ms}`);
        }
    }
});
test('an ease interrupted by a spring hands over its velocity continuously', () => {
    const at = easeState('EASE_OUT_CUBIC', 0, 200, 260, 60);
    const p = springPlan(SPRINGS.snappy, at.value, 0, at.velocity);
    near(p.stateAt(0).value, at.value, 1e-9, 'position');
    near(p.stateAt(0).velocity, at.velocity, 1e-9, 'velocity');
});

test('a fade-in on a hidden actor shows it first (else Clutter skips the transition)', () => {
    ok(mustShowFirst({ opacity: 255 }, false), 'hidden + fade in');
    ok(!mustShowFirst({ opacity: 255 }, true), 'already visible');
    ok(!mustShowFirst({ opacity: 0 }, false), 'fade out of a hidden actor: leave it hidden');
    ok(!mustShowFirst({ scale_x: 1 }, false), 'no opacity: the caller decides');
});

// ---- load monitor ----------------------------------------------------------------------------
test('FrameBudget: smooth frames never degrade; idle gaps are ignored', () => {
    const b = new FrameBudget();
    for (let i = 0; i < 300; i++)
        b.push(16.7);
    for (let i = 0; i < 50; i++)
        b.push(5000);
    ok(!b.degraded, 'smooth');
});
test('FrameBudget: one hiccup does not degrade; sustained slow frames do', () => {
    const b = new FrameBudget();
    for (let i = 0; i < 60; i++)
        b.push(i === 30 ? 200 : 16.7);
    ok(!b.degraded, 'a single hiccup');
    let flips = 0;
    for (let i = 0; i < 30; i++)
        flips += b.push(80) ? 1 : 0;
    ok(b.degraded && flips === 1, `degraded once (${flips})`);
});
test('FrameBudget: hysteresis: recovers only after mostly good frames, without flapping', () => {
    const b = new FrameBudget();
    for (let i = 0; i < 30; i++)
        b.push(80);
    ok(b.degraded, 'degraded');
    let flips = 0;
    // A mix around the exit line (20% slow) keeps it degraded: no flapping
    for (let i = 0; i < 100; i++)
        flips += b.push(i % 5 === 0 ? 80 : 16) ? 1 : 0;
    ok(b.degraded && flips === 0, `stays degraded at 20% slow (${flips})`);
    for (let i = 0; i < 30; i++)
        flips += b.push(16) ? 1 : 0;
    ok(!b.degraded && flips === 1, 'recovers once');
});
test('FrameBudget: needs a few frames before deciding; reset clears', () => {
    const b = new FrameBudget();
    for (let i = 0; i < 5; i++)
        b.push(200);
    ok(!b.degraded, 'too few frames');
    for (let i = 0; i < 20; i++)
        b.push(200);
    ok(b.degraded, 'then degraded');
    b.reset();
    ok(!b.degraded, 'reset');
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
