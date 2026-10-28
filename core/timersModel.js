// SPDX-License-Identifier: GPL-3.0-or-later
// Guava's own timers, the pure part (core/timers.js is the Shell side). GNOME Clocks has no
// timer API, so the notch's timer live activity and, later, Spotlight ("timer 5 min") use this.
//
// A timer is a plain value:
//   { id, label, durationMs, state: 'running'|'paused'|'finished', endsAt, remainingMs }
//   running   endsAt is the wall-clock time (ms) it rings; remainingMs is null
//   paused    remainingMs is what is left; endsAt is null
//   finished  it rang; it stays in the list until dismissed (the notch shows "Timer done")
// Wall-clock time, so a timer survives a lock (the extension is disabled while locked) and a
// Shell restart: the service stores serialize() and expires what fell due meanwhile.
//
// Pure JS (no gi imports): tested by tests/timersModel.test.js.

export const MAX_TIMERS = 8;
export const MAX_DURATION_MS = 24 * 3600 * 1000;

const clampDuration = ms => Math.max(1000, Math.min(MAX_DURATION_MS, Math.round(ms)));

/** @returns {number} ms left at `now` (0 once finished) */
export function remaining(timer, now) {
    if (timer.state === 'running')
        return Math.max(0, timer.endsAt - now);
    if (timer.state === 'paused')
        return Math.max(0, timer.remainingMs);
    return 0;
}

/**
 * @param {object[]} list
 * @param {{id: string, label?: string, durationMs: number}} spec
 * @param {number} now wall-clock ms
 * @returns {object[]} a new list; the oldest finished, then the oldest running timer makes room
 */
export function startTimer(list, { id, label = '', durationMs }, now) {
    if (!Number.isFinite(durationMs) || durationMs <= 0)
        throw new Error('timers: durationMs must be a positive number');
    const ms = clampDuration(durationMs);
    let next = list.filter(t => t.id !== id);
    while (next.length >= MAX_TIMERS) {
        const victim = next.find(t => t.state === 'finished') ?? next[0];
        next = next.filter(t => t !== victim);
    }
    return [...next, { id, label: String(label), durationMs: ms, state: 'running', endsAt: now + ms, remainingMs: null }];
}

const update = (list, id, fn) => list.map(t => (t.id === id ? fn(t) : t));

export function pauseTimer(list, id, now) {
    return update(list, id, t => (t.state !== 'running' ? t
        : { ...t, state: 'paused', endsAt: null, remainingMs: Math.max(0, t.endsAt - now) }));
}

export function resumeTimer(list, id, now) {
    return update(list, id, t => (t.state !== 'paused' ? t
        : { ...t, state: 'running', endsAt: now + t.remainingMs, remainingMs: null }));
}

/** Cancel a running or paused timer, or dismiss a finished one. */
export function removeTimer(list, id) {
    return list.filter(t => t.id !== id);
}

/**
 * Mark every running timer that is due as finished.
 * @returns {{list: object[], finished: object[]}} finished: the timers that rang just now
 */
export function expire(list, now) {
    const finished = [];
    const next = list.map(t => {
        if (t.state !== 'running' || t.endsAt > now)
            return t;
        const done = { ...t, state: 'finished', remainingMs: 0 };
        finished.push(done);
        return done;
    });
    return { list: finished.length ? next : list, finished };
}

/** The next wall-clock time a timer rings, or null. */
export function nextDue(list) {
    let due = null;
    for (const t of list) {
        if (t.state === 'running' && (due === null || t.endsAt < due))
            due = t.endsAt;
    }
    return due;
}

export function serialize(list) {
    return JSON.stringify(list);
}

/** Parse what serialize() stored; anything malformed is dropped, never thrown. */
export function parse(text) {
    let raw;
    try {
        raw = JSON.parse(text || '[]');
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(raw))
        return [];
    const ok = t => t && typeof t.id === 'string' && Number.isFinite(t.durationMs) &&
        ((t.state === 'running' && Number.isFinite(t.endsAt)) ||
         (t.state === 'paused' && Number.isFinite(t.remainingMs)) ||
         t.state === 'finished');
    return raw.filter(ok).slice(-MAX_TIMERS).map(t => ({
        id: t.id,
        label: String(t.label ?? ''),
        durationMs: clampDuration(t.durationMs),
        state: t.state,
        endsAt: t.state === 'running' ? t.endsAt : null,
        remainingMs: t.state === 'paused' ? t.remainingMs : t.state === 'finished' ? 0 : null,
    }));
}
