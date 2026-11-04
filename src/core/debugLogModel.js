// SPDX-License-Identifier: GPL-3.0-or-later
// Pure parts of the debug log (core/debugLog.js): how a line looks, what of a payload it may
// show, and when the main loop counts as stalled. No GNOME imports: tested in
// tests/debugLogModel.test.js.
//
// Privacy: the log is meant to be sent to a developer. It never shows text a user typed or
// read (window titles, notification bodies, clipboard and search text, passwords): those
// fields are replaced by their length.

export const PREFIX = '[Guava debug]';

/** Payload fields whose values are never written, only their length. */
export const PRIVATE_FIELDS = new Set([
    'title', 'body', 'text', 'content', 'summary', 'query', 'terms', 'password', 'secret', 'label',
    'subtitle', 'description', 'path', 'uri', 'url', 'name',
]);

const MAX_STRING = 80;
const MAX_ITEMS = 6;
const MAX_DEPTH = 3;

/**
 * A short, single-line, private rendering of any value (payloads, GObjects, errors).
 *
 * @param {*} value
 * @param {number} [depth]
 * @returns {string}
 */
export function summarize(value, depth = 0) {
    if (value === null || value === undefined)
        return String(value);
    switch (typeof value) {
    case 'number':
        return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
    case 'boolean':
        return String(value);
    case 'string':
        return JSON.stringify(value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value);
    case 'function':
        return 'fn';
    case 'symbol':
    case 'bigint':
        return String(value);
    default:
        break;
    }
    if (value instanceof Error)
        return `Error(${summarize(value.message, depth + 1)})`;
    // GObjects and other class instances: their type, not their contents
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
        return `<${value.constructor?.name ?? 'object'}>`;
    if (depth >= MAX_DEPTH)
        return Array.isArray(value) ? `[${value.length}]` : '{…}';
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ITEMS).map(v => summarize(v, depth + 1));
        if (value.length > MAX_ITEMS)
            items.push(`…+${value.length - MAX_ITEMS}`);
        return `[${items.join(',')}]`;
    }
    const parts = Object.keys(value).map(k => {
        const v = value[k];
        if (PRIVATE_FIELDS.has(k) && v !== null && v !== undefined)
            return `${k}:<${typeof v === 'string' ? `${v.length} chars` : 'hidden'}>`;
        return `${k}:${summarize(v, depth + 1)}`;
    });
    return `{${parts.join(',')}}`;
}

/**
 * One log line: "[Guava debug] +12.345s scope: message {data}".
 *
 * @param {number} sinceMs ms since the debug log started (the session timeline)
 * @param {string} scope a feature id or service ('events', 'shell', 'frames')
 * @param {string} message
 * @param {*} [data]
 * @returns {string}
 */
export function formatLine(sinceMs, scope, message, data) {
    const t = `+${(Math.max(0, sinceMs) / 1000).toFixed(3)}s`;
    const tail = data === undefined ? '' : ` ${summarize(data)}`;
    return `${PREFIX} ${t} ${scope}: ${message}${tail}`;
}

/**
 * Main-loop stall detection: a timer asked to fire every `intervalMs` fired `elapsedMs` after
 * the last time. The loop was blocked for the difference when that is at least `thresholdMs`.
 *
 * @returns {number} the stall in ms, or 0
 */
export function stallMs(elapsedMs, intervalMs, thresholdMs) {
    const late = elapsedMs - intervalMs;
    return late >= thresholdMs ? Math.round(late) : 0;
}

/** Smooth frames in a row before a late one counts as a hitch in an animation. */
export const SMOOTH_RUN = 3;

/**
 * Frames: the gap between two painted frames counts as slow from `thresholdMs`, only inside an
 * animation (`smoothRun` smooth frames just before it: an idle stage paints now and then, which
 * is not slow) and below `maxMs` (a longer pause is a main-loop stall, reported as one).
 *
 * @returns {number} the slow gap in ms, or 0
 */
export function slowFrameMs(gapMs, thresholdMs, smoothRun, maxMs = 250) {
    return smoothRun >= SMOOTH_RUN && gapMs >= thresholdMs && gapMs < maxMs ? Math.round(gapMs) : 0;
}

/**
 * The feature start times worth a log line: the slowest `n` enables, "id:ms".
 *
 * @param {{features?: {id: string, enableMs: number|null}[]}} timings FeatureRegistry.timings()
 * @returns {{started: number, slowest: string[]}}
 */
export function slowestFeatures(timings, n = 12) {
    const started = (timings?.features ?? []).filter(f => typeof f.enableMs === 'number');
    const slowest = [...started].sort((a, b) => b.enableMs - a.enableMs).slice(0, n)
        .map(f => `${f.id}:${Math.round(f.enableMs)}`);
    return { started: started.length, slowest };
}

/**
 * Rate limit per key: at most `max` lines per `windowMs`; the rest are counted and reported
 * once with the next line that passes.
 */
export class RateLimit {
    constructor(max = 20, windowMs = 1000) {
        this._max = max;
        this._windowMs = windowMs;
        this._keys = new Map(); // key -> {start, count, dropped}
    }

    /**
     * @param {string} key
     * @param {number} nowMs
     * @returns {{pass: boolean, dropped: number}} dropped: lines suppressed before this one
     */
    check(key, nowMs) {
        let k = this._keys.get(key);
        if (!k || nowMs - k.start >= this._windowMs) {
            const dropped = k?.dropped ?? 0;
            k = { start: nowMs, count: 0, dropped: 0 };
            this._keys.set(key, k);
            k.count++;
            return { pass: true, dropped };
        }
        if (k.count >= this._max) {
            k.dropped++;
            return { pass: false, dropped: 0 };
        }
        k.count++;
        return { pass: true, dropped: 0 };
    }
}
