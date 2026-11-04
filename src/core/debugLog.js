// SPDX-License-Identifier: GPL-3.0-or-later
// The debug log: with the `debug-logging` key on, Guava writes a timeline of what happens to the
// journal, as "[Guava debug] +12.345s scope: message {data}" lines (tools/guava-logs.sh turns it
// on, records and packs the logs). Off (the default), nothing is connected and nothing runs.
//
// What it records, without any feature having to do anything:
//   events   every core/events.js event (windows added/changed/focused, feature-changed,
//            session-locked, minimize-requested, ...), through EventHub.setTap
//   shell    the overview (showing / shown / hiding / hidden, with how long each took), window
//            effects (minimize, unminimize, map, destroy, size-change), workspace switches,
//            focus, full screen, grabs, monitors and scale, session mode, Guava setting changes
//   frames   slow frames while something animates (a gap >= 50 ms after smooth frames)
//   loop     main-loop stalls (>= 100 ms), whoever caused them
//   start    the versions, monitors, and once the login is over each feature's start time
// and what features report themselves through ctx.debug(scope, message, data).
//
// Private text (titles, notification bodies, search and clipboard text, paths) is never written:
// core/debugLogModel.js summarize() replaces it by its length. Lines are rate-limited per scope.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from '../lib/disposables.js';
import { RateLimit, formatLine, slowFrameMs, slowestFeatures, stallMs } from './debugLogModel.js';

export const DEBUG_KEY = 'debug-logging';
const STALL_TICK_MS = 50;
const STALL_MS = 100;
const SLOW_FRAME_MS = 50;
const SMOOTH_FRAME_MS = 34;   // ~30 fps or better

const now = () => GLib.get_monotonic_time() / 1000;
const SIZE_CHANGES = Object.fromEntries(Object.entries(Meta.SizeChange ?? {}).map(([k, v]) => [v, k.toLowerCase()]));

export class DebugLog {
    /**
     * @param {import('gi://Gio').Settings} settings Guava's settings
     * @param {import('./events.js').EventHub} events
     * @param {{metadata?: object}} extension
     * @param {() => object|null} registry the FeatureRegistry, when there is one
     */
    constructor(settings, events, extension, registry) {
        this._settings = settings;
        this._events = events;
        this._extension = extension;
        this._registry = registry;
        this._on = null;   // CleanupRegistry while logging
        this._t0 = now();
        this._limit = new RateLimit(40, 1000);
    }

    get enabled() {
        return this._on !== null;
    }

    /** @param {CleanupRegistry} cleanup the extension's: stops the log on disable */
    start(cleanup) {
        cleanup.connect(this._settings, `changed::${DEBUG_KEY}`, () => this._sync());
        cleanup.add(() => this._stop());
        this._sync();
    }

    /**
     * Write one line (a no-op while the log is off). Features call it as ctx.debug().
     *
     * @param {string} scope
     * @param {string} message
     * @param {*} [data]
     */
    log(scope, message, data) {
        if (!this._on)
            return;
        const t = now();
        const { pass, dropped } = this._limit.check(scope, t);
        if (!pass)
            return;
        try {
            if (dropped)
                console.log(formatLine(t - this._t0, scope, `(${dropped} lines dropped by the rate limit)`));
            console.log(formatLine(t - this._t0, scope, message, data));
        } catch (_e) {
            // logging never breaks a feature
        }
    }

    _sync() {
        const want = this._settings.get_boolean(DEBUG_KEY);
        if (want && !this._on)
            this._begin();
        else if (!want && this._on)
            this._stop();
    }

    _stop() {
        if (!this._on)
            return;
        this.log('start', 'debug log off');
        this._events?.setTap?.(null);
        const c = this._on;
        this._on = null;
        c.dispose();
    }

    _begin() {
        try {
            this._wire();
        } catch (e) {
            console.error('[Guava] debug log could not start:', e);
            this._stop();
        }
    }

    _wire() {
        const c = this._on = new CleanupRegistry();
        this._t0 = now();
        this.log('start', 'debug log on', {
            shell: Config.PACKAGE_VERSION,
            guava: this._extension?.metadata?.['version-name'] ?? this._extension?.metadata?.version ?? null,
            xwayland: !!global.display.get_x11_display?.(),
            sessionMode: Main.sessionMode.currentMode,
            locked: Main.sessionMode.isLocked,
            startingUp: !!Main.layoutManager._startingUp,
        });
        this._logMonitors();
        this._logFeatures('features now');

        this._events?.setTap?.((name, payload) => this.log('events', name, payload));
        this._watchShell(c);
        this._watchFrames(c);
        this._watchLoop(c);
        c.connect(this._settings, 'changed', (_s, key) => {
            if (key !== DEBUG_KEY)
                this.log('settings', key, this._settings.get_value(key).recursiveUnpack());
        });
        // The login's start times, once the later features are up too
        const settled = this._registry?.()?.settled?.();
        settled?.then(() => this._on === c && this._logFeatures('features after login'));
    }

    _logMonitors() {
        const lm = Main.layoutManager;
        this.log('shell', 'monitors', {
            primary: lm.primaryIndex,
            monitors: lm.monitors.map(m => ({
                i: m.index, x: m.x, y: m.y, w: m.width, h: m.height,
                scale: global.display.get_monitor_scale(m.index),
            })),
        });
    }

    _logFeatures(message) {
        const reg = this._registry?.();
        if (!reg)
            return;
        try {
            this.log('start', message, slowestFeatures(reg.timings?.() ?? null));
        } catch (e) {
            this.log('start', `${message}: unavailable`, e);
        }
    }

    _watchShell(c) {
        const win = w => w ? {
            id: w.get_stable_sequence(), app: w.get_gtk_application_id?.() ?? w.get_wm_class(),
            type: w.get_window_type(), wayland: w.get_client_type() === Meta.WindowClientType.WAYLAND,
            title: w.get_title(),
        } : null;
        const actorWin = actor => win(actor?.meta_window ?? null);

        // The overview, with how long each half took
        let showAt = 0;
        let hideAt = 0;
        c.connect(Main.overview, 'showing', () => {
            showAt = now();
            this.log('shell', 'overview showing');
        });
        c.connect(Main.overview, 'shown', () => this.log('shell', 'overview shown', { ms: now() - showAt }));
        c.connect(Main.overview, 'hiding', () => {
            hideAt = now();
            this.log('shell', 'overview hiding');
        });
        c.connect(Main.overview, 'hidden', () => this.log('shell', 'overview hidden', { ms: now() - hideAt }));

        const wm = global.window_manager;
        for (const name of ['minimize', 'unminimize', 'map', 'destroy'])
            c.connect(wm, name, (_wm, actor) => this.log('shell', `effect ${name}`, actorWin(actor)));
        c.connect(wm, 'size-change', (_wm, actor, which) =>
            this.log('shell', `effect size-change ${SIZE_CHANGES[which] ?? which}`, actorWin(actor)));
        c.connect(wm, 'switch-workspace', (_wm, from, to, direction) =>
            this.log('shell', 'switch workspace', { from, to, direction }));
        c.connect(wm, 'kill-window-effects', (_wm, actor) => this.log('shell', 'kill effects', actorWin(actor)));

        const display = global.display;
        c.connect(display, 'window-created', (_d, w) => this.log('shell', 'window created', win(w)));
        c.connect(display, 'notify::focus-window', () => this.log('shell', 'focus', win(display.focus_window)));
        c.connect(display, 'in-fullscreen-changed', () =>
            this.log('shell', 'full screen changed', { primary: Main.layoutManager.primaryMonitor?.inFullscreen ?? null }));
        c.connect(display, 'grab-op-begin', (_d, w, op) => this.log('shell', 'grab begin', { op, window: win(w) }));
        c.connect(display, 'grab-op-end', (_d, w, op) => this.log('shell', 'grab end', { op, window: win(w) }));

        const workspaces = global.workspace_manager;
        c.connect(workspaces, 'notify::n-workspaces', () => this.log('shell', 'workspaces', { n: workspaces.n_workspaces }));
        c.connect(Main.layoutManager, 'monitors-changed', () => this._logMonitors());
        c.connect(Main.layoutManager, 'startup-complete', () => this.log('shell', 'startup complete'));
        c.connect(Main.sessionMode, 'updated', () =>
            this.log('shell', 'session mode', { mode: Main.sessionMode.currentMode, locked: Main.sessionMode.isLocked }));
    }

    // Hitches inside animations: a gap of SLOW_FRAME_MS or more after a run of smooth frames
    // (debugLogModel.slowFrameMs; an idle stage paints now and then, which is not slow)
    _watchFrames(c) {
        let last = 0;
        let run = 0;
        c.connect(global.stage, 'after-paint', () => {
            const t = now();
            const gap = last ? t - last : Infinity;
            const slow = slowFrameMs(gap, SLOW_FRAME_MS, run);
            if (slow)
                this.log('frames', 'slow frame', { ms: slow, overview: Main.overview.visible });
            run = gap < SMOOTH_FRAME_MS ? run + 1 : 0;
            last = t;
        });
    }

    // A timer that should fire every STALL_TICK_MS: when it comes late, the loop was blocked
    _watchLoop(c) {
        let last = now();
        c.timeout(STALL_TICK_MS, () => {
            const t = now();
            const stall = stallMs(t - last, STALL_TICK_MS, STALL_MS);
            if (stall)
                this.log('loop', 'main loop stall', { ms: stall, overview: Main.overview.visible });
            last = t;
            return GLib.SOURCE_CONTINUE;
        }, { name: 'guava debug stall meter' });
    }
}
