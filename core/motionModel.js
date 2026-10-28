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
//   3. Otherwise the named duration and curve, or a spring.

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
 * Turn a request into what to animate.
 *
 * @param {{duration?: number|string, curve?: string, spring?: string|object}} request
 *   duration: ms or a DURATIONS name (default 'medium'); curve: a CURVES name (default
 *   'standard'); spring: a SPRINGS name or preset (overrides duration and curve)
 * @param {{reducedMotion: boolean, animations: boolean}} env
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
    if (env.reducedMotion)
        return { duration: Math.min(duration, REDUCED_MAX_MS), mode: CURVES.enter, spring: null, transforms: false };
    return { duration, mode: CURVES[curve], spring, transforms: true };
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
