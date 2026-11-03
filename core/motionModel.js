// SPDX-License-Identifier: GPL-3.0-or-later
// Motion rules shared by every Guava animation, so the dock bounce, the notch, Genie, Stage
// Manager flights and Mission Control feel like one OS, and the
// accessibility preferences are honoured in one place.
//
// Pure JS (no gi imports). core/motion.js applies these to Clutter actors.
//
// Rules (resolve()):
//   1. Animations off (org.gnome.desktop.interface enable-animations false): duration 0,
//      the end state is applied at once.
//   2. Reduced motion (org.gnome.desktop.a11y.interface reduced-motion 'reduce' on GNOME 50):
//      no movement, scaling or springs. Transform properties jump to their end value and only
//      opacity animates, as a short crossfade (at most REDUCED_MAX_MS, linear-ish easing).
//   3. Load (env.degraded, set by FrameBudget below): a request marked `decorative` (glass
//      shimmer, magnification, live previews) is treated like reduced motion: a short
//      crossfade, no movement. Requests that carry meaning (a window flight, a menu opening)
//      are never degraded: the user's core interactions keep their motion.
//   4. Otherwise the named duration and curve, or a spring.
//
// Interruption: springPlan() starts a spring from the current value AND the current velocity,
// so a new target that arrives mid-flight bends the motion instead of stopping it dead.

/** Named durations in ms (macOS-like: quick feedback, unhurried large moves). */
export const DURATIONS = Object.freeze({
    instant: 0,
    micro: 100,     // hover, press feedback
    short: 180,     // menus, popovers, small fades
    medium: 260,    // panels, the notch, Spotlight
    long: 400,      // window flights, Show Desktop
    extraLong: 550, // Genie, Mission Control
});

/** Named easing curves: Clutter.AnimationMode names (core/motion.js maps them). */
export const CURVES = Object.freeze({
    standard: 'EASE_OUT_CUBIC',
    emphasized: 'EASE_OUT_EXPO',
    enter: 'EASE_OUT_QUAD',
    exit: 'EASE_IN_CUBIC',
    move: 'EASE_IN_OUT_CUBIC',
    linear: 'LINEAR',
});

/**
 * Spring presets in SwiftUI terms: `response` is the period of the undamped oscillation in
 * seconds, `damping` the damping fraction (1 = critically damped, no overshoot).
 */
export const SPRINGS = Object.freeze({
    snappy: Object.freeze({ response: 0.3, damping: 0.86 }),
    smooth: Object.freeze({ response: 0.42, damping: 1 }),
    bouncy: Object.freeze({ response: 0.5, damping: 0.68 }),
    quick: Object.freeze({ response: 0.2, damping: 1 }),   // hover and highlight: fast, never past the target
});

/** Longest crossfade under reduced motion. */
export const REDUCED_MAX_MS = 150;

/** Actor properties that move or scale (dropped to their end value under reduced motion). */
export const TRANSFORM_PROPS = Object.freeze(['x', 'y', 'translation_x', 'translation_y', 'translation_z',
    'scale_x', 'scale_y', 'scale_z', 'rotation_angle_x', 'rotation_angle_y', 'rotation_angle_z',
    'pivot_point', 'width', 'height']);

/**
 * Easing functions of the CURVES (the Clutter.AnimationMode formulas, clutter-easing.c), p in
 * [0, 1] -> progress. Used to know where and how fast an ease is when it is interrupted, and
 * by the tests.
 */
export const CURVE_FNS = Object.freeze({
    EASE_OUT_CUBIC: p => 1 - (1 - p) ** 3,
    EASE_OUT_EXPO: p => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
    EASE_OUT_QUAD: p => 1 - (1 - p) * (1 - p),
    EASE_IN_CUBIC: p => p ** 3,
    EASE_IN_OUT_CUBIC: p => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
    LINEAR: p => p,
});

/**
 * Normalised spring progress at time t (s), from 0 at rest to 1 at the target. Under-damped
 * springs overshoot past 1 and settle.
 *
 * @param {{response: number, damping: number}} spring
 * @param {number} t seconds since the start
 * @returns {number}
 */
export function springAt({ response, damping }, t) {
    if (t <= 0)
        return 0;
    const w0 = (2 * Math.PI) / response;
    if (damping >= 1) {
        // Critically damped (over-damping is treated the same: no overshoot either way)
        return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
    }
    const wd = w0 * Math.sqrt(1 - damping * damping);
    const decay = Math.exp(-damping * w0 * t);
    return 1 - decay * (Math.cos(wd * t) + (damping * w0 / wd) * Math.sin(wd * t));
}

/**
 * Time (ms) after which the spring stays within `tolerance` of its target.
 *
 * @param {{response: number, damping: number}} spring
 * @param {number} [tolerance] fraction of the distance, default 0.001
 * @returns {number}
 */
export function springDuration(spring, tolerance = 0.001) {
    const step = 1 / 240;
    let last = 0;
    for (let t = step; t < 10; t += step) {
        if (Math.abs(1 - springAt(spring, t)) > tolerance)
            last = t;
        else if (t - last > spring.response)
            break;
    }
    return Math.round((last + step) * 1000);
}

/**
 * Keyframes for a spring, computed once per animation (never per frame): `count` evenly
 * spaced keys from 0 to 1 and the progress at each.
 *
 * @param {{response: number, damping: number}} spring
 * @param {number} [count] number of keys (>= 2)
 * @returns {{duration: number, keys: number[], values: number[]}}
 */
export function springKeyframes(spring, count = 24) {
    const duration = springDuration(spring);
    const keys = [];
    const values = [];
    for (let i = 0; i < count; i++) {
        const k = i / (count - 1);
        keys.push(k);
        values.push(i === count - 1 ? 1 : springAt(spring, (k * duration) / 1000));
    }
    return { duration, keys, values };
}

/**
 * A damped spring from an arbitrary start: displacement `e0` from the target and velocity `v0`
 * (units per second). Returns the displacement and velocity at time t (s); the value of the
 * animated property is `target + value`.
 *
 * @param {{response: number, damping: number}} spring
 * @param {number} t seconds
 * @param {number} e0 start - target
 * @param {number} [v0] start velocity
 * @returns {{value: number, velocity: number}}
 */
export function springState({ response, damping }, t, e0, v0 = 0) {
    if (t <= 0)
        return { value: e0, velocity: v0 };
    const w0 = (2 * Math.PI) / response;
    if (damping >= 1) {
        const b = v0 + w0 * e0;
        const ex = Math.exp(-w0 * t);
        return { value: (e0 + b * t) * ex, velocity: (b - w0 * (e0 + b * t)) * ex };
    }
    const z = damping * w0;
    const wd = w0 * Math.sqrt(1 - damping * damping);
    const b = (v0 + z * e0) / wd;
    const ex = Math.exp(-z * t);
    const c = Math.cos(wd * t);
    const sn = Math.sin(wd * t);
    return {
        value: ex * (e0 * c + b * sn),
        velocity: ex * ((b * wd - z * e0) * c - (e0 * wd + z * b) * sn),
    };
}

/**
 * Plan a spring from `from` to `to` that starts with `velocity` (units/s): evenly spaced keyframe
 * values computed once, a duration after which it stays within `tolerance` of the target, and
 * stateAt(ms) for a retarget (where it is and how fast it moves at that moment).
 *
 * @param {{response: number, damping: number}} spring
 * @param {number} from
 * @param {number} to
 * @param {number} [velocity]
 * @param {number} [count] keyframes (>= 2)
 * @param {number} [tolerance] fraction of the motion's scale
 * @returns {{duration: number, values: number[], stateAt: (ms: number) => {value: number, velocity: number}}}
 */
export function springPlan(spring, from, to, velocity = 0, count = 24, tolerance = 0.001) {
    const e0 = from - to;
    const w0 = (2 * Math.PI) / spring.response;
    // The motion's size: the distance, or how far the start velocity alone would carry it
    const scale = Math.max(Math.abs(e0), Math.abs(velocity) / w0);
    const stateAt = ms => {
        const st = springState(spring, ms / 1000, e0, velocity);
        return { value: to + st.value, velocity: st.velocity };
    };
    if (scale < 1e-9)
        return { duration: 0, values: [to, to], stateAt };
    const step = 1 / 240;
    let last = 0;
    for (let t = step; t < 10; t += step) {
        const st = springState(spring, t, e0, velocity);
        if (Math.abs(st.value) > tolerance * scale || Math.abs(st.velocity) > tolerance * scale * w0)
            last = t;
        else if (t - last > spring.response)
            break;
    }
    const duration = Math.round((last + step) * 1000);
    const values = [];
    for (let i = 0; i < count; i++)
        values.push(i === count - 1 ? to : to + springState(spring, (i / (count - 1)) * duration / 1000, e0, velocity).value);
    return { duration, values, stateAt };
}

/**
 * Value and velocity (units/s) of an ease at `ms` into it, for a retarget.
 *
 * @param {string} mode a CURVE_FNS key (Clutter.AnimationMode name)
 */
export function easeState(mode, from, to, duration, ms) {
    const f = CURVE_FNS[mode] ?? CURVE_FNS.LINEAR;
    if (duration <= 0 || ms >= duration)
        return { value: to, velocity: 0 };
    const p = Math.max(0, ms / duration);
    const h = 1e-4;
    const slope = (f(Math.min(1, p + h)) - f(Math.max(0, p - h))) / (Math.min(1, p + h) - Math.max(0, p - h));
    return { value: from + (to - from) * f(p), velocity: (to - from) * slope * 1000 / duration };
}

/**
 * Frame-budget monitor: decides when the Shell is too loaded for decorative motion. Feed it
 * the interval between painted frames; intervals longer than `idleMs` are idle gaps (nothing
 * was animating) and are ignored. Degraded when at least `enter` of the last `window` frames
 * were over budget; back to normal when fewer than `exit` of the last `window` were.
 * Hysteresis keeps one slow frame from flipping it back and forth.
 */
export class FrameBudget {
    /**
     * @param {{budgetMs?: number, window?: number, enter?: number, exit?: number, idleMs?: number}} [o]
     *   budgetMs: a frame slower than this is over budget (default 50: three frames at 60 Hz)
     */
    constructor({ budgetMs = 50, window = 30, enter = 0.4, exit = 0.1, idleMs = 250 } = {}) {
        Object.assign(this, { budgetMs, window, enter, exit, idleMs });
        this._slow = [];
        this.degraded = false;
    }

    /**
     * @param {number} intervalMs time since the previous painted frame
     * @returns {boolean} true when `degraded` changed
     */
    push(intervalMs) {
        if (!(intervalMs > 0) || intervalMs > this.idleMs)
            return false;
        this._slow.push(intervalMs > this.budgetMs ? 1 : 0);
        if (this._slow.length > this.window)
            this._slow.shift();
        if (this._slow.length < Math.min(10, this.window))
            return false;
        const ratio = this._slow.reduce((a, b) => a + b, 0) / this._slow.length;
        const next = this.degraded ? ratio >= this.exit : ratio >= this.enter;
        if (next === this.degraded)
            return false;
        this.degraded = next;
        return true;
    }

    reset() {
        this._slow = [];
        this.degraded = false;
    }
}

/**
 * Turn a request into what to animate.
 *
 * @param {{duration?: number|string, curve?: string, spring?: string|object, decorative?: boolean}} request
 *   duration: ms or a DURATIONS name (default 'medium'); curve: a CURVES name (default
 *   'standard'); spring: a SPRINGS name or preset (overrides duration and curve); decorative:
 *   ornament the desktop works without (degrades to a crossfade under load)
 * @param {{reducedMotion: boolean, animations: boolean, degraded?: boolean}} env
 * @returns {{duration: number, mode: string, spring: ?object, transforms: boolean}}
 *   transforms false: move and scale properties must jump to their end value
 */
export function resolve(request = {}, env = { reducedMotion: false, animations: true }) {
    // A missing `animations` field means animations are on (only an explicit false turns them off).
    const named = typeof request.duration === 'string' ? DURATIONS[request.duration] : request.duration;
    if (named === undefined && request.duration !== undefined)
        throw new Error(`motion: unknown duration '${request.duration}'`);
    const curve = request.curve ?? 'standard';
    if (!CURVES[curve])
        throw new Error(`motion: unknown curve '${curve}'`);
    let spring = null;
    if (request.spring) {
        spring = typeof request.spring === 'string' ? SPRINGS[request.spring] : request.spring;
        if (!spring)
            throw new Error(`motion: unknown spring '${request.spring}'`);
    }
    const duration = spring ? springDuration(spring) : Math.max(0, named ?? DURATIONS.medium);

    if (env.animations === false)
        return { duration: 0, mode: CURVES.linear, spring: null, transforms: false };
    if (env.reducedMotion || (env.degraded && request.decorative))
        return { duration: Math.min(duration, REDUCED_MAX_MS), mode: CURVES.enter, spring: null, transforms: false };
    return { duration, mode: CURVES[curve], spring, transforms: true };
}

/**
 * Whether ease() must show a hidden actor first. Clutter skips transitions on an unmapped actor
 * (the Shell's actor.ease sets duration 0 then), so a fade-in started before show() would jump
 * straight to its end: fading in (opacity animated above 0) means the caller wants it visible.
 *
 * @param {object} animate the properties that animate (splitProps().animate)
 * @param {boolean} visible actor.visible
 */
export function mustShowFirst(animate, visible) {
    return !visible && typeof animate.opacity === 'number' && animate.opacity > 0;
}

/**
 * Split actor properties into those to animate and those to set at once.
 *
 * @param {object} props target values
 * @param {boolean} transforms false under reduced motion / animations off
 * @returns {{animate: object, jump: object}}
 */
export function splitProps(props, transforms) {
    const animate = {};
    const jump = {};
    for (const [k, v] of Object.entries(props)) {
        if (!transforms && TRANSFORM_PROPS.includes(k))
            jump[k] = v;
        else
            animate[k] = v;
    }
    return { animate, jump };
}
