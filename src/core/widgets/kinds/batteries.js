// SPDX-License-Identifier: GPL-3.0-or-later
// Batteries: this computer and connected devices (UPower, Bluetooth included) as charge rings.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { batteryLevel, batteryList } from '../data.js';
import { COLORS, N_, box, canvas, drawRing, icon, label, openSettingsPanel } from './common.js';

const LEVEL_COLOR = { charging: COLORS.green, normal: COLORS.green, low: COLORS.yellow, critical: COLORS.red };

export default {
    id: 'batteries',
    title: N_('Batteries'),
    category: N_('Batteries'),
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    provider: 'batteries',

    build(view) {
        const _ = view._;
        const s = view.scale;
        const root = view.content;
        const rows = view.size === 'large';
        const max = { small: 4, medium: 4, large: 6 }[view.size];
        const holder = rows
            ? box('guava-widget-column guava-widget-batteries', true, { x_expand: true, y_expand: true })
            : new Clutter.Actor({
                layout_manager: new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: true }),
                x_expand: true, y_expand: true,
            });
        root.add_child(holder);
        const empty = label(_('No batteries'), 'guava-widget-caption guava-widget-dim');
        root.add_child(empty);

        const ringSize = Math.round({ small: 46, medium: 64, large: 40 }[view.size] * s);
        const slots = [];
        for (let i = 0; i < max; i++) {
            const state = { percent: 0, level: 'normal' };
            const ring = canvas(ringSize, ringSize, (cr, w, h, fg) =>
                drawRing(cr, w, h, state.percent / 100, LEVEL_COLOR[state.level], fg, Math.max(3, 5 * s)));
            // The device glyph sits in the ring: a sibling over the drawing, not its child
            const gauge = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER });
            gauge.add_child(ring);
            const glyph = icon('battery-symbolic', Math.round(ringSize * 0.4));
            glyph.x_align = glyph.y_align = Clutter.ActorAlign.CENTER;
            gauge.add_child(glyph);
            const pct = label('', 'guava-widget-caption guava-widget-strong', { x_align: rows ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER });
            const name = label('', 'guava-widget-body', { x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            const slot = box(rows ? 'guava-widget-row guava-widget-battery' : 'guava-widget-column guava-widget-battery', !rows);
            slot.add_child(gauge);
            if (rows) {
                slot.add_child(name);
                pct.y_align = Clutter.ActorAlign.CENTER;
            }
            slot.add_child(pct);
            if (rows)
                holder.add_child(slot);
            else
                holder.layout_manager.attach(slot, i % (view.size === 'small' ? 2 : 4), Math.floor(i / (view.size === 'small' ? 2 : 4)), 1, 1);
            slots.push({ slot, ring, glyph, pct, name, state });
        }

        return {
            update(d) {
                const list = batteryList(d?.devices ?? [], _);
                empty.visible = list.length === 0;
                slots.forEach((sl, i) => {
                    const b = list[i];
                    sl.slot.visible = !!b;
                    if (!b)
                        return;
                    sl.state.percent = b.percent;
                    sl.state.level = batteryLevel(b.percent, b.charging);
                    sl.glyph.icon_name = b.charging ? 'battery-full-charging-symbolic' : b.icon;
                    sl.pct.text = `${b.percent}%`;
                    sl.name.text = b.name;
                    sl.slot.accessible_name = `${b.name} ${b.percent}%`;
                    sl.ring.queue_repaint();
                });
            },
        };
    },

    open() {
        openSettingsPanel('power');
    },
};
