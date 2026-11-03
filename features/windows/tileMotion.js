// SPDX-License-Identifier: GPL-3.0-or-later
// Tile motion: a tile, half, Fill, shortcut, drag drop or "Return to Previous Size" flies the window
// from its frame to the new one instead of jumping (Tiling Shell does the same). tileMotionModel.js
// decides whether and how; this file runs it through ctx.motion.
//
// The real window actor flies, scaled about its frame's top-left corner and shifted every frame so
// that its *current* frame sits on a rect that travels from the old to the new one. Only one bitmap
// is drawn, scaled down towards the wanted size, never a small one stretched up:
//   grow    the app is resized at once; its new, larger buffer flies in from the old size
//   shrink  the old, larger buffer shrinks to the new size; the app is resized when it arrives
// A second short phase keeps the transform until the app's frame has reached the target (Wayland
// clients resize asynchronously), then clears it, so the last frame is the app's own, 1:1.
//
// Interruptible: a new move of the same window starts from the rect the window shows now. A grab,
// the window going away or disable() ends the flight where it is.
//
// Shell API: Meta.Window get_frame_rect / get_compositor_private, Clutter.Actor
// pivot_point / scale / translation. Checked on GNOME 50.6.

import Graphene from 'gi://Graphene';

import { frameTransform, isSettled, lerpRect, planTile } from './tileMotionModel.js';

const rectOf = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });

export class TileMotion {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._runs = new Map();   // Meta.Window -> {actor, visual, handle, superseded}
        // Measured in the harness: flights started, frames drawn
        this.stats = { flights: 0, frames: 0 };
        cleanup.add(() => {
            for (const win of [...this._runs.keys()])
                this.cancel(win);
        });
    }

    /** True while the window is flying. */
    flying(win) {
        return this._runs.has(win);
    }

    /**
     * Move the window's frame to `to` by calling `apply()` (which asks Mutter for the new frame),
     * with a flight when the plan says so.
     *
     * @param {Meta.Window} win
     * @param {{x,y,width,height}} to the frame wanted
     * @param {() => void} apply
     */
    move(win, to, apply) {
        const actor = win.get_compositor_private();
        const prev = this._runs.get(win);
        const from = prev ? prev.visual : rectOf(win.get_frame_rect());
        const mode = actor ? planTile({
            from, to, env: this._ctx.motion.env,
            visible: actor.visible && !win.minimized, fullscreen: win.is_fullscreen(),
        }) : null;
        if (!mode) {
            this.cancel(win);
            apply();
            return;
        }
        // The new flight takes over from the old one without clearing the transform
        if (prev) {
            prev.superseded = true;
            prev.handle?.cancel();
        }
        const run = { actor, visual: from, handle: null, superseded: false };
        this._runs.set(win, run);
        this.stats.flights++;
        const motion = this._ctx.motion;

        const step = want => {
            run.visual = want;
            if (!win.get_compositor_private())
                return;
            const cur = win.get_frame_rect();
            const t = frameTransform(want, cur);
            const bw = actor.width || 1;
            const bh = actor.height || 1;
            actor.pivot_point = new Graphene.Point({ x: (cur.x - actor.x) / bw, y: (cur.y - actor.y) / bh });
            actor.set({ scale_x: t.scaleX, scale_y: t.scaleY, translation_x: t.tx, translation_y: t.ty });
            this.stats.frames++;
        };
        const clear = () => {
            if (this._runs.get(win) !== run)
                return;
            this._runs.delete(win);
            this._reset(actor);
        };
        const settle = () => {
            if (mode === 'shrink')
                apply();
            run.handle = motion.tween(actor, {
                duration: 'short', curve: 'linear',
                onDone: () => !run.superseded && clear(),
            }, () => {
                step(to);
                if (isSettled(win.get_frame_rect(), to))
                    run.handle?.cancel();
            }, this._cleanup);
        };

        if (mode === 'grow')
            apply();
        run.handle = motion.tween(actor, {
            duration: 'medium', curve: 'emphasized',
            onDone: finished => {
                if (run.superseded)
                    return;
                if (finished)
                    settle();
                else
                    clear();
            },
        }, t => step(lerpRect(from, to, t)), this._cleanup);
    }

    /** Stop a flight where it is and give the actor back to Mutter. */
    cancel(win) {
        const run = this._runs.get(win);
        if (!run)
            return;
        this._runs.delete(win);
        run.superseded = true;
        run.handle?.cancel();
        this._reset(run.actor);
    }

    _reset(actor) {
        try {
            actor.set({ scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0 });
            actor.set_pivot_point(0, 0);
        } catch (_e) {
            // The actor is gone with its window
        }
    }
}
