// SPDX-License-Identifier: GPL-3.0-or-later
// Minimize effects: "Minimize windows using: Genie / Scale", played in
// reverse on restore. Under reduced motion the window fades where it is; with animations off
// (or in the overview, as GNOME does) it goes at once.
//
// Where a window goes:
//   1. the dock (ctx.features.instance('dock').minimizeTarget(win)): its app icon or the
//      minimized-window slot; on restore, the window's icon geometry (the dock keeps it on
//      the window's own tile)
//   2. the window's icon geometry, set by whatever dock runs
//   3. the middle of the dock's edge of the window's monitor (model.edgeTarget): the dock is
//      hidden, off or not laid out yet, so every minimize gets the effect
// For windows another feature set aside (core/windowState flags: Hide), GNOME's own effect
// runs: Guava animates only the windows it chose.
//
// Interruptible: Mutter emits 'kill-window-effects' right before a minimize or restore of a
// window whose effect still runs. The cut-off effect completes for Mutter at once but keeps
// its picture for the call that follows, which carries on from that progress in the share of
// the time that is left (model.retarget); a picture nobody claims goes on the next idle.
//
// API (ctx.features.instance('minimize-effect')):
//   targetFor(metaWindow)          the rect and edge an effect would use, or null
//   stats                          {animations, frames, resumed}: read by the harness
//
// Shell API: global.window_manager (Shell.WM) 'minimize' / 'unminimize' /
// 'kill-window-effects' and completed_minimize / completed_unminimize; the stock handlers of
// ui/windowManager.js are bound closures, so they are blocked while Guava runs (and unblocked
// after), and Main.wm._minimizeWindow / _unminimizeWindow (private) run for the windows Guava
// leaves to GNOME. Main.wm._skippedActors (skipNextEffect). Checked on GNOME 50.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GuavaSettings } from '../../lib/settings.js';
import { WindowState } from '../../core/windowState.js';
import { GenieEffect } from './genie.js';
import {
    chooseMode, edgeTarget, genieFrame, genieOpacity, readConfig, retarget, scaleFrame, scaleTarget,
} from './model.js';

const EFFECT_NAME = 'guava-genie';
const ANIMATED_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.DIALOG];
const SIGNALS = ['minimize', 'unminimize'];
// Per mode: the full run's duration and curve (minimize, restore)
const TIMING = Object.freeze({
    genie: { duration: 'extraLong', curve: ['linear', 'linear'] },
    scale: { duration: 'long', curve: ['move', 'emphasized'] },
    fade: { duration: 'short', curve: ['standard', 'standard'] },
});

export class MinimizeEffect {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        const cleanup = this._cleanup;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._config = readConfig(this._ks);
        this._ks.watch('dock-minimize-effect', () => {
            this._config = readConfig(this._ks);
        });
        this._running = new Map();   // window actor -> run (see _run)
        this._carried = new Map();   // window actor -> the picture of a run Mutter cut off
        // Measured in the harness: effects started, frames drawn, effects resumed mid-way
        this.stats = { animations: 0, frames: 0, resumed: 0 };

        const wm = global.window_manager;
        // Only the Shell's own handlers (the oldest of each signal, connected at start-up) are
        // blocked: a *_matched call would also touch every other handler of the signal, ours and
        // other extensions' (Mutter then fails its minimize accounting)
        for (const signalId of SIGNALS) {
            const stock = GObject.signal_handler_find(wm, { signalId });
            if (!stock) {
                console.warn(`[Guava] minimize effect: the Shell's '${signalId}' handler was not found`);
                continue;
            }
            GObject.signal_handler_block(wm, stock);
            cleanup.add(() => {
                if (GObject.signal_handler_is_connected(wm, stock))
                    GObject.signal_handler_unblock(wm, stock);
            });
        }
        cleanup.connect(wm, 'minimize', (shellwm, actor) => this._play(shellwm, actor, false));
        cleanup.connect(wm, 'unminimize', (shellwm, actor) => this._play(shellwm, actor, true));
        cleanup.connect(wm, 'kill-window-effects', (_wm, actor) => this._running.get(actor)?.interrupt());
        // Disabled mid-flight: every window ends where it was going
        cleanup.add(() => {
            for (const run of [...this._running.values()])
                run.finish();
            for (const actor of [...this._carried.keys()])
                this._dropCarried(actor);
        });
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // ---- API ---------------------------------------------------------------------------

    targetFor(win, restoring = false) {
        const dock = this._ctx.features.instance('dock');
        const edge = dock?.position ?? 'bottom';
        if (dock && !restoring) {
            const rect = dock.minimizeTarget(win);
            if (rect)
                return { rect, edge };
        }
        const [ok, geom] = win.get_icon_geometry();
        if (ok && geom.width > 0 && geom.height > 0)
            return { rect: { x: geom.x, y: geom.y, width: geom.width, height: geom.height }, edge };
        const rect = edgeTarget(edge, Main.layoutManager.monitors[win.get_monitor()] ?? null);
        return rect ? { rect, edge } : null;
    }

    // ---- effects -------------------------------------------------------------------------

    _play(shellwm, actor, restoring) {
        const win = actor.meta_window;
        // A run Mutter cut off just now (kill-window-effects) for this window
        const carried = this._carried.get(actor) ?? null;
        this._carried.delete(actor);
        this._running.get(actor)?.finish();
        const target = win ? this.targetFor(win, restoring) : null;
        const overview = Main.overview.visible && !Main.overview.closing;
        const mode = chooseMode({
            effect: this._config.effect,
            env: this._ctx.motion.env,
            normal: !!win && ANIMATED_TYPES.includes(win.get_window_type()) && !Main.wm._skippedActors?.has(actor),
            flagged: !!win && WindowState.flags(win).length > 0,
            hasTarget: !!target,
            overview,
        });
        const resume = carried?.mode === mode ? carried : null;
        if (carried && !resume)
            carried.dispose();
        if (mode === 'stock') {
            // GNOME's own effect (the handlers Guava blocked)
            if (restoring)
                Main.wm._unminimizeWindow(shellwm, actor);
            else
                Main.wm._minimizeWindow(shellwm, actor);
            return;
        }
        // Shell.WM's own methods: another extension (Magic Lamp) replaces them on the instance with
        // no-ops, and Mutter would then wait for this window forever
        const complete = () => (restoring
            ? Shell.WM.prototype.completed_unminimize.call(shellwm, actor)
            : Shell.WM.prototype.completed_minimize.call(shellwm, actor));
        if (mode === 'none') {
            if (restoring)
                actor.show();
            complete();
            return;
        }
        let picture;
        try {
            picture = resume?.picture ?? this._picture(mode, actor, win, target, restoring);
        } catch (e) {
            // The desktop stays usable: the window goes at once
            console.error(`[Guava] minimize effect: ${mode} for ${win?.get_wm_class()} failed:`, e.message);
            if (restoring)
                actor.show();
            complete();
            return;
        }
        if (resume)
            this.stats.resumed++;
        else
            this.stats.animations++;
        this._run(actor, mode, picture, resume?.progress ?? null, restoring, complete);
    }

    /**
     * One running effect: drives `picture` from `progress` to its end, completes for Mutter
     * exactly once, and can be cut off by Mutter (interrupt) or by Guava (finish).
     */
    _run(actor, mode, picture, progress, restoring, complete) {
        const motion = this._ctx.motion;
        const timing = TIMING[mode];
        const plan = retarget(progress, restoring, motion.duration({ duration: timing.duration }));
        const run = { mode, progress: plan.from, handle: null };
        const stats = this.stats;
        const frame = t => {
            run.progress = plan.from + (plan.to - plan.from) * t;
            stats.frames++;
            picture.apply(run.progress);
        };
        const own = () => this._running.get(actor) === run;
        run.finish = () => {
            if (!own())
                return;
            this._running.delete(actor);
            run.handle?.cancel();
            picture.dispose(restoring);
            complete();
        };
        // Mutter starts a new effect for this window next: hand it the picture as it is now
        run.interrupt = () => {
            if (!own())
                return;
            this._running.delete(actor);
            run.handle?.cancel();
            this._carried.set(actor, {
                mode, picture, progress: run.progress,
                dispose: () => picture.dispose(restoring),
            });
            this._cleanup.idle(() => this._dropCarried(actor), { name: 'guava minimize carried' });
            complete();
        };
        this._running.set(actor, run);
        picture.apply(plan.from);
        if (restoring)
            actor.show();
        run.handle = motion.tween(actor,
            { duration: plan.duration, curve: timing.curve[restoring ? 1 : 0], onDone: () => run.finish() },
            frame, this._cleanup);
    }

    _dropCarried(actor) {
        const carried = this._carried.get(actor);
        if (!carried)
            return;
        this._carried.delete(actor);
        carried.dispose();
    }

    /**
     * What an effect draws: apply(progress) puts the window at that progress (0 = in place,
     * 1 = in the target); dispose(restored) puts the actor back as Mutter expects it.
     */
    _picture(mode, actor, win, target, restoring) {
        if (mode === 'fade')
            return this._fadePicture(actor);
        if (mode === 'scale')
            return this._scalePicture(actor, win, target.rect);
        return this._geniePicture(actor, win, target, restoring);
    }

    _fadePicture(actor) {
        return {
            apply: p => {
                actor.opacity = Math.round(255 * (1 - p));
            },
            dispose: () => {
                actor.opacity = 255;
            },
        };
    }

    _scalePicture(actor, win, rect) {
        const buffer = win.get_buffer_rect();
        const from = { x: buffer.x, y: buffer.y, width: actor.width, height: actor.height };
        const end = scaleTarget(from, rect);
        actor.set_pivot_point(0, 0);
        return {
            apply: p => {
                const f = scaleFrame(from, end, p);
                actor.set({ x: f.x, y: f.y, scale_x: f.scale, scale_y: f.scale, opacity: f.opacity });
            },
            dispose: () => {
                actor.set({ scale_x: 1, scale_y: 1, opacity: 255 });
                actor.set_position(from.x, from.y);
            },
        };
    }

    _geniePicture(actor, win, target, restoring) {
        if (restoring) {
            const buffer = win.get_buffer_rect();
            actor.set_position(buffer.x, buffer.y);
        }
        const rect = { x: actor.x, y: actor.y, width: actor.width, height: actor.height };
        const t = target.rect;
        // The container the funnel is drawn in: the window and the target, in whole pixels
        const x1 = Math.floor(Math.min(rect.x, t.x));
        const y1 = Math.floor(Math.min(rect.y, t.y));
        const reach = {
            x: x1, y: y1,
            width: Math.ceil(Math.max(rect.x + rect.width, t.x + t.width)) - x1,
            height: Math.ceil(Math.max(rect.y + rect.height, t.y + t.height)) - y1,
        };
        const effect = new GenieEffect(genieFrame(target.edge, rect, t), reach);
        const container = new Clutter.Actor({ x: reach.x, y: reach.y, width: reach.width, height: reach.height });
        container.add_child(new Clutter.Clone({
            source: actor, x: rect.x - reach.x, y: rect.y - reach.y, width: rect.width, height: rect.height,
        }));
        container.add_effect_with_name(EFFECT_NAME, effect);
        // Above every window, as on macOS: the funnel passes over the windows between it and the dock
        actor.get_parent().insert_child_above(container, null);
        actor.opacity = 0;
        let alive = true;
        return {
            apply: p => {
                effect.setProgress(p);
                container.opacity = genieOpacity(p);
            },
            dispose: () => {
                if (!alive)
                    return;
                alive = false;
                container.destroy();
                actor.opacity = 255;
            },
        };
    }
}
