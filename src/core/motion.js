// SPDX-License-Identifier: GPL-3.0-or-later
// Motion: one animation service for every Guava surface (the Shell side of motionModel.js).
//
//   const anim = ctx.motion.ease(actor, { opacity: 255, scale_x: 1, scale_y: 1 },
//       { duration: 'medium', curve: 'emphasized', onDone: finished => ... }, cleanup);
//   anim.cancel();                      // stops where it is; onDone(false)
//   ctx.motion.spring(actor, 'translation_y', 0, { spring: 'bouncy' }, cleanup);
//   ctx.motion.tween(actor, { duration: 'extraLong', curve: 'linear' }, p => ..., cleanup);
//   ctx.motion.env;                     // {reducedMotion, animations, degraded}
//   ctx.motion.ease(glass, {...}, { duration: 'long', decorative: true });  // degrades under load
//
// Load: a FrameBudget (motionModel.js) watches the interval between painted frames (one
// after-paint handler; no timer, so an idle Shell wakes up for nothing). When most recent
// frames blow the budget, env.degraded turns true and 'motion-changed' fires: decorative
// requests become short crossfades, and features with costly ornaments (live blur,
// magnification, live previews) read env.degraded to drop them until it clears.
//
// Every animation goes through motionModel.resolve(), so animations-off and reduced motion
// are honoured here and nowhere else: features never read those settings themselves. With
// an `owner` (a CleanupRegistry) the animation is cancelled when the owner is disposed, so
// disable() never leaves a transition running on an actor.
//
// Hot path: ease() hands the work to Clutter (actor.ease); spring() runs one Clutter.Timeline
// whose new-frame handler interpolates a table computed once, and allocates nothing per frame.
//
// Shell API: actor.ease (js/ui/environment.js), St.Settings (enable-animations,
// slow-down-factor), lib/compat.js watchReducedMotion.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { CleanupRegistry } from '../lib/disposables.js';
import { watchReducedMotion } from '../lib/compat.js';
import { FrameBudget, mustShowFirst, resolve, splitProps, springPlan } from './motionModel.js';

const NOOP_HANDLE = Object.freeze({ cancel() {}, get running() { return false; } });

// Clutter names transitions after the property's canonical (dashed) name
const transitionName = prop => prop.replace(/_/g, '-');

export class Motion {
    /** @param {import('./events.js').EventHub} events */
    constructor(events) {
        this._events = events;
        this._env = { reducedMotion: false, animations: true, degraded: false };
        this._cleanup = null;
        // actor -> Map(prop -> running spring {handle, velocityNow}): a new spring on the same
        // property takes over from the running one, at its position and velocity
        this._springs = new WeakMap();
    }

    /** Start following the system preferences (extension enable). */
    start() {
        if (this._cleanup)
            return;
        const cleanup = new CleanupRegistry();
        this._cleanup = cleanup;
        const st = St.Settings.get();
        const budget = new FrameBudget();
        const sync = () => {
            const next = { reducedMotion: this._reduced, animations: !!st.enable_animations, degraded: budget.degraded };
            if (next.reducedMotion === this._env.reducedMotion && next.animations === this._env.animations &&
                next.degraded === this._env.degraded)
                return;
            this._env = next;
            this._events.emit('motion-changed', { ...next });
        };
        this._reduced = false;
        watchReducedMotion(cleanup, reduced => {
            this._reduced = reduced;
            sync();
        });
        cleanup.connect(st, 'notify::enable-animations', sync);
        let last = 0;
        cleanup.connect(global.stage, 'after-paint', () => {
            const now = GLib.get_monotonic_time();
            const interval = (now - last) / 1000;
            last = now;
            // Several views paint in one frame: only frame-to-frame intervals count
            if (interval > 1 && budget.push(interval))
                sync();
        });
        sync();
    }

    /** Stop following them (extension disable). */
    stop() {
        this._cleanup?.dispose();
        this._cleanup = null;
    }

    /** @returns {{reducedMotion: boolean, animations: boolean}} a copy */
    get env() {
        return { ...this._env };
    }

    /** The resolved duration (ms) of a request, e.g. to time a follow-up. */
    duration(request) {
        return resolve(request, this._env).duration;
    }

    /**
     * Animate actor properties with a named duration and curve (or a spring preset, which
     * then only sets the duration; use spring() for real overshoot).
     *
     * @param {Clutter.Actor} actor
     * @param {object} props target values (GObject property names, e.g. scale_x)
     * @param {{duration?: number|string, curve?: string, spring?: string|object,
     *   delay?: number, repeat?: number, autoReverse?: boolean,
     *   onDone?: (finished: boolean) => void}} [request] repeat: extra runs (-1 forever), with
     *   autoReverse running every other one backwards (a wobble); a repeat that only moves is
     *   dropped to its end value under reduced motion like any transform
     * @param {{add: Function, release?: Function}} [owner] cancels it on dispose
     * @returns {{cancel: Function, running: boolean}}
     */
    ease(actor, props, request = {}, owner = null) {
        const plan = resolve(request, this._env);
        const { animate, jump } = splitProps(props, plan.transforms);
        if (Object.keys(jump).length)
            actor.set(jump);
        const names = Object.keys(animate);
        if (!names.length || plan.duration === 0) {
            if (names.length)
                actor.set(animate);
            request.onDone?.(true);
            return NOOP_HANDLE;
        }
        // A fade-in on a hidden actor: show it first or Clutter skips the transition
        if (mustShowFirst(animate, actor.visible))
            actor.show();
        let running = true;
        let token = 0;
        const finish = finished => {
            if (!running)
                return;
            running = false;
            if (token)
                owner?.release?.(token);
            request.onDone?.(finished);
        };
        const handle = {
            cancel: () => {
                if (!running)
                    return;
                for (const n of names)
                    actor.remove_transition(transitionName(n));
                finish(false);
            },
            get running() {
                return running;
            },
        };
        token = owner?.add(() => handle.cancel()) ?? 0;
        actor.ease({
            ...animate,
            duration: plan.duration,
            delay: request.delay ?? 0,
            repeatCount: request.repeat ?? 0,
            autoReverse: !!request.autoReverse,
            mode: Clutter.AnimationMode[plan.mode],
            onStopped: isFinished => finish(isFinished),
        });
        return handle;
    }

    /**
     * Drive a progress from 0 to 1 (or 1 to 0 with `reverse`) for what is not an actor
     * property: a mesh deform, a computed layout. `onFrame(progress)` runs once per frame and
     * last with the end value. Animations off: onFrame(end) at once. Under reduced motion the
     * duration is the short crossfade one; the caller (who reads `env`) draws a fade instead
     * of movement.
     *
     * @param {Clutter.Actor} actor whose frame clock times it
     * @param {{duration?: number|string, curve?: string, reverse?: boolean,
     *   onDone?: (finished: boolean) => void}} request
     * @param {(progress: number) => void} onFrame
     * @param {{add: Function, release?: Function}} [owner]
     * @returns {{cancel: Function, running: boolean}}
     */
    tween(actor, request, onFrame, owner = null) {
        const plan = resolve(request, this._env);
        const from = request.reverse ? 1 : 0;
        const span = request.reverse ? -1 : 1;
        if (plan.duration === 0) {
            onFrame(from + span);
            request.onDone?.(true);
            return NOOP_HANDLE;
        }
        const timeline = new Clutter.Timeline({
            actor,
            duration: Math.round(plan.duration * (St.Settings.get().slow_down_factor || 1)),
            progress_mode: Clutter.AnimationMode[plan.mode],
        });
        let running = true;
        let token = 0;
        const finish = finished => {
            if (!running)
                return;
            running = false;
            timeline.disconnect(frameId);
            timeline.disconnect(doneId);
            if (destroyId)
                actor.disconnect(destroyId);
            timeline.stop();
            if (token)
                owner?.release?.(token);
            request.onDone?.(finished);
        };
        const frameId = timeline.connect('new-frame', () => onFrame(from + span * timeline.get_progress()));
        const doneId = timeline.connect('completed', () => {
            onFrame(from + span);
            finish(true);
        });
        let destroyId = actor.connect('destroy', () => {
            destroyId = 0;
            finish(false);
        });
        const handle = {
            cancel: () => finish(false),
            get running() {
                return running;
            },
        };
        token = owner?.add(() => handle.cancel()) ?? 0;
        onFrame(from);
        timeline.start();
        return handle;
    }

    /**
     * Spring one numeric property to `to`. Under reduced motion or with animations off it
     * becomes ease() (a short fade for opacity, a jump for transforms). A spring still running
     * on the same property is taken over (it ends with onDone(false)): the new one starts at
     * its position and velocity, so retargeting mid-flight never jerks.
     *
     * @param {Clutter.Actor} actor
     * @param {string} prop e.g. 'translation_y', 'scale_x', 'opacity'
     * @param {number} to
     * @param {{spring?: string|object, onDone?: Function}} [request] spring defaults to 'snappy'
     * @param {{add: Function, release?: Function}} [owner]
     * @returns {{cancel: Function, running: boolean}}
     */
    spring(actor, prop, to, request = {}, owner = null) {
        // A spring already moving this property hands over its velocity (and stops): the
        // motion bends towards the new target instead of stopping dead or two timelines
        // fighting over one property
        const live = this._springs.get(actor)?.get(prop);
        const velocity = live?.handle.running ? live.velocityNow() : 0;
        live?.handle.cancel();

        const plan = resolve({ spring: request.spring ?? 'snappy' }, this._env);
        if (!plan.spring)
            return this.ease(actor, { [prop]: to }, { duration: plan.duration, onDone: request.onDone }, owner);

        const from = actor[prop];
        const { duration, values, stateAt } = springPlan(plan.spring, from, to, velocity);
        actor.remove_transition(transitionName(prop));
        if (duration === 0) {
            actor[prop] = to;
            request.onDone?.(true);
            return NOOP_HANDLE;
        }
        const slow = St.Settings.get().slow_down_factor || 1;
        const timeline = new Clutter.Timeline({ actor, duration: Math.round(duration * slow) });
        const last = values.length - 1;
        let running = true;
        let token = 0;
        let props = this._springs.get(actor);
        if (!props)
            this._springs.set(actor, props = new Map());
        const finish = finished => {
            if (!running)
                return;
            running = false;
            timeline.disconnect(frameId);
            timeline.disconnect(doneId);
            if (destroyId)
                actor.disconnect(destroyId);
            timeline.stop();
            if (props.get(prop)?.handle === handle)
                props.delete(prop);
            if (token)
                owner?.release?.(token);
            request.onDone?.(finished);
        };
        const frameId = timeline.connect('new-frame', () => {
            const p = timeline.get_progress();
            // Keys are evenly spaced: index straight into the table, then interpolate
            const pos = p * last;
            const i = Math.min(last - 1, Math.floor(pos));
            actor[prop] = values[i] + (values[i + 1] - values[i]) * (pos - i);
        });
        const doneId = timeline.connect('completed', () => {
            actor[prop] = to;
            finish(true);
        });
        // The owner may destroy the actor mid-flight: stop before the next frame touches it
        let destroyId = actor.connect('destroy', () => {
            destroyId = 0;
            finish(false);
        });
        const handle = {
            cancel: () => finish(false),
            get running() {
                return running;
            },
        };
        // Velocity in property units per second of model time (slow-down-factor stretches both)
        props.set(prop, { handle, velocityNow: () => stateAt(timeline.get_elapsed_time() / slow).velocity / slow });
        token = owner?.add(() => handle.cancel()) ?? 0;
        timeline.start();
        return handle;
    }

    /**
     * Spring several numeric properties of one actor at once (a rect: x, y, width, height).
     * Springing the same properties again takes over from these (see spring()).
     *
     * @param {Clutter.Actor} actor
     * @param {Object<string, number>} targets property -> end value
     * @param {{spring?: string|object, onDone?: (finished: boolean) => void}} [request]
     *   onDone runs once, when the last one ends; finished is false if any was cancelled
     * @param {{add: Function, release?: Function}} [owner]
     * @returns {{cancel: Function, running: boolean}}
     */
    springs(actor, targets, request = {}, owner = null) {
        let pending = Object.keys(targets).length;
        let allFinished = true;
        const done = finished => {
            allFinished &&= finished;
            if (--pending === 0)
                request.onDone?.(allFinished);
        };
        const handles = Object.entries(targets).map(([prop, to]) =>
            this.spring(actor, prop, to, { spring: request.spring, onDone: done }, owner));
        return {
            cancel: () => handles.forEach(h => h.cancel()),
            get running() {
                return handles.some(h => h.running);
            },
        };
    }
}
