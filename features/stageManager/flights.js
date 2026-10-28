// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager flights: a window visibly travels between its frame on the stage and its
// slot in the strip, growing or shrinking and turning into (or out of) the strip's tilt.
//
// A flight never moves the real window actor (easing a live window stutters while the app
// draws). It flies a Clutter.Clone of it in the view's flight layer, through core/motion, so
// reduced motion and animations-off apply and every flight is cancellable: cancelAll() runs
// from the feature's cleanup. While a window flies onto the stage its actor stays at
// opacity 0 and gets its opacity back when the clone lands, so it never shows twice.
// Under reduced motion a flight is a short crossfade in place.
//
// Private API: none.

import Clutter from 'gi://Clutter';

import { clonePose } from './geometry.js';
import { attachThumbEffect } from './thumbEffect.js';

export const FLIGHT_MS = 420;

const rectOf = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });

export class Flights {
    /**
     * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup
     * @param {object} env
     * @param {Clutter.Actor} env.layer where clones fly
     * @param {import('../../core/motion.js').Motion} env.motion
     * @param {(ms: number) => number} env.ms a duration under the animation speed
     * @param {() => {radius: number, mask: number[]}} env.corners thumbEffect.cornerSpec of the settings
     * @param {(win: Meta.Window, toStage: boolean) => void} env.onLanded
     */
    constructor(cleanup, { layer, motion, ms, corners, onLanded }) {
        this._layer = layer;
        this._motion = motion;
        this._ms = ms;
        this._corners = corners;
        this._onLanded = onLanded;
        this._active = new Map();   // Meta.Window -> flight
        cleanup.add(() => this.cancelAll());
    }

    isFlying(win) {
        return this._active.has(win);
    }

    /** Windows in the air (tests, leak checks). */
    get count() {
        return this._active.size;
    }

    /**
     * Fly a clone of the window from one rect to another.
     * @param {Meta.Window} win
     * @param {object} p
     * @param {object} p.from rect (+ angle) where the frame is drawn at the start
     * @param {object} p.to   rect (+ angle) at the end
     * @param {boolean} p.toStage the window lands on the stage: its actor shows on landing
     * @param {number} p.opacity the actor's opacity once it lands on the stage
     * @returns {boolean} false when there was nothing to fly
     */
    fly(win, { from, to, toStage, opacity = 255 }) {
        const prev = this._active.get(win);
        if (prev) {
            // In the air already: start from where the clone is now
            from = this._where(prev) ?? from;
            this._end(win, prev, false);
        }
        const actor = win.get_compositor_private();
        if (!actor || !from || !to)
            return false;
        const frame = rectOf(win.get_frame_rect());
        const buffer = rectOf(win.get_buffer_rect());
        const reduced = this._motion.env.reducedMotion;
        // Reduced motion: a crossfade where the window is (on the stage)
        const start = reduced ? (toStage ? to : from) : from;
        const end = reduced ? start : to;
        const a = clonePose(frame, buffer, start);
        const b = clonePose(frame, buffer, end);
        if (!a || !b)
            return false;

        const clone = new Clutter.Clone({ source: actor, reactive: false });
        clone.set_size(buffer.width, buffer.height);
        clone.set_pivot_point(a.pivotX, a.pivotY);
        clone.set_position(a.x, a.y);
        clone.set_scale(a.scaleX, a.scaleY);
        clone.scale_z = a.scale;
        clone.rotation_angle_y = reduced ? 0 : start.angle ?? 0;
        attachThumbEffect(clone, buffer, { x: frame.x - buffer.x, y: frame.y - buffer.y, width: frame.width, height: frame.height },
            this._corners());
        clone.opacity = reduced && toStage ? 0 : 255;
        this._layer.add_child(clone);

        const flight = { clone, frame, buffer, actor, toStage, opacity, anim: null, painted: 0 };
        this._active.set(win, flight);
        if (toStage) {
            actor.remove_transition('opacity');
            actor.opacity = 0;
        }
        // The clone's first paint (texture, shader, layout) is the costly frame: let it draw at
        // the start pose first, so the tween's clock starts after it instead of skipping ahead
        flight.painted = global.stage.connect('after-paint', () => {
            global.stage.disconnect(flight.painted);
            flight.painted = 0;
            flight.anim = this._motion.ease(clone, {
                x: b.x, y: b.y, scale_x: b.scaleX, scale_y: b.scaleY, scale_z: b.scale,
                rotation_angle_y: reduced ? 0 : end.angle ?? 0,
                opacity: reduced && !toStage ? 0 : 255,
            }, {
                duration: this._ms(FLIGHT_MS), curve: 'emphasized',
                onDone: () => {
                    if (this._active.get(win) === flight)
                        this._end(win, flight, true);
                },
            });
        });
        clone.queue_redraw();
        return true;
    }

    /**
     * Land a window now (the caller is about to change its actor).
     * @returns {?object} where the clone was drawn, to start a new flight from
     */
    land(win) {
        const f = this._active.get(win);
        if (!f)
            return null;
        const at = this._where(f);
        this._end(win, f, true);
        return at;
    }

    /** Drop every clone; actors flying onto the stage get their opacity. Sync, safe twice. */
    cancelAll() {
        for (const [win, f] of [...this._active])
            this._end(win, f, false);
    }

    _where(f) {
        const c = f.clone;
        if (!c || c.scale_x <= 0)
            return null;
        const s = c.scale_x;
        const cx = c.x + f.frame.x - f.buffer.x + f.frame.width / 2;
        const cy = c.y + f.frame.y - f.buffer.y + f.frame.height / 2;
        const width = f.frame.width * s;
        const height = f.frame.height * c.scale_y;
        return { x: cx - width / 2, y: cy - height / 2, width, height, angle: c.rotation_angle_y };
    }

    _end(win, f, notify) {
        this._active.delete(win);
        if (f.painted)
            global.stage.disconnect(f.painted);
        f.painted = 0;
        f.anim?.cancel();
        f.clone.destroy();
        if (f.toStage && f.actor.get_stage?.() !== null)
            f.actor.opacity = f.opacity;
        if (notify)
            this._onLanded(win, f.toStage);
    }
}
