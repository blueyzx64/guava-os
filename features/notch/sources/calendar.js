// SPDX-License-Identifier: GPL-3.0-or-later
// The next calendar event, from the Shell's calendar server (the same D-Bus service the date
// menu reads, through the Shell's own DBusEventSource in js/ui/calendar.js, GNOME 45-51).
// Guava keeps its own event source, so its time range never disturbs the date menu's.
//
// Nothing ticks: one timeout is armed for the next moment the answer can change (15 minutes
// before the event, its start, its end, or the end of the look-ahead window).

import GLib from 'gi://GLib';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import { nextEvent, EVENT_SOON_MS, EVENT_HORIZON_MS } from '../model.js';

const DAY_MS = 24 * 3600 * 1000;

const isAllDay = e => {
    const start = e.date;
    const len = e.end - e.date;
    return start.getHours() === 0 && start.getMinutes() === 0 && len > 0 && len % DAY_MS === 0;
};

/**
 * @param {CleanupRegistry} cleanup
 * @param {{activity: Function, events: (list: object[]) => void}} sink events(): today's
 *   timed and all-day events for the Widgets tab
 */
export function watchCalendar(cleanup, sink) {
    let source;
    try {
        source = new Calendar.DBusEventSource();
    } catch (e) {
        console.warn(`[Guava] notch: no calendar server: ${e.message}`);
        return;
    }
    let timer = 0;
    let rangeEnd = 0;
    const disarm = () => {
        if (timer)
            cleanup.release(timer);
        timer = 0;
    };

    const request = () => {
        const now = new Date();
        const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(begin.getTime() + 2 * DAY_MS);
        rangeEnd = end.getTime();
        source.requestRange(begin, end);
    };

    const update = () => {
        disarm();
        const now = Date.now();
        if (now + EVENT_HORIZON_MS > rangeEnd)
            request();
        const dayStart = new Date(new Date().setHours(0, 0, 0, 0));
        const raw = source.getEvents(dayStart, new Date(now + EVENT_HORIZON_MS));
        const list = raw.map(e => ({
            id: e.id, summary: e.summary ?? '', start: e.date.getTime(), end: e.end.getTime(), allDay: isAllDay(e),
        }));
        const dayEnd = dayStart.getTime() + DAY_MS;
        sink.events(list.filter(e => e.start < dayEnd && e.end > dayStart.getTime()));
        const next = nextEvent(list, now);
        sink.activity('event', next?.soon ? 'event-soon' : 'event', next
            ? { summary: next.event.summary, start: next.event.start, end: next.event.end, ongoing: next.ongoing }
            : null);
        // The next moment the answer can change
        const marks = [rangeEnd - EVENT_HORIZON_MS, dayEnd];
        if (next)
            marks.push(next.event.start - EVENT_SOON_MS, next.event.start, next.event.end);
        const wake = Math.min(...marks.filter(t => t > now));
        if (Number.isFinite(wake)) {
            timer = cleanup.timeout(Math.min(DAY_MS, Math.max(1000, wake - now + 500)), () => {
                timer = 0;
                update();
                return GLib.SOURCE_REMOVE;
            }, { name: 'notch next event' });
        }
    };

    cleanup.connect(source, 'changed', update);
    cleanup.add(() => {
        disarm();
        sink.activity('event', 'event', null);
        source.destroy();
    });
    request();
    update();
}
