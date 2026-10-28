// SPDX-License-Identifier: GPL-3.0-or-later
// TimerService: Guava's own countdown timers (the Shell side of core/timersModel.js).
//
//   const id = ctx.timers.startTimer({ label: 'Tea', seconds: 180 });
//   ctx.timers.pause(id);  ctx.timers.resume(id);  ctx.timers.cancel(id);  // cancel also dismisses
//   ctx.timers.list();     // plain values, see timersModel.js; remaining(timer) for ms left
//   ctx.events.on('timers-changed', ({ timers }) => ...);
//   ctx.events.on('timer-finished', ({ timer }) => ...);
//
// Cost while idle: one GLib timeout armed for the next timer that rings, none without timers.
// Nothing ticks per second here; a view that shows a countdown runs its own tick while shown.
// The list is stored in the Guava key `timers-state` (wall-clock times), so timers survive the
// lock screen (which disables the extension) and a Shell restart.

import GLib from 'gi://GLib';

import {
    startTimer, pauseTimer, resumeTimer, removeTimer, expire, nextDue, remaining, serialize, parse,
} from './timersModel.js';

const STATE_KEY = 'timers-state';
// GLib timeouts take a guint; a day fits well, longer waits re-arm on wake-up.
const MAX_WAIT_MS = 24 * 3600 * 1000;

const wallNow = () => Date.now();

export class TimerService {
    /**
     * @param {import('./events.js').EventHub} events
     * @param {Gio.Settings} settings Guava's settings
     */
    constructor(events, settings) {
        this._events = events;
        this._settings = settings;
        this._list = [];
        this._sourceId = 0;
        this._running = false;
        this._seq = 0;
    }

    /** Load the stored timers and arm the next one (extension enable). */
    start() {
        if (this._running)
            return;
        this._running = true;
        this._list = parse(this._settings.get_string(STATE_KEY));
        this._expireAndArm(true);
    }

    /** Drop the alarm; the stored list stays for the next start (extension disable). */
    stop() {
        this._running = false;
        this._disarm();
        this._list = [];
    }

    /** @returns {object[]} a copy of the timers, oldest first */
    list() {
        return this._list.map(t => ({ ...t }));
    }

    /** ms left on `timer` (a value from list() or an event) right now */
    remaining(timer) {
        return remaining(timer, wallNow());
    }

    /**
     * @param {{seconds: number, label?: string}} spec
     * @returns {string} the timer id
     */
    startTimer({ seconds, label = '' }) {
        const id = `t${wallNow().toString(36)}${(this._seq++).toString(36)}`;
        this._commit(startTimer(this._list, { id, label, durationMs: seconds * 1000 }, wallNow()));
        return id;
    }

    pause(id) {
        this._commit(pauseTimer(this._list, id, wallNow()));
    }

    resume(id) {
        this._commit(resumeTimer(this._list, id, wallNow()));
    }

    cancel(id) {
        this._commit(removeTimer(this._list, id));
    }

    _commit(list) {
        if (!this._running)
            throw new Error('timers: the service is not running');
        this._list = list;
        this._expireAndArm(false);
    }

    _disarm() {
        if (this._sourceId)
            GLib.source_remove(this._sourceId);
        this._sourceId = 0;
    }

    // Ring what is due, save, tell listeners, then sleep until the next one
    _expireAndArm(initial) {
        const { list, finished } = expire(this._list, wallNow());
        const changed = list !== this._list;
        this._list = list;
        const text = serialize(this._list);
        if (text !== this._settings.get_string(STATE_KEY))
            this._settings.set_string(STATE_KEY, text);
        this._disarm();
        const due = nextDue(this._list);
        if (due !== null) {
            const wait = Math.max(1, Math.min(MAX_WAIT_MS, due - wallNow()));
            this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
                this._sourceId = 0;
                this._expireAndArm(false);
                return GLib.SOURCE_REMOVE;
            });
            GLib.Source.set_name_by_id(this._sourceId, '[guava] timer alarm');
        }
        if (!initial || changed)
            this._events.emit('timers-changed', { timers: this.list() });
        for (const timer of finished)
            this._events.emit('timer-finished', { timer: { ...timer } });
    }
}

