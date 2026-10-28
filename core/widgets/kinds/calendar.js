// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar: today's date and what comes next (Evolution Data Server through the Shell's
// calendar server); the large size adds the month.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { monthGrid, upcomingEvents } from '../data.js';
import { N_, box, label, openApp, spacer } from './common.js';

const fmtTime = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function eventRow(e, _) {
    const row = box('guava-widget-event', false, { x_expand: true });
    row.add_child(new St.Widget({ style_class: 'guava-widget-event-bar' }));
    const text = box('guava-widget-column', true, { x_expand: true });
    text.add_child(label(e.summary || _('Untitled'), 'guava-widget-body guava-widget-strong'));
    const when = e.allDay ? _('All day')
        : `${e.today ? '' : `${e.date.toLocaleDateString([], { weekday: 'short' })} `}${fmtTime(e.date)} – ${fmtTime(e.end)}`;
    text.add_child(label(when, 'guava-widget-caption guava-widget-dim'));
    row.add_child(text);
    return row;
}

export default {
    id: 'calendar',
    title: N_('Calendar'),
    category: N_('Calendar'),
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    provider: 'calendar',

    build(view) {
        const _ = view._;
        const root = view.content;
        const large = view.size === 'large';
        const main = box('guava-widget-row', false, { x_expand: true, y_expand: !large });
        root.add_child(main);

        // Small and medium: the weekday in red over the big day number, as macOS shows it.
        // Large: the month's name in red over the month's grid.
        const dateCol = box('guava-widget-column guava-widget-date', true);
        const weekday = label('', 'guava-widget-caps guava-widget-accent');
        const day = label('', 'guava-widget-day');
        dateCol.add_child(weekday);
        if (!large)
            dateCol.add_child(day);
        main.add_child(dateCol);

        let grid = null;
        if (large) {
            grid = new St.Widget({
                style_class: 'guava-widget-month',
                layout_manager: new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: true }),
                x_expand: true,
            });
            dateCol.x_expand = true;
            dateCol.add_child(grid);
        }

        const list = box('guava-widget-events', true, { x_expand: true, y_expand: true });
        if (view.size === 'small') {
            dateCol.add_child(spacer());
            dateCol.add_child(list);
            dateCol.y_expand = true;
        } else if (view.size === 'medium') {
            main.add_child(list);
        } else {
            root.add_child(list);
        }
        const limit = { small: 1, medium: 3, large: 2 }[view.size];
        let monthKey = '';

        const fillMonth = now => {
            const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
            if (!grid || key === monthKey)
                return;
            monthKey = key;
            grid.destroy_all_children();
            const lm = grid.layout_manager;
            const weeks = monthGrid(now.getFullYear(), now.getMonth(), now, 1);
            const names = [];
            for (let i = 0; i < 7; i++)
                names.push(new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'narrow' }));
            names.forEach((n, i) => lm.attach(label(n, 'guava-widget-month-head', { x_align: Clutter.ActorAlign.CENTER }), i, 0, 1, 1));
            weeks.forEach((w, r) => w.forEach((d, c) => {
                const cls = `guava-widget-month-day${d.inMonth ? '' : ' guava-widget-dim'}${d.today ? ' guava-widget-today' : ''}`;
                lm.attach(label(String(d.day), cls, { x_align: Clutter.ActorAlign.CENTER }), c, r + 1, 1, 1);
            }));
        };

        return {
            update(d) {
                const now = d?.now ?? new Date();
                weekday.text = (large ? now.toLocaleDateString([], { month: 'long' })
                    : now.toLocaleDateString([], { weekday: 'long' })).toUpperCase();
                day.text = String(now.getDate());
                fillMonth(now);
                list.destroy_all_children();
                const events = upcomingEvents(d?.events ?? [], now, limit);
                if (!events.length) {
                    list.add_child(label(d?.hasCalendars === false && view.size !== 'small'
                        ? _('No calendars') : _('No more events today'), 'guava-widget-caption guava-widget-dim',
                    { x_expand: true }));
                    return;
                }
                for (const e of events)
                    list.add_child(eventRow(e, _));
            },
        };
    },

    open() {
        openApp('org.gnome.Calendar.desktop');
    },
};
