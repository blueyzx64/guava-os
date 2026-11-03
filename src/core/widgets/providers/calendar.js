// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar data: today, and the coming week's events from the Shell's calendar server
// (org.gnome.Shell.CalendarServer, Evolution Data Server), through the Shell's own
// DBusEventSource as the date menu uses it. A new day re-requests the range.
//
// Shell API: js/ui/calendar.js DBusEventSource (requestRange, getEvents, 'changed',
// destroy), Main.sessionMode.showCalendarEvents. Checked on 50.6.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import { msToNextMinute } from '../data.js';
import { Provider } from './base.js';

const DAYS_AHEAD = 7;

export class CalendarProvider extends Provider {
    initial() {
        return { now: new Date(), events: [], hasCalendars: false };
    }

    run(cleanup) {
        const source = Main.sessionMode.showCalendarEvents ? new Calendar.DBusEventSource() : null;
        this._source = source;
        if (source) {
            cleanup.connect(source, 'changed', () => this._read());
            cleanup.connect(source, 'notify::has-calendars', () => this._read());
            cleanup.add(() => source.destroy());
        }
        cleanup.add(() => {
            this._source = null;
        });
        this._day = -1;
        this._schedule(cleanup);
        this._refresh();
    }

    _schedule(cleanup) {
        const now = GLib.DateTime.new_now_local();
        cleanup.timeout(msToNextMinute(now.get_second()), () => {
            this._refresh();
            if (this.running)
                this._schedule(cleanup);
        }, { name: 'guava-widgets-calendar' });
    }

    // The range moves at midnight; the minute tick keeps "now" and the next event current
    _refresh() {
        const now = new Date();
        if (now.getDate() !== this._day) {
            this._day = now.getDate();
            const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const end = new Date(begin.getTime() + DAYS_AHEAD * 86400000);
            this._range = [begin, end];
            this._source?.requestRange(begin, end);
        }
        this._read();
    }

    _read() {
        const src = this._source;
        const events = src && this._range
            ? src.getEvents(...this._range).map(e => ({ id: e.id, summary: e.summary, date: e.date, end: e.end }))
            : [];
        this.publish({ now: new Date(), events, hasCalendars: !!src?.hasCalendars });
    }
}
