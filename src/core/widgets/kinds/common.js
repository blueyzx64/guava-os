// SPDX-License-Identifier: GPL-3.0-or-later
// Small St building blocks shared by the built-in widget kinds.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

export const N_ = s => s;

export function label(text, styleClass, opts = {}) {
    return new St.Label({ text, style_class: styleClass, x_align: Clutter.ActorAlign.START, ...opts });
}

export function box(styleClass, vertical = false, opts = {}) {
    return new St.BoxLayout({
        style_class: styleClass,
        orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        ...opts,
    });
}

export function icon(name, size, styleClass = 'guava-widget-icon') {
    return new St.Icon({ icon_name: name, icon_size: size, style_class: styleClass });
}

/** A flexible spacer for box layouts. */
export const spacer = () => new St.Widget({ x_expand: true, y_expand: true });

/** Open the first installed app of a list of desktop ids. */
export function openApp(...ids) {
    const sys = Shell.AppSystem.get_default();
    for (const id of ids) {
        const app = sys.lookup_app(id);
        if (app) {
            app.activate();
            return true;
        }
    }
    return false;
}

/** A GNOME Settings panel ("power", "datetime", ...). */
export function openSettingsPanel(panel) {
    try {
        Gio.Subprocess.new(['gnome-control-center', panel], Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.error(`[Guava] could not open Settings (${panel}):`, e);
    }
}

/**
 * A St.DrawingArea that repaints with `paint(cr, width, height, fg)`; fg is the theme's text
 * colour [r, g, b, a] (0..1). Call `area.queue_repaint()` when the data changes.
 */
export function canvas(width, height, paint, styleClass = 'guava-widget-canvas') {
    const area = new St.DrawingArea({ style_class: styleClass, width, height });
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const c = area.get_theme_node().get_foreground_color();
        try {
            paint(cr, w, h, [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255]);
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

/** A ring gauge (battery, CPU): a faint track and the filled arc from 12 o'clock. */
export function drawRing(cr, w, h, fraction, color, fg, lineWidth) {
    const r = Math.min(w, h) / 2 - lineWidth / 2;
    cr.setLineWidth(lineWidth);
    cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.18);
    cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
    cr.stroke();
    if (fraction <= 0)
        return;
    cr.setSourceRGBA(...color);
    cr.setLineCap(1); // ROUND
    cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, fraction));
    cr.stroke();
}

export const COLORS = {
    green: [0.2, 0.78, 0.35, 1],
    yellow: [1, 0.8, 0, 1],
    red: [1, 0.23, 0.19, 1],
    blue: [0.04, 0.52, 1, 1],
};
