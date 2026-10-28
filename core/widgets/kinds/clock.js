// SPDX-License-Identifier: GPL-3.0-or-later
// Clock, as macOS draws it: a round analog face (or the digital time) in the small size, and
// the world clocks of GNOME Clocks (medium, large) with the local time first.

import Clutter from 'gi://Clutter';

import { cityFromTimezone, handAngles, worldLabel } from '../data.js';
import { N_, box, canvas, label, openApp, spacer } from './common.js';

const TAU = 2 * Math.PI;

/**
 * An analog face: the disc, sixty ticks, the numbers 12, 3, 6 and 9 (on the big face), the
 * hands and macOS's orange centre. `mini` is the small face of the world clocks.
 */
function drawFace(cr, w, h, fg, time, mini) {
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
    const { hour, minute } = handAngles(time.get_hour(), time.get_minute());
    cr.setSourceRGBA(fg[0], fg[1], fg[2], mini ? 0.1 : 0.12);
    cr.arc(cx, cy, r, 0, TAU);
    cr.fill();
    cr.setLineCap(1);
    for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        if (mini && !major)
            continue;
        const a = i * TAU / 60;
        const inner = r * (major ? 0.8 : 0.88);
        cr.setSourceRGBA(fg[0], fg[1], fg[2], major ? 0.85 : 0.35);
        cr.setLineWidth(Math.max(1, r * (major ? 0.035 : 0.015)));
        cr.moveTo(cx + Math.sin(a) * inner, cy - Math.cos(a) * inner);
        cr.lineTo(cx + Math.sin(a) * r * 0.94, cy - Math.cos(a) * r * 0.94);
        cr.stroke();
    }
    if (!mini) {
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.95);
        cr.selectFontFace('sans-serif', 0, 1);
        cr.setFontSize(r * 0.25);
        for (const [text, a] of [['12', 0], ['3', 90], ['6', 180], ['9', 270]]) {
            const e = cr.textExtents(text);
            const rad = a * Math.PI / 180;
            const tx = cx + Math.sin(rad) * r * 0.64 - e.width / 2 - e.xBearing;
            const ty = cy - Math.cos(rad) * r * 0.64 - e.height / 2 - e.yBearing;
            cr.moveTo(tx, ty);
            cr.showText(text);
        }
    }
    const hand = (deg, length, width) => {
        const a = deg * Math.PI / 180;
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 1);
        cr.setLineWidth(width);
        cr.moveTo(cx - Math.sin(a) * r * 0.08, cy + Math.cos(a) * r * 0.08);
        cr.lineTo(cx + Math.sin(a) * length, cy - Math.cos(a) * length);
        cr.stroke();
    };
    hand(hour, r * (mini ? 0.5 : 0.46), Math.max(2, r * 0.075));
    hand(minute, r * (mini ? 0.72 : 0.7), Math.max(1.5, r * 0.05));
    cr.setSourceRGBA(1, 0.58, 0, 1);
    cr.arc(cx, cy, Math.max(2.5, r * 0.065), 0, TAU);
    cr.fill();
}

function timeText(dt, twelve) {
    return dt.format(twelve ? '%l:%M' : '%R').trim();
}

// local time first, then the cities of GNOME Clocks, as the data of one face each
function faces(d, _) {
    const now = d.now;
    const here = cityFromTimezone(now.get_timezone()?.get_identifier?.()) || _('Local');
    const dayOf = t => t.get_year() * 1000 + t.get_day_of_year();
    const list = [{ name: here, time: now, sub: _('Today') }];
    for (const c of d.clocks ?? []) {
        const delta = Math.sign(dayOf(c.time) - dayOf(now)) || 0;
        const offset = c.time.get_utc_offset() / 1e6 - now.get_utc_offset() / 1e6;
        list.push({ name: c.name, time: c.time, sub: worldLabel(delta, offset, _) });
    }
    return list;
}

export default {
    id: 'clock',
    title: N_('Clock'),
    category: N_('Clock'),
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    provider: 'time',

    build(view) {
        const _ = view._;
        const s = view.scale;
        const digital = view.config.face === 'digital';
        const root = view.content;

        if (view.size === 'small') {
            if (digital) {
                const date = label('', 'guava-widget-caps guava-widget-accent');
                const time = label('', 'guava-widget-clock-digital');
                root.add_child(date);
                root.add_child(spacer());
                root.add_child(time);
                return {
                    update(d) {
                        if (!d?.now)
                            return;
                        date.text = d.now.format('%a %e').replace(/\s+/g, ' ').toUpperCase();
                        time.text = timeText(d.now, d.twelveHour);
                    },
                };
            }
            let now = null;
            const size = Math.round(138 * s);
            const face = canvas(size, size, (cr, w, h, fg) => now && drawFace(cr, w, h, fg, now, false));
            face.x_align = face.y_align = Clutter.ActorAlign.CENTER;
            face.x_expand = face.y_expand = true;
            root.add_child(face);
            return {
                update(d) {
                    if (!d?.now)
                        return;
                    now = d.now;
                    view.actor.accessible_name = `${_('Clock')} ${timeText(now, d.twelveHour)}`;
                    face.queue_repaint();
                },
            };
        }

        // Medium: one row of up to four faces. Large: a grid of up to six.
        const large = view.size === 'large';
        const max = large ? 6 : 4;
        const columns = large ? 3 : 4;
        const faceSize = Math.round((large ? 84 : 66) * s);
        const state = { list: [] };
        const grid = new Clutter.Actor({
            layout_manager: new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: true }),
            x_expand: true, y_expand: true,
        });
        root.add_child(grid);
        const cells = [];
        for (let i = 0; i < max; i++) {
            const cell = box('guava-widget-column guava-widget-world', true, { x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            const f = canvas(faceSize, faceSize, (cr, w, h, fg) => {
                const c = state.list[i];
                if (c)
                    drawFace(cr, w, h, fg, c.time, true);
            });
            f.x_align = Clutter.ActorAlign.CENTER;
            const name = label('', 'guava-widget-title', { x_align: Clutter.ActorAlign.CENTER });
            const sub = label('', 'guava-widget-footnote guava-widget-dim', { x_align: Clutter.ActorAlign.CENTER });
            cell.add_child(f);
            cell.add_child(name);
            cell.add_child(sub);
            grid.layout_manager.attach(cell, i % columns, Math.floor(i / columns), 1, 1);
            cells.push({ cell, f, name, sub });
        }
        return {
            update(d) {
                if (!d?.now)
                    return;
                state.list = faces(d, _);
                cells.forEach((c, i) => {
                    const w = state.list[i];
                    c.cell.visible = !!w;
                    if (!w)
                        return;
                    c.name.text = w.name;
                    c.sub.text = w.sub;
                    c.cell.accessible_name = `${w.name} ${timeText(w.time, d.twelveHour)}`;
                    c.f.queue_repaint();
                });
            },
        };
    },

    open() {
        openApp('org.gnome.clocks.desktop');
    },

    options(view) {
        if (view.size !== 'small')
            return [];
        return [{
            label: view._('Digital'),
            active: view.config.face === 'digital',
            apply: () => ({ face: view.config.face === 'digital' ? 'analog' : 'digital' }),
        }];
    },
};
