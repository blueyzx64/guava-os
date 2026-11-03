// SPDX-License-Identifier: GPL-3.0-or-later
// Shell behaviour tweaks (features.js: `cls: ShellBehaviour`). Two independent parts:
//
//  overview-gestures-workspace-only
//      The overview's vertical swipe (3-finger touchpad swipe, 3-finger touch drag) stops at
//      the workspace overview (WINDOW_PICKER); it no longer goes on into the app grid.
//      ControlsManager.gestureBegin (js/ui/overviewControls.js, GNOME 50) hands the swipe
//      tracker the snap points [HIDDEN, WINDOW_PICKER, APP_GRID] through confirmSwipe(), and
//      the tracker clamps its progress to the outer points. We wrap gestureBegin and drop
//      APP_GRID from those points while the overview is not already in the app grid
//      (model.clampSnapPoints). The overview swipe tracker has no scroll gesture (allowScroll
//      false), so this covers every swipe path. The app grid stays reachable by the dash or
//      Guava Launchpad apps button, Super+A, Main.overview.showApps() and Super+Alt+Up.
//
//  disable-hot-corner
//      No hot corners while Guava runs, without touching the user's
//      org.gnome.desktop.interface enable-hot-corners. LayoutManager._updateHotCorners
//      (js/ui/layout.js) rebuilds the corners on monitor changes; our override only destroys
//      them. Its settings handler was bound to the original method at startup, so we also
//      watch 'hot-corners-changed' and clear any corner it rebuilt. Disable puts the original
//      back and rebuilds the corners from the user's setting.
//      GNOME 50 has no other edge gesture that opens the overview: the old top-edge drag is
//      gone; the only Shell.EdgeDragGesture left is the on-screen keyboard's bottom-edge drag,
//      which we leave alone.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ControlsManager, ControlsState } from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { LayoutManager } from 'resource:///org/gnome/shell/ui/layout.js';

import { clampSnapPoints } from './model.js';

const LOG = '[Guava] shell-behaviour:';

export class ShellBehaviour {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        const { settings } = this._ctx;
        if (settings.get_boolean('overview-gestures-workspace-only'))
            this._clampOverviewGesture();
        if (settings.get_boolean('disable-hot-corner'))
            this._disableHotCorners();
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    _clampOverviewGesture() {
        if (typeof ControlsManager?.prototype?.gestureBegin !== 'function' ||
            ControlsState?.WINDOW_PICKER === undefined) {
            console.warn(`${LOG} ControlsManager.gestureBegin not found; overview swipes are unchanged`);
            return;
        }
        const limit = ControlsState.WINDOW_PICKER;
        this._cleanup.inject(ControlsManager.prototype, 'gestureBegin', function (orig, tracker, ...rest) {
            if (!tracker || typeof tracker.confirmSwipe !== 'function')
                return orig.call(this, tracker, ...rest);
            const hadOwn = Object.prototype.hasOwnProperty.call(tracker, 'confirmSwipe');
            const confirm = tracker.confirmSwipe;
            tracker.confirmSwipe = (distance, points, progress, cancel) =>
                confirm.call(tracker, distance, clampSnapPoints(points, progress, cancel, limit), progress, cancel);
            try {
                return orig.call(this, tracker, ...rest);
            } finally {
                if (hadOwn)
                    tracker.confirmSwipe = confirm;
                else
                    delete tracker.confirmSwipe;
            }
        });
    }

    _disableHotCorners() {
        const lm = Main.layoutManager;
        const proto = LayoutManager?.prototype;
        if (typeof proto?._updateHotCorners !== 'function' || !Array.isArray(lm?.hotCorners)) {
            console.warn(`${LOG} LayoutManager hot corners not found; the hot corner stays`);
            return;
        }
        // Runs last on dispose (the registry unwinds backwards): the original method is back by then
        this._cleanup.add(() => {
            try {
                lm._updateHotCorners();
            } catch (e) {
                console.warn(`${LOG} could not rebuild the hot corners: ${e.message}`);
            }
        });
        this._cleanup.inject(proto, '_updateHotCorners', function () {
            this._destroyHotCorners();
            this.emit('hot-corners-changed');
        });
        // The enable-hot-corners handler calls the original (bound at startup): undo what it builds
        this._cleanup.connect(lm, 'hot-corners-changed', () => {
            if (lm.hotCorners.some(Boolean))
                lm._updateHotCorners();
        });
        lm._updateHotCorners();
    }
}
