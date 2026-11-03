// SPDX-License-Identifier: GPL-3.0-or-later
// A transparent, reactive layer in the stage, sitting right under the notch (and its ears) and
// above the windows. It is up to four boxes around an optional hole (surround(), pure), because
// the hole is where a press must go on to the window below: the shelf helper's window.
// Used for the press-outside catcher (outsideClick.js) and for the input plate that stands in
// for the island while the helper's window is under the shelf (view.js).

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { surround } from './inputRingModel.js';

export class InputRing {
    /**
     * @param {CleanupRegistry} cleanup
     * @param {string} name actor name prefix
     * @param {{press?: Function, release?: Function, touch?: Function, hover?: (on: boolean) => void}} on
     */
    constructor(cleanup, name, on) {
        this._hover = new Set();
        this._boxes = [0, 1, 2, 3].map(i => {
            const box = new St.Widget({ name: `${name}-${i}`, reactive: true, track_hover: true, visible: false });
            if (on.press)
                box.connect('button-press-event', (_a, event) => on.press(event));
            if (on.release)
                box.connect('button-release-event', (_a, event) => on.release(event));
            if (on.touch)
                box.connect('touch-event', (_a, event) => on.touch(event));
            if (on.hover) {
                box.connect('notify::hover', () => {
                    if (box.hover)
                        this._hover.add(box);
                    else
                        this._hover.delete(box);
                    on.hover(this._hover.size > 0);
                });
            }
            Main.layoutManager.uiGroup.add_child(box);
            return box;
        });
        cleanup.add(() => this._boxes.forEach(b => b.destroy()));
    }

    get visible() {
        return this._boxes.some(b => b.visible);
    }

    /** Cover `outer` except `hole` (stage px). */
    place(outer, hole) {
        const rects = surround(outer, hole);
        this._boxes.forEach((box, i) => {
            const r = rects[i];
            if (r)
                box.set({ x: r.x, y: r.y, width: r.w, height: r.h, visible: true });
            else
                box.visible = false;
        });
    }

    hide() {
        this._boxes.forEach(b => {
            b.visible = false;
        });
        this._hover.clear();
    }

    /** Topmost in the group, then `keepAbove` (bottom first) back above it. */
    restack(keepAbove) {
        const group = Main.layoutManager.uiGroup;
        let below = null;
        for (const box of this._boxes) {
            group.set_child_above_sibling(box, below);
            below = box;
        }
        for (const actor of keepAbove) {
            if (actor.get_parent() === group) {
                group.set_child_above_sibling(actor, below);
                below = actor;
            }
        }
    }
}

