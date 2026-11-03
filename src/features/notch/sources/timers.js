// SPDX-License-Identifier: GPL-3.0-or-later
// Guava timers (core/timers.js) as live activities: one per running or paused timer, and a
// "Timer done" alert with the system's completion sound when one rings. The ringing timer is
// dismissed from the service once the notch has shown it. Spotlight's 'timer-start-requested'
// starts one here while this source runs.

/**
 * @param {CleanupRegistry} cleanup
 * @param {{events: EventHub, timers: TimerService}} ctx
 * @param {{activity: Function}} sink
 * @param {function(string): string} _
 */
export function watchTimers(cleanup, ctx, sink, _) {
    let shown = new Set();
    const sync = timers => {
        const next = new Set();
        for (const t of timers) {
            if (t.state === 'finished')
                continue;
            next.add(t.id);
            sink.activity(`timer:${t.id}`, 'timer', {
                id: t.id, label: t.label, state: t.state, endsAt: t.endsAt, remainingMs: t.remainingMs,
            });
        }
        for (const id of shown) {
            if (!next.has(id))
                sink.activity(`timer:${id}`, 'timer', null);
        }
        shown = next;
    };
    ctx.events.on('timers-changed', ({ timers }) => sync(timers), cleanup);
    // Spotlight's "Start Timer" (with nobody listening it runs its own fallback)
    ctx.events.on('timer-start-requested', ({ seconds, label }) => {
        if (Number.isFinite(seconds) && seconds > 0)
            ctx.timers.startTimer({ seconds, label });
    }, cleanup);
    const present = t => {
        sink.activity(`timer-done:${t.id}`, 'timer-done', { id: t.id, label: t.label || _('Timer') }, { fresh: true });
        ctx.timers.cancel(t.id);
    };
    // Rung while the screen is locked: the island is hidden then (D-018), so the alert waits for the unlock
    const waiting = new Map();
    ctx.events.on('timer-finished', ({ timer }) => {
        try {
            global.display.get_sound_player().play_from_theme('complete', _('Timer done'), null);
        } catch (_e) {
            // No sound theme; the pill still shows it.
        }
        if (ctx.session?.locked)
            waiting.set(timer.id, timer);
        else
            present(timer);
    }, cleanup);
    ctx.events.on('session-unlocked', () => {
        const due = [...waiting.values()];
        waiting.clear();
        due.forEach(present);
    }, cleanup);
    sync(ctx.timers.list());
    // Finished while the notch was off: show them once now (still locked: at the unlock)
    for (const t of ctx.timers.list().filter(x => x.state === 'finished')) {
        if (ctx.session?.locked)
            waiting.set(t.id, t);
        else
            present(t);
    }
    cleanup.add(() => {
        for (const id of shown)
            sink.activity(`timer:${id}`, 'timer', null);
        shown = new Set();
    });
}
