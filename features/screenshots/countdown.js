// SPDX-License-Identifier: GPL-3.0-or-later
// The toolbar's Timer: a glass pill in the middle of the primary monitor that counts down
// (5, 4, 3, 2, 1) and then runs the capture. Clicking it cancels.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { Glass } from '../../lib/glass.js';
import { countdown } from './model.js';

export class Countdown {
    /**
     * @param {object} p
     * @param {number} p.seconds
     * @param {?Clutter.Actor} p.parent where the pill goes (null: the Shell's top chrome)
     * @param {(s: string) => string} p._
     * @param {() => void} p.onDone the time is up (the pill is already gone)
     * @param {() => void} p.onCancel the user clicked it
     */
    constructor({ seconds, parent, _, onDone, onCancel }) {
        this._cleanup = new CleanupRegistry();
        const ticks = countdown(seconds);
        this._label = new St.Label({ text: String(ticks[0] ?? ''), style_class: 'guava-screenshot-countdown-number' });
        this._pill = new St.Button({
            style_class: 'guava-screenshot-countdown', accessible_name: _('Cancel the timer'),
            child: this._label, reactive: true,
        });
        // A monitor-sized, non-reactive host centres the pill; only the pill takes clicks
        this._host = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._host.add_constraint(new Layout.MonitorConstraint({ primary: true }));
        this._pill.set({ x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true });
        this._host.add_child(this._pill);
        if (parent)
            parent.add_child(this._host);
        else
            Main.layoutManager.addTopChrome(this._host);
        this._cleanup.actor(this._host);
        this._glass = Glass.attach(this._pill, { surface: 'overlays', role: 'content' });
        this._cleanup.add(() => this._glass.destroy());
        this._cleanup.connect(this._pill, 'clicked', () => {
            this.destroy();
            onCancel();
        });
        let i = 0;
        this._cleanup.timeout(1000, () => {
            i++;
            if (i < ticks.length) {
                this._label.text = String(ticks[i]);
                return GLib.SOURCE_CONTINUE;
            }
            this.destroy();
            onDone();
            return GLib.SOURCE_REMOVE;
        }, { name: 'guava-screenshot-timer' });
    }

    destroy() {
        this._cleanup.dispose();
    }
}
