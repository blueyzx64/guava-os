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
// During a workspace slide (Main.wm._switchInProgress) Mutter sends no 'minimize' / 'unminimize':
// meta_window_actor_hide/show wait for the slide to end and then hide or show the window with no
// effect, and the slide draws its own clones of the windows above window_group. Guava watches
// each window's 'minimized' instead and plays the same effect on a clone drawn above the slide
// (a "detached" run: Mutter waits for nothing). The effect never changes with the Shell's load
// or a slide in progress, and fullscreenSpace's borrowed slow-down does not stretch it.
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
import St from 'gi://St';
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
        // A detached run (below) is Guava's alone: Mutter does not wait for it and cannot cut it off
        cleanup.connect(wm, 'kill-window-effects', (_wm, actor) => {
            const run = this._running.get(actor);
            if (run && !run.detached)
                run.interrupt();
        });
        // Minimized or restored during a workspace slide: no signal comes (see the top)
        cleanup.connect(global.display, 'window-created', (_d, win) => this._watch(win));
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
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

    _watch(win) {
        if (!win)
            return;
        const token = this._cleanup.connect(win, 'notify::minimized', () => {
            // Mutter defers the hide or show to the end of the slide and animates nothing
            if (!Main.wm._switchInProgress)
                return;
            const actor = win.get_compositor_private();
            if (actor)
                this._play(global.window_manager, actor, !win.minimized, true);
        });
        const gone = this._cleanup.connect(win, 'unmanaged', () => {
            this._cleanup.release(token);
            this._cleanup.release(gone);
        });
    }

    // Mutter waits for completed_minimize/unminimize (Guava blocked the Shell's handlers), so any
    // failure in here must still complete: the window would stay drawn and unreachable otherwise.
    // A detached run (during a workspace slide) has nothing to complete.
    _play(shellwm, actor, restoring, detached = false) {
        // Shell.WM's own methods: another extension (Magic Lamp) replaces them on the instance with
        // no-ops, and Mutter would then wait for this window forever
        let completed = false;
        const complete = () => {
            if (completed)
                return;
            completed = true;
            if (detached)
                return;
            if (restoring)
                Shell.WM.prototype.completed_unminimize.call(shellwm, actor);
            else
                Shell.WM.prototype.completed_minimize.call(shellwm, actor);
        };
        try {
            this._playEffect(shellwm, actor, restoring, complete, detached);
        } catch (e) {
            console.error('[Guava] minimize effect failed, the window goes at once:', e);
            this._abort(actor, restoring, complete, detached);
        }
    }

    _abort(actor, restoring, complete, detached) {
        try {
            const run = this._running.get(actor);
            if (run)
                run.finish();       // drops the picture and completes
        } catch (e) {
            console.error('[Guava] minimize effect: cleanup failed:', e);
            this._running.delete(actor);
        }
        try {
            if (restoring && !detached)
                actor.show();
            actor.opacity = 255;
        } catch (_e) {
            // the actor is gone
        }
        complete();
    }

    _playEffect(shellwm, actor, restoring, complete, detached) {
        const win = actor.meta_window;
        const running = this._running.get(actor);
        // The slide ended between the window's change and Mutter's effect: the detached run
        // already plays it, so Mutter just gets its answer
        if (!detached && running?.detached && running.restoring === restoring) {
            if (restoring)
                actor.show();
            complete();
            return;
        }
        // Turned around during or after the slide: carry on from where the detached run is
        if (running?.detached)
            running.interrupt();
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
        // A picture above a slide may carry on after it (it stays above window_group); one in
        // window_group may not carry on during a slide, which covers window_group
        const resume = carried?.mode === mode && !(detached && !carried.detached) ? carried : null;
        this._ctx.debug?.('minimize-effect', restoring ? 'restore' : 'minimize', {
            mode, detached, resume: !!resume, overview, edge: target?.edge ?? null,
            app: win?.get_wm_class() ?? null, degraded: !!this._ctx.motion.env?.degraded,
        });
        if (carried && !resume)
            carried.dispose();
        if (detached && (mode === 'stock' || mode === 'none'))
            return;     // GNOME animates nothing here either; Mutter hides or shows it at the end
        if (mode === 'stock') {
            // GNOME's own effect (the handlers Guava blocked)
            if (restoring)
                Main.wm._unminimizeWindow(shellwm, actor);
            else
                Main.wm._minimizeWindow(shellwm, actor);
            return;
        }
        if (mode === 'none') {
            if (restoring)
                actor.show();
            complete();
            return;
        }
        let picture;
        try {
            picture = resume?.picture ?? (detached
                ? this._overlayPicture(mode, actor, win, target, restoring)
                : this._picture(mode, actor, win, target, restoring));
        } catch (e) {
            // The desktop stays usable: the window goes at once
            console.error(`[Guava] minimize effect: ${mode} for ${win?.get_wm_class()} failed:`, e.message);
            if (restoring && !detached)
                actor.show();
            complete();
            return;
        }
        if (resume)
            this.stats.resumed++;
        else
            this.stats.animations++;
        this._run(actor, mode, picture, resume?.progress ?? null, restoring, complete, detached);
    }

    /**
     * One running effect: drives `picture` from `progress` to its end, completes for Mutter
     * exactly once, and can be cut off by Mutter (interrupt) or by Guava (finish).
     */
    _run(actor, mode, picture, progress, restoring, complete, detached) {
        const motion = this._ctx.motion;
        const timing = TIMING[mode];
        const plan = retarget(progress, restoring, motion.duration({ duration: timing.duration }) * this._unslowed());
        const run = { mode, progress: plan.from, handle: null, detached, restoring };
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
                mode, picture, progress: run.progress, detached,
                dispose: () => picture.dispose(restoring),
            });
            this._cleanup.idle(() => this._dropCarried(actor), { name: 'guava minimize carried' });
            complete();
        };
        this._running.set(actor, run);
        picture.apply(plan.from);
        if (restoring && !detached)
            actor.show();
        run.handle = motion.tween(actor,
            { duration: plan.duration, curve: timing.curve[restoring ? 1 : 0], onDone: () => run.finish() },
            frame, this._cleanup);
    }

    // fullscreenSpace slows the Shell's animations for its slide (St slow_down_factor, which
    // core/motion applies too): the minimize effect keeps the speed the user's own factor gives
    _unslowed() {
        const borrowed = this._ctx.features.instance('move-window-to-new-workspace')?.baseSlowDown?.() ?? null;
        const now = St.Settings.get().slow_down_factor || 1;
        return borrowed ? borrowed / now : 1;
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

    _geniePicture(actor, win, target, restoring, layer = null) {
        if (restoring && !layer) {
            const buffer = win.get_buffer_rect();
            actor.set_position(buffer.x, buffer.y);
        }
        const rect = layer?.rect ?? { x: actor.x, y: actor.y, width: actor.width, height: actor.height };
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
        if (layer)
            layer.parent.insert_child_above(container, layer.above);
        else
            actor.get_parent().insert_child_above(container, null);
        actor.opacity = 0;
        layer?.hide();
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
                layer?.unhide();
            },
        };
    }

    // ---- during a workspace slide ----------------------------------------------------------

    /**
     * The picture of a detached run: a clone of the window drawn above the slide (Main.uiGroup,
     * above the slide's groups and below the chrome), starting where the user sees the window.
     * The slide's own clones of the window are hidden for the run.
     */
    _overlayPicture(mode, actor, win, target, restoring) {
        const animation = Main.wm._workspaceAnimation;
        const groups = (animation?._switchData?.monitors ?? []).filter(g => g.get_parent() === Main.uiGroup);
        const clones = [];
        const walk = a => {
            for (const child of a.get_children()) {
                if (child instanceof Clutter.Clone && child.source === actor)
                    clones.push(child);
                else
                    walk(child);
            }
        };
        groups.forEach(walk);
        // Minimizing: where the slide draws it now (a still "moving window" or a sliding one);
        // restoring: where it will be once the slide ends
        const buffer = win.get_buffer_rect();
        let rect = { x: buffer.x, y: buffer.y, width: actor.width, height: actor.height };
        const seen = clones.find(c => c.visible) ?? clones[0];
        if (!restoring && seen) {
            const [x, y] = seen.get_transformed_position();
            if (Number.isFinite(x) && Number.isFinite(y))
                rect = { ...rect, x: Math.round(x), y: Math.round(y) };
        }
        const top = groups.reduce((best, g) =>
            !best || Main.uiGroup.get_children().indexOf(g) > Main.uiGroup.get_children().indexOf(best) ? g : best, null);
        const shown = new Map();
        const layer = {
            rect,
            parent: Main.uiGroup,
            above: top ?? global.window_group,
            // The slide's clones go with the slide: forget each one when it is destroyed
            hide: () => {
                for (const c of clones) {
                    const id = c.connect('destroy', () => shown.delete(c));
                    shown.set(c, { opacity: c.opacity, id });
                    c.opacity = 0;
                }
            },
            unhide: () => {
                for (const [c, { opacity, id }] of shown) {
                    c.disconnect(id);
                    c.opacity = opacity;
                }
                shown.clear();
            },
        };
        if (mode === 'genie')
            return this._geniePicture(actor, win, target, restoring, layer);
        return this._overlayClonePicture(mode, actor, target, layer);
    }

    // Scale and fade on a clone in the slide's layer (the real window is under the slide)
    _overlayClonePicture(mode, actor, target, layer) {
        const from = layer.rect;
        const end = scaleTarget(from, target.rect);
        const clone = new Clutter.Clone({ source: actor, x: from.x, y: from.y, width: from.width, height: from.height });
        clone.set_pivot_point(0, 0);
        layer.parent.insert_child_above(clone, layer.above);
        actor.opacity = 0;
        layer.hide();
        let alive = true;
        return {
            apply: p => {
                if (mode === 'fade') {
                    clone.opacity = Math.round(255 * (1 - p));
                    return;
                }
                const f = scaleFrame(from, end, p);
                clone.set({ x: f.x, y: f.y, scale_x: f.scale, scale_y: f.scale, opacity: f.opacity });
            },
            dispose: () => {
                if (!alive)
                    return;
                alive = false;
                clone.destroy();
                actor.opacity = 255;
                layer.unhide();
            },
        };
    }
}
