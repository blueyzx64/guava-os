// startupTrace.js: records the first seconds of a Shell session for the login perf probes.
// The probe extension is enabled FIRST (inner-real.sh puts it at the head of enabled-extensions),
// so this starts before Guava's enable() and sees the whole login: every painted frame, main-loop
// stalls (a 10 ms heartbeat), the Shell's startup signals, Guava's extension state, work-area
// changes and the geometry of the chrome actors (panel, dock, notch, ...). It stops by itself
// (STOP_AFTER_MS after startup-complete, or HARD_STOP_MS), so it costs nothing afterwards.
// Read it with `globalThis.__x2startup.summary()` (startupModel.js does the arithmetic).
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { summarize } from './startupModel.js';

const STOP_AFTER_MS = 8000;
const HARD_STOP_MS = 40000;
const GUAVA = 'guava-os@blueyzx64';
// Chrome found by name (walked a few times a second until each one exists)
const NAMED = ['guava-dock', 'guava-notch', 'guava-stage-manager', 'guava-desktop-icons', 'guava-widgets-layer'];

const now = () => GLib.get_monotonic_time() / 1000;

// Milliseconds since this process started (CLOCK_MONOTONIC and /proc starttime share the boot
// epoch when the machine never slept, which holds in the harness)
function processStartMs() {
    try {
        const [, raw] = GLib.file_get_contents('/proc/self/stat');
        const s = new TextDecoder().decode(raw);
        const fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return Number(fields[19]) * 10; // starttime in clock ticks (USER_HZ 100)
    } catch (_e) {
        return null;
    }
}

export function startTrace() {
    if (globalThis.__x2startup)
        return;
    const lm = Main.layoutManager;
    const t0 = now();
    const procStart = processStartMs();
    const trace = {
        t0, procOffset: procStart === null ? null : t0 - procStart,
        startingUpAtProbe: !!lm._startingUp,
        frames: [], stalls: [], events: [], actors: {}, running: true,
    };
    const rel = () => now() - t0;
    const ev = (name, detail = null) => trace.events.push([rel(), name, detail]);
    const ids = [];
    const conn = (obj, sig, fn) => {
        try {
            ids.push([obj, obj.connect(sig, fn)]);
        } catch (_e) {}
    };

    const found = { panelBox: lm.panelBox, panel: Main.panel };
    let lastWalk = -1e9;
    const walk = () => {
        const want = NAMED.filter(n => !found[n]);
        if (!want.length)
            return;
        const visit = a => {
            if (a.name && want.includes(a.name) && !found[a.name])
                found[a.name] = a;
            for (const c of a.get_children())
                visit(c);
        };
        visit(global.stage);
    };
    const sample = t => {
        for (const [key, a] of Object.entries(found)) {
            let row;
            try {
                const [x, y] = a.get_transformed_position();
                const [w, h] = a.get_transformed_size();
                let vis = a.visible;
                try {
                    vis = a.get_paint_visibility();
                } catch (_e) {}
                row = [Math.round(x), Math.round(y), Math.round(w), Math.round(h), a.get_paint_opacity?.() ?? a.opacity, vis ? 1 : 0];
            } catch (_e) {
                row = [0, 0, 0, 0, 0, 0]; // destroyed
            }
            const list = (trace.actors[key] ??= []);
            const prev = list[list.length - 1];
            if (!prev || prev.slice(1).some((v, i) => v !== row[i]))
                list.push([Math.round(t), ...row]);
        }
    };

    conn(global.stage, 'after-paint', () => {
        const t = rel();
        trace.frames.push(t);
        if (t - lastWalk > 250) {
            lastWalk = t;
            walk();
        }
        sample(t);
    });
    let expected = now() + 10;
    const hb = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        const n = now();
        const late = n - expected;
        if (late > 50)
            trace.stalls.push([n - t0, Math.round(late)]);
        expected = n + 10;
        return GLib.SOURCE_CONTINUE;
    });
    let stopTimer = 0;
    const stop = () => {
        if (!trace.running)
            return;
        trace.running = false;
        ev('trace-stop');
        for (const [obj, id] of ids) {
            try {
                obj.disconnect(id);
            } catch (_e) {}
        }
        GLib.source_remove(hb);
        if (stopTimer)
            GLib.source_remove(stopTimer);
        stopTimer = 0;
    };

    if (!lm._startingUp)
        ev('startup-complete', 'before-probe');
    conn(lm, 'startup-prepared', () => ev('startup-prepared'));
    conn(lm, 'startup-complete', () => {
        ev('startup-complete');
        if (stopTimer)
            GLib.source_remove(stopTimer);
        stopTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOP_AFTER_MS, () => {
            stopTimer = 0;
            stop();
            return GLib.SOURCE_REMOVE;
        });
    });
    for (const s of ['showing', 'shown', 'hiding', 'hidden'])
        conn(Main.overview, s, () => ev(`overview-${s}`));
    conn(Main.extensionManager, 'extension-state-changed', (_m, ext) => {
        if (ext?.uuid === GUAVA)
            ev('guava-state', ext.state);
    });
    // Guava enabled before this signal could be connected (or its state change was missed):
    // the state at the next main-loop turn tells
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        const st = Main.extensionManager.lookup(GUAVA)?.state;
        ev('guava-state-idle', st ?? null);
        return GLib.SOURCE_REMOVE;
    });
    conn(global.display, 'workareas-changed', () => {
        const r = lm.getWorkAreaForMonitor(lm.primaryIndex);
        ev('workarea', r ? [r.x, r.y, r.width, r.height] : null);
    });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, HARD_STOP_MS, () => {
        stop();
        return GLib.SOURCE_REMOVE;
    });

    globalThis.__x2startup = {
        trace,
        stop,
        // Guava's FeatureRegistry timings, when the extension exposes them
        summary: () => {
            const reg = Main.extensionManager.lookup(GUAVA)?.stateObj?._features;
            return summarize(trace, reg?.timings?.() ?? null);
        },
    };
}
