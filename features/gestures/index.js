// SPDX-License-Identifier: GPL-3.0-or-later
// Trackpad gestures (features.js id 'gestures'): the macOS defaults on a GNOME touchpad.
//
//   3/4-finger swipe up        Mission Control   GNOME's own overview swipe (shell-behaviour
//                                                clamps it at the window picker)
//   3/4-finger swipe left/right switch Spaces    GNOME's own workspace swipe
//   4-finger swipe down        App Exposé        Guava (core/desktopActions.js)
//   pinch, thumb + 3 fingers   Launchpad         Guava
//   spread, thumb + 3 fingers  Show Desktop      Guava
//
// One router: a 'captured-event::touchpad' handler on the stage sees every touchpad swipe and
// pinch before the Shell's trackers (js/ui/swipeTracker.js, which listen in the bubble phase
// on the same stage) and before apps. It only watches GNOME's swipes, and holds them back
// only when the user turned that gesture off (model.blocksStock), so GNOME's gestures and
// their animations stay GNOME's. The detailed signal means no cost for any other event.
//
// Not possible: macOS opens the Notification Center with a 2-finger swipe in from the right
// edge of the trackpad. Libinput reports no touchpad edge position for gestures, and 2-finger
// motion is scrolling that goes to the app under the pointer (Mutter hands the Shell only
// 3+ finger swipes and pinches). The clock and the hot corners open it instead.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DesktopActions } from '../../core/desktopActions.js';
import { GuavaSettings } from '../../lib/settings.js';
import { GestureTracker, blocksStock, classify, ownsPinch, routeGesture } from './model.js';

const KEYS = {
    missionControl: 'gestures-mission-control',
    spaces: 'gestures-spaces',
    appExpose: 'gestures-app-expose',
    launchpad: 'gestures-launchpad',
    showDesktop: 'gestures-show-desktop',
};
const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export class Gestures {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._config = null;
        this._tracker = new GestureTracker();
        this._blocking = false;
        this._touchpad = null;
        this._actions = null;
    }

    enable() {
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(this._cleanup);
        const read = () => {
            this._config = Object.fromEntries(Object.entries(KEYS).map(([k, key]) => [k, ks.bool(key)]));
        };
        read();
        ks.watch(Object.values(KEYS), read);
        this._touchpad = new Gio.Settings({ schema_id: 'org.gnome.desktop.peripherals.touchpad' });
        this._actions = new DesktopActions(this._ctx);
        this._cleanup.connect(global.stage, 'captured-event::touchpad', (_stage, event) => this.handleEvent(event));
        this._cleanup.add(() => this._tracker.reset());
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** The current gesture settings (tests and the harness). */
    get config() {
        return this._config;
    }

    /**
     * One touchpad event (also the entry point for synthetic events in tests).
     *
     * @param {Clutter.Event} event
     * @returns {boolean} Clutter.EVENT_STOP when Guava keeps it from the Shell and apps
     */
    handleEvent(event) {
        const type = event.type();
        const swipe = type === Clutter.EventType.TOUCHPAD_SWIPE;
        if (!swipe && type !== Clutter.EventType.TOUCHPAD_PINCH)
            return Clutter.EVENT_PROPAGATE;
        const phase = event.get_gesture_phase();
        const fingers = event.get_touchpad_gesture_finger_count();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._blocking = false;
            if (fingers >= 3 && (Main.actionMode & MODES) !== 0)
                this._tracker.begin(swipe ? 'swipe' : 'pinch', fingers);
            else
                this._tracker.reset();
        }
        if (!this._tracker.active)
            return Clutter.EVENT_PROPAGATE;

        const overview = Main.overview.visible;
        const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
        const picked = this._tracker.update(dx, dy, swipe ? 1 : event.get_gesture_pinch_scale());
        const naturalScroll = this._touchpad.get_boolean('natural-scroll');
        if (picked && blocksStock(picked, this._tracker, this._config, { overview, naturalScroll }))
            this._blocking = true;
        const keep = this._blocking || (!swipe && ownsPinch(fingers, this._config))
            ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.END) {
            const sample = this._tracker.finish();
            const gesture = classify(sample, { naturalScroll });
            const action = routeGesture(gesture, sample.fingers, this._config, { overview });
            if (action)
                this._actions.run(action, { source: 'gesture' });
        } else if (phase === Clutter.TouchpadGesturePhase.CANCEL) {
            this._tracker.reset();
        }
        return keep;
    }
}
