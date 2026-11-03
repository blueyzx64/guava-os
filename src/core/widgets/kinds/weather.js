// SPDX-License-Identifier: GPL-3.0-or-later
// Weather, laid out as macOS lays it out: the place and the big temperature at the top, the
// condition's icon, its name and the high and low at the bottom. Medium and large add the
// coming hours.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import { highLow } from '../data.js';
import { N_, box, icon, label, openApp, spacer } from './common.js';

const STATES = {
    'unavailable': N_('Install Weather to see the weather'),
    'no-location': N_('Choose a location in Weather'),
    'loading': N_('Loading…'),
    'offline': N_('Weather is not available'),
};

export default {
    id: 'weather',
    title: N_('Weather'),
    category: N_('Weather'),
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    provider: 'weather',

    build(view) {
        const _ = view._;
        const s = view.scale;
        const root = view.content;
        const small = view.size === 'small';
        const medium = view.size === 'medium';
        // Medium: the current weather on the left, the coming hours on the right. Large: the
        // hours under the current weather.
        const body = medium ? box('guava-widget-row', false, { x_expand: true, y_expand: true }) : root;
        const main = medium ? box('guava-widget-column', true, { x_expand: true, y_expand: true }) : root;
        if (medium)
            root.add_child(body);

        // Top: where, and how warm
        const top = box('guava-widget-row', false, { x_expand: true });
        const left = box('guava-widget-column', true, { x_expand: true });
        const place = label('', 'guava-widget-title');
        const temp = label('', 'guava-widget-hero');
        left.add_child(place);
        left.add_child(temp);
        top.add_child(left);
        const big = icon('weather-few-clouds-symbolic', Math.round(40 * s));
        if (view.size === 'large') {
            big.y_align = Clutter.ActorAlign.START;
            top.add_child(big);
        }
        main.add_child(top);
        main.add_child(spacer());

        // Bottom: the condition's icon with its name and the day's range
        const now = box('guava-widget-row guava-widget-now', false, { x_expand: true });
        const mini = icon('weather-few-clouds-symbolic', Math.round(20 * s));
        mini.y_align = Clutter.ActorAlign.START;
        const text = box('guava-widget-column', true, { x_expand: true });
        const summary = label('', 'guava-widget-title');
        const range = label('', 'guava-widget-caption guava-widget-dim');
        text.add_child(summary);
        text.add_child(range);
        if (!view.size.startsWith('l'))
            now.add_child(mini);
        now.add_child(text);
        main.add_child(now);
        if (medium)
            body.add_child(main);

        const hours = small ? null : box('guava-widget-forecast', false, { x_expand: true });
        if (hours) {
            if (medium)
                hours.y_align = Clutter.ActorAlign.CENTER;
            (medium ? body : root).add_child(hours);
        }
        const message = label('', 'guava-widget-caption guava-widget-dim', { x_expand: true });
        message.clutter_text.line_wrap = true;
        message.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        root.add_child(message);

        return {
            update(d) {
                const ready = d?.state === 'ready';
                now.visible = ready;
                if (hours)
                    hours.visible = ready;
                message.visible = !ready;
                if (!ready) {
                    // A quiet placeholder in the widget's own layout, and why there is no data
                    place.text = _('Weather');
                    temp.text = '--°';
                    big.icon_name = mini.icon_name = 'weather-few-clouds-symbolic';
                    big.opacity = 128;
                    message.text = _(STATES[d?.state ?? 'loading'] ?? STATES.loading);
                    return;
                }
                big.opacity = 255;
                place.text = d.location;
                temp.text = d.temp;
                big.icon_name = mini.icon_name = d.icon;
                summary.text = d.summary;
                range.text = highLow(d.forecasts);
                range.visible = range.text !== '';
                if (!hours)
                    return;
                hours.destroy_all_children();
                for (const f of d.forecasts.slice(0, medium ? 4 : 5)) {
                    const col = box('guava-widget-column guava-widget-hour', true, { x_expand: true });
                    const t = GLib.DateTime.new_from_unix_local(f.time);
                    col.add_child(label(t.format('%l%P').trim(), 'guava-widget-caption guava-widget-dim', { x_align: Clutter.ActorAlign.CENTER }));
                    const g = icon(f.icon, Math.round(20 * s));
                    g.x_align = Clutter.ActorAlign.CENTER;
                    col.add_child(g);
                    col.add_child(label(f.temp, 'guava-widget-body', { x_align: Clutter.ActorAlign.CENTER }));
                    hours.add_child(col);
                }
            },
        };
    },

    open(view) {
        if (view.provider?.open)
            view.provider.open();
        else
            openApp('org.gnome.Weather.desktop');
    },
};
