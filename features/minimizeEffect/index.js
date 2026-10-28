// SPDX-License-Identifier: GPL-3.0-or-later
// Minimize effects: "Minimize windows using: Genie / Scale", played in
// reverse on restore. Under reduced motion the window fades where it is; with animations off
// it goes at once.
//
// Where a window goes:
//   1. a target provider (setTargetProvider: Stage Manager sends windows to its strip)
//   2. the dock (ctx.features.instance('dock').minimizeTarget(win)): its app icon or the
//      minimized-window slot; on restore, the window's icon geometry (the dock keeps it on
//      the window's own tile)
//   3. the window's icon geometry, set by whatever dock runs
// With no target, or for windows another feature set aside (core/windowState flags), GNOME's
// own effect runs: Guava animates only the windows it chose.
//
// API (ctx.features.instance('minimize-effect')):
//   setTargetProvider(owner, fn)   fn(metaWindow) -> {rect, edge?} or null (edge: the side the
//                                  target sits on, 'bottom' | 'left' | 'right'); `owner` is a
//                                  CleanupRegistry that removes it. The last one added wins.
//   targetFor(metaWindow)          the rect and edge an effect would use, or null
//
// Shell API: global.window_manager (Shell.WM) 'minimize' / 'unminimize' /
// 'kill-window-effects' and completed_minimize / completed_unminimize; the stock handlers of
// ui/windowManager.js are bound closures, so they are blocked while Guava runs (and unblocked
// after), and Main.wm._minimizeWindow / _unminimizeWindow (private) run for the windows Guava
// leaves to GNOME. Checked on GNOME 50.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GuavaSettings } from '../../lib/settings.js';
import { WindowState } from '../../core/windowState.js';
import { GenieEffect } from './genie.js';
import { chooseMode, genieFrame, genieOpacity, readConfig, scaleTarget } from './model.js';

const EFFECT_NAME = 'guava-genie';
const ANIMATED_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.DIALOG];
const SIGNALS = ['minimize', 'unminimize'];

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
        this._providers = [];
        this._running = new Map();   // window actor -> {finish(finished)}
        // Measured in the harness: frames and the time spent per frame computing them
        this.stats = { animations: 0, frames: 0 };

        const wm = global.window_manager;
        // Only the Shell's own handlers (the oldest of each signal, connected at start-up) are
        // blocked: a *_matched call would also touch every other handler of the signal, ours and
        // other extensions' (Mutter then fails its minimize accounting)
        for (const signalId of SIGNALS) {
            const stock = GObject.signal_handler_find(wm, { signalId });
            if (!stock)
                continue;
            GObject.signal_handler_block(wm, stock);
            cleanup.add(() => {
                if (GObject.signal_handler_is_connected(wm, stock))
                    GObject.signal_handler_unblock(wm, stock);
            });
        }
        cleanup.connect(wm, 'minimize', (shellwm, actor) => this._play(shellwm, actor, false));
        cleanup.connect(wm, 'unminimize', (shellwm, actor) => this._play(shellwm, actor, true));
        cleanup.connect(wm, 'kill-window-effects', (_wm, actor) => this._running.get(actor)?.finish());
        // Disabled mid-flight: every window ends where it was going
        cleanup.add(() => {
            for (const run of [...this._running.values()])
                run.finish();
        });
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // ---- API ---------------------------------------------------------------------------

    setTargetProvider(owner, fn) {
        this._providers.push(fn);
        owner?.add(() => {
            this._providers = this._providers.filter(p => p !== fn);
        });
    }

    targetFor(win, restoring = false) {
        for (let i = this._providers.length - 1; i >= 0; i--) {
            try {
                const t = this._providers[i](win);
                if (t?.rect)
                    return { rect: t.rect, edge: t.edge ?? 'bottom', provided: true };
            } catch (e) {
                console.error('[Guava] minimize effect: target provider failed:', e.message);
            }
        }
        const dock = this._ctx.features.instance('dock');
        if (dock && !restoring) {
            const rect = dock.minimizeTarget(win);
            if (rect)
                return { rect, edge: dock.position };
        }
        const [ok, geom] = win.get_icon_geometry();
        if (ok && geom.width > 0 && geom.height > 0) {
            const rect = { x: geom.x, y: geom.y, width: geom.width, height: geom.height };
            return { rect, edge: dock?.position ?? 'bottom' };
        }
        return null;
    }

    // ---- effects -------------------------------------------------------------------------

    _play(shellwm, actor, restoring) {
        const win = actor.meta_window;
        const target = win ? this.targetFor(win, restoring) : null;
        const mode = chooseMode({
            effect: this._config.effect,
            env: this._ctx.motion.env,
            normal: !!win && ANIMATED_TYPES.includes(win.get_window_type()) && !Main.wm._skippedActors?.has(actor),
            // A provider's target (Stage Manager's strip) is meant for exactly those windows
            flagged: !!win && WindowState.flags(win).length > 0 && !target?.provided,
            hasTarget: !!target,
            monitorSized: !!win?.is_monitor_sized(),
        });
        this._running.get(actor)?.finish();
        if (mode === 'stock') {
            // GNOME's own effect (the handlers Guava blocked)
            if (restoring)
                Main.wm._unminimizeWindow(shellwm, actor);
            else
                Main.wm._minimizeWindow(shellwm, actor);
            return;
        }
        const complete = () => (restoring ? shellwm.completed_unminimize(actor) : shellwm.completed_minimize(actor));
        if (mode === 'none') {
            if (restoring)
                actor.show();
            complete();
            return;
        }
        this.stats.animations++;
        if (mode === 'fade')
            this._fade(actor, restoring, complete);
        else if (mode === 'scale')
            this._scale(actor, win, target.rect, restoring, complete);
        else
            this._genie(actor, win, target, restoring, complete);
    }

    // One record per running window: how to end it (at its end state) exactly once
    _track(actor, handleOf, reset, complete) {
        let handle = null;
        const run = {
            finish: () => {
                if (this._running.get(actor) !== run)
                    return;
                this._running.delete(actor);
                handle?.cancel();
                reset();
                complete();
            },
        };
        this._running.set(actor, run);
        handle = handleOf(() => run.finish());
        return run;
    }

    _fade(actor, restoring, complete) {
        const motion = this._ctx.motion;
        if (restoring) {
            actor.opacity = 0;
            actor.show();
        }
        this._track(actor,
            done => motion.ease(actor, { opacity: restoring ? 255 : 0 }, { duration: 'short', onDone: done }, this._cleanup),
            () => {
                actor.remove_all_transitions();
                actor.opacity = 255;
            }, complete);
    }

    _scale(actor, win, rect, restoring, complete) {
        const motion = this._ctx.motion;
        const buffer = win.get_buffer_rect();
        const from = { x: buffer.x, y: buffer.y, width: actor.width, height: actor.height };
        const end = scaleTarget(from, rect);
        const shrunk = { x: end.x, y: end.y, scale_x: end.scale, scale_y: end.scale, opacity: 0 };
        const full = { x: from.x, y: from.y, scale_x: 1, scale_y: 1, opacity: 255 };
        actor.set_pivot_point(0, 0);
        if (restoring) {
            actor.set(shrunk);
            actor.show();
        }
        this._track(actor,
            done => motion.ease(actor, restoring ? full : shrunk,
                { duration: 'long', curve: restoring ? 'emphasized' : 'move', onDone: done }, this._cleanup),
            () => {
                actor.remove_all_transitions();
                actor.set({ scale_x: 1, scale_y: 1, opacity: 255 });
                if (restoring)
                    actor.set_position(from.x, from.y);
            }, complete);
    }

    _genie(actor, win, target, restoring, complete) {
        const motion = this._ctx.motion;
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
        const stats = this.stats;
        const frame = p => {
            stats.frames++;
            effect.setProgress(p);
            container.opacity = genieOpacity(p);
        };
        if (restoring) {
            frame(1);
            actor.show();
        }
        this._track(actor,
            done => motion.tween(actor, { duration: 'extraLong', curve: 'linear', reverse: restoring, onDone: done },
                frame, this._cleanup),
            () => {
                container.destroy();
                actor.opacity = 255;
            }, complete);
    }
}
