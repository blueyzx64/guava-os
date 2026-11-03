// SPDX-License-Identifier: GPL-3.0-or-later
// System: processor and memory use (sampled only while visible); medium adds the CPU history.

import { formatBytes } from '../data.js';
import { COLORS, N_, box, canvas, drawRing, label, openApp, spacer } from './common.js';

function drawHistory(cr, w, h, history, fg) {
    cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.12);
    cr.rectangle(0, 0, w, h);
    cr.fill();
    if (history.length < 2)
        return;
    const step = w / 29;
    const x0 = w - (history.length - 1) * step;
    cr.moveTo(x0, h);
    history.forEach((v, i) => cr.lineTo(x0 + i * step, h - v * h));
    cr.lineTo(w, h);
    cr.closePath();
    cr.setSourceRGBA(COLORS.blue[0], COLORS.blue[1], COLORS.blue[2], 0.35);
    cr.fillPreserve();
    cr.setSourceRGBA(...COLORS.blue);
    cr.setLineWidth(1.5);
    cr.stroke();
}

export default {
    id: 'system',
    title: N_('System'),
    category: N_('System'),
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    provider: 'system',

    build(view) {
        const _ = view._;
        const s = view.scale;
        const root = view.content;
        const state = { cpu: 0, mem: 0, history: [] };
        const ringSize = Math.round(54 * s);
        const gauge = (title, key, color) => {
            const col = box('guava-widget-column guava-widget-gauge', true, { x_expand: true });
            const ring = canvas(ringSize, ringSize, (cr, w, h, fg) => drawRing(cr, w, h, state[key], color, fg, Math.max(3, 6 * s)));
            const value = label('', 'guava-widget-title');
            col.add_child(ring);
            col.add_child(value);
            col.add_child(label(title, 'guava-widget-caption guava-widget-dim'));
            return { col, ring, value };
        };
        const cpu = gauge(_('CPU'), 'cpu', COLORS.blue);
        const mem = gauge(_('Memory'), 'mem', COLORS.green);
        const row = box('guava-widget-row', false, { x_expand: true });
        row.add_child(cpu.col);
        row.add_child(mem.col);
        let graph = null;
        if (view.size === 'medium') {
            const line = box('guava-widget-row', false, { x_expand: true, y_expand: true });
            line.add_child(row);
            const right = box('guava-widget-column', true, { x_expand: true });
            right.add_child(label(_('CPU history'), 'guava-widget-caption guava-widget-dim'));
            graph = canvas(Math.round(150 * s), Math.round(80 * s), (cr, w, h, fg) => drawHistory(cr, w, h, state.history, fg));
            right.add_child(graph);
            line.add_child(right);
            root.add_child(line);
        } else {
            root.add_child(spacer());
            root.add_child(row);
            root.add_child(spacer());
        }
        const memText = label('', 'guava-widget-caption guava-widget-dim');
        root.add_child(memText);

        return {
            update(d) {
                if (!d)
                    return;
                state.cpu = d.cpu ?? 0;
                state.history = d.history ?? [];
                state.mem = d.memory ? d.memory.used / d.memory.total : 0;
                cpu.value.text = `${Math.round(state.cpu * 100)}%`;
                mem.value.text = `${Math.round(state.mem * 100)}%`;
                memText.text = d.memory ? `${formatBytes(d.memory.used)} / ${formatBytes(d.memory.total)}` : '';
                cpu.ring.queue_repaint();
                mem.ring.queue_repaint();
                graph?.queue_repaint();
            },
        };
    },

    open() {
        openApp('org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop');
    },
};
