// SPDX-License-Identifier: GPL-3.0-or-later
// App Exposé's strip of minimized windows: a row of small live previews along the bottom
// of the screen, below the app's spread windows, as on macOS. Click one to bring it back.
// The overview reserves the strip's height through the (hidden) dash's preferred height,
// so the window picker above never overlaps it (index.js).
//
// Shell API: Main.layoutManager.overviewGroup, primaryMonitor, Main.activateWindow;
// Clutter.Clone of a minimized window actor (the overview clones minimized windows the
// same way).

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { stripCardSize } from './model.js';

/** Card box height and the strip's total height (with its padding and margin). */
export const CARD_HEIGHT = 96;
export const STRIP_HEIGHT = CARD_HEIGHT + 48;
const CARD_MAX_WIDTH = 180;

export class ExposeStrip {
    /**
     * @param {object} motion ctx.motion
     * @param {(s: string) => string} _
     */
    constructor(motion, _) {
        this._motion = motion;
        this._ = _;
        this._cleanup = null;
    }

    get shown() {
        return this._cleanup !== null;
    }

    /**
     * @param {Meta.Window[]} windows the app's minimized windows (none: nothing is shown)
     */
    show(windows) {
        this.hide();
        if (!windows.length)
            return;
        const c = this._cleanup = new CleanupRegistry();
        const monitor = Main.layoutManager.primaryMonitor;
        const strip = c.actor(new St.BoxLayout({
            name: 'guava-mc-expose-strip',
            style_class: 'guava-mc-expose-strip',
            opacity: 0,
        }));
        for (const win of windows) {
            const source = win.get_compositor_private();
            if (!source)
                continue;
            const size = stripCardSize(win.get_frame_rect(), CARD_HEIGHT, CARD_MAX_WIDTH);
            const card = new St.Button({
                style_class: 'guava-mc-expose-card',
                accessible_name: win.get_title() || this._('Untitled Window'),
                can_focus: true,
                y_align: Clutter.ActorAlign.END,
            });
            const column = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
            const frame = win.get_frame_rect();
            const buffer = win.get_buffer_rect();
            // The actor includes the client-side shadow: scale it so the frame gets `size`
            const scale = size.width / Math.max(1, frame.width);
            const clip = new St.Widget({ style_class: 'guava-mc-expose-preview', width: size.width, height: size.height, clip_to_allocation: true });
            clip.add_child(new Clutter.Clone({
                source,
                x: Math.round((buffer.x - frame.x) * scale),
                y: Math.round((buffer.y - frame.y) * scale),
                width: Math.round(source.width * scale),
                height: Math.round(source.height * scale),
            }));
            column.add_child(clip);
            column.add_child(new St.Label({
                style_class: 'guava-mc-expose-title',
                text: win.get_title() || '',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            card.set_child(column);
            c.connect(card, 'clicked', () => Main.activateWindow(win));
            strip.add_child(card);
        }
        if (!strip.get_n_children()) {
            this.hide();
            return;
        }
        Main.layoutManager.overviewGroup.add_child(strip);
        const [, width] = strip.get_preferred_width(-1);
        const [, height] = strip.get_preferred_height(width);
        const w = Math.min(width, monitor.width - 32);
        strip.set_size(w, height);
        strip.set_position(Math.round(monitor.x + (monitor.width - w) / 2),
            Math.round(monitor.y + monitor.height - height - 16));
        this._motion.ease(strip, { opacity: 255 }, { duration: 'medium', curve: 'enter' }, c);
    }

    hide() {
        this._cleanup?.dispose();
        this._cleanup = null;
    }
}
