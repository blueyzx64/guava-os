// startupModel.js: pure arithmetic over a login trace (startupTrace.js) and Guava's FeatureRegistry
// timings. No gi imports: tests/startupModel.test.js runs it under plain gjs.
//
// Every time in the result is ms since the Shell process started (when the trace knows it;
// otherwise since the probe extension was enabled, flagged by `clock: 'probe'`).

const ACTIVE = 1; // ExtensionState.ACTIVE (misc/extensionUtils.js)
const IDLE_GAP_MS = 500; // frame intervals longer than this are idle (as in perf-lib.sh)
const MOVE_PX = 2; // a geometry change under this is rounding, not a move

/** p-th percentile of a sorted array (nearest rank). */
export function percentile(sorted, p) {
    if (!sorted.length)
        return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * Frame-interval stats of painted frames inside [from, to].
 *
 * @param {number[]} frames paint times (ms), ascending
 * @returns {{frames: number, p50: number, p95: number, max: number, over33: number, over100: number}}
 */
export function frameStats(frames, from = -Infinity, to = Infinity) {
    const ts = frames.filter(t => t >= from && t <= to);
    const iv = [];
    for (let i = 1; i < ts.length; i++) {
        const d = ts[i] - ts[i - 1];
        if (d <= IDLE_GAP_MS)
            iv.push(d);
    }
    const s = [...iv].sort((a, b) => a - b);
    const r1 = v => Math.round(v * 10) / 10;
    return {
        frames: ts.length, p50: r1(percentile(s, 0.5)), p95: r1(percentile(s, 0.95)),
        max: r1(s.length ? s[s.length - 1] : 0),
        over33: iv.filter(d => d > 33).length, over100: iv.filter(d => d > 100).length,
    };
}

/**
 * How a chrome actor behaved after it first showed: the number of times it moved or resized
 * (`moves`), was hidden again (`hides`), and when it last changed (`settled`).
 *
 * @param {Array<number[]>} rows [t, x, y, w, h, opacity, visible] (changes only)
 */
export function chromeStats(rows) {
    const first = rows.findIndex(r => r[6] && r[5] > 0 && r[3] > 0 && r[4] > 0);
    if (first < 0)
        return { shown: null, moves: 0, hides: 0, settled: null, final: null };
    let moves = 0;
    let hides = 0;
    let settled = rows[first][0];
    let prev = rows[first];
    for (const r of rows.slice(first + 1)) {
        const geom = [1, 2, 3, 4].some(i => Math.abs(r[i] - prev[i]) >= MOVE_PX);
        if (geom && r[6])
            moves++;
        if (prev[6] && !r[6])
            hides++;
        if (geom || r[6] !== prev[6] || r[5] !== prev[5])
            settled = r[0];
        prev = r;
    }
    const last = rows[rows.length - 1];
    return { shown: rows[first][0], moves, hides, settled, final: last.slice(1) };
}

/**
 * @param {object} trace startupTrace.js trace (times relative to trace.t0, ms)
 * @param {?{features: Array<{id: string, loadedAt: ?number, startedAt: ?number,
 *   enableMs: ?number}>, passes: number}} timings FeatureRegistry.timings() (absolute ms, same
 *   clock as trace.t0), or null for stock GNOME
 */
export function summarize(trace, timings = null) {
    const off = trace.procOffset ?? 0;
    const at = t => (t === null || t === undefined ? null : Math.round(t + off));
    const evAt = name => {
        const e = trace.events.find(x => x[1] === name);
        return e ? e[0] : null;
    };
    const startupComplete = evAt('startup-complete');
    const guavaActive = trace.events.find(e => e[1] === 'guava-state' && e[2] === ACTIVE)?.[0] ?? null;
    const startupPrepared = evAt('startup-prepared');

    // Feature starts (registry clock -> trace clock)
    let features = null;
    let lastStart = null;
    if (timings) {
        const rows = timings.features.filter(f => f.startedAt !== null && f.startedAt !== undefined);
        const toTrace = t => t - trace.t0;
        const enableTotal = rows.reduce((a, f) => a + (f.enableMs ?? 0), 0);
        lastStart = rows.length ? Math.max(...rows.map(f => toTrace(f.startedAt))) : null;
        const firstStart = rows.length ? Math.min(...rows.map(f => toTrace(f.startedAt) - f.enableMs)) : null;
        features = {
            started: rows.length, passes: timings.passes,
            enableTotalMs: Math.round(enableTotal),
            first: at(firstStart), last: at(lastStart),
            slowest: [...rows].sort((a, b) => b.enableMs - a.enableMs).slice(0, 8)
                .map(f => `${f.id}:${Math.round(f.enableMs)}`),
            // id@start ms (enable() started), in start order
            order: [...rows].sort((a, b) => a.startedAt - b.startedAt)
                .map(f => `${f.id}@${at(toTrace(f.startedAt) - f.enableMs)}`),
        };
    }

    const chrome = {};
    let lastChrome = null;
    for (const [key, rows] of Object.entries(trace.actors)) {
        const c = chromeStats(rows);
        chrome[key] = { ...c, shown: at(c.shown), settled: at(c.settled) };
        if (c.settled !== null)
            lastChrome = Math.max(lastChrome ?? 0, c.settled);
    }

    const work = trace.events.filter(e => e[1] === 'workarea');
    const ready = Math.max(...[startupComplete, guavaActive, lastStart, lastChrome].filter(v => v !== null));
    // The login window: from the first frame to one second after everything settled
    const window = [0, ready + 1000];
    const stalls = trace.stalls.filter(s => s[0] <= window[1]);
    return {
        clock: trace.procOffset === null ? 'probe' : 'process',
        probeAt: at(0),
        startupPrepared: at(startupPrepared),
        startupComplete: at(startupComplete),
        guavaActive: at(guavaActive),
        ready: at(ready),
        frames: frameStats(trace.frames, ...window),
        stalls50: stalls.length,
        maxStall: stalls.reduce((m, s) => Math.max(m, s[1]), 0),
        stallTotalMs: stalls.reduce((a, s) => a + s[1], 0),
        workarea: { changes: work.length, last: at(work.length ? work[work.length - 1][0] : null),
            final: work.length ? work[work.length - 1][2] : null,
            steps: work.map(e => `${(e[2] ?? []).join(',')}@${at(e[0])}`) },
        events: trace.events.filter(e => e[1] !== 'workarea').map(e => `${e[1]}${e[2] === null ? '' : `=${e[2]}`}@${at(e[0])}`),
        overview: trace.events.filter(e => e[1].startsWith('overview-')).map(e => `${e[1].slice(9)}@${at(e[0])}`),
        chrome,
        features,
    };
}
