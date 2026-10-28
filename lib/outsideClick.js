// SPDX-License-Identifier: GPL-3.0-or-later
// A press anywhere outside an open popup (the notch, the widget gallery): on a window, the
// wallpaper, the top bar or the dock. Shared by the popups that are not modal; a popup that
// holds a modal grab sees the press itself and calls replayClick() after closing.
//
// Why a catcher. The stage's 'captured-event' never sees a press that lands on a Wayland client
// window (mutter's event filter hands it to the client first), and a press on the window that
// already has the focus changes no focus either, so neither stage events nor
// 'notify::focus-window' catch every case. A modal grab would catch all of them, but it also
// swallows the click. So while the popup is open a transparent, reactive layer covers the
// whole stage right under it. It sees every press and tells the notch to
// close at once. On the release it steps aside and replays the whole click (press and
// release) through a virtual pointer, so the click still reaches whatever was under it. (Both
// halves come from one device; replaying only the press would leave that device's button down.)
//
// While the shelf helper's window is under the shelf, the layer leaves a hole over the dashboard
// so that presses there go on to that window. Touch presses only collapse: a touch cannot be
// replayed as a pointer press.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { InputRing } from './inputRing.js';

/**
 * Press and release `button` at the pointer through a virtual pointer, so a click that closed a
 * popup still reaches what lies under it. Both halves come from one device: replaying only the
 * press would leave that device's button down. The popup's layer must be gone (hidden or
 * destroyed) when this runs, so the click is picked on what lies below.
 * @param {number} button Clutter button
 */
export function replayClick(button) {
    const pointer = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    // After the layer's teardown has reached the screen, so the pointer is over what lies below
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        // A motion to where the pointer already is makes mutter find the surface under it first
        const [x, y] = global.get_pointer();
        const now = GLib.get_monotonic_time();
        pointer.notify_absolute_motion(now, x, y);
        pointer.notify_button(now + 1000, button, Clutter.ButtonState.PRESSED);
        pointer.notify_button(now + 2000, button, Clutter.ButtonState.RELEASED);
        return GLib.SOURCE_REMOVE;
    });
}

export class OutsideClick {
    /**
     * @param {CleanupRegistry} cleanup
     * @param {string} name actor name prefix
     * @param {Clutter.Actor[]} keepAbove actors that stay above the layer, bottom first
     * @param {() => void} onOutside a press landed outside; close
     */
    constructor(cleanup, name, keepAbove, onOutside) {
        this._keepAbove = keepAbove;
        this._onOutside = onOutside;
        this._held = 0;      // the button pressed on the layer, until its release
        this._ring = new InputRing(cleanup, name, {
            press: event => this._press(event),
            release: () => this._release(),
            touch: event => {
                if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;
                this._onOutside();
                return Clutter.EVENT_STOP;
            },
        });
    }

    /**
     * Cover the stage, leaving `hole` (stage px, or null) to what is below.
     * @param {{x: number, y: number, w: number, h: number}|null} hole
     * @param {Clutter.Actor[]} [keepAbove] replaces the constructor's list for this cover
     */
    start(hole = null, keepAbove = this._keepAbove) {
        const [w, h] = global.stage.get_size();
        this._ring.place({ x: 0, y: 0, w, h }, hole);
        this._ring.restack(keepAbove);
    }

    stop() {
        // Not while a press waits for its release: that release must find the layer
        if (!this._held)
            this._ring.hide();
    }

    _press(event) {
        this._held = event.get_button();
        this._onOutside();
        return Clutter.EVENT_STOP;
    }

    _release() {
        const button = this._held;
        this._held = 0;
        if (!button)
            return Clutter.EVENT_PROPAGATE;
        // The layer is hidden, so the replayed click is picked on what lies under the pointer
        this._ring.hide();
        replayClick(button);
        return Clutter.EVENT_STOP;
    }
}
