// SPDX-License-Identifier: GPL-3.0-or-later
// Hot corners (features.js id 'hot-corners'): each screen corner can run a desktop action
// (Mission Control, Application Windows, Desktop, Notification Center, Launchpad, Lock
// Screen, Put Display to Sleep), optionally only while a modifier key is held. macOS ships
// every corner off; so does Guava. GNOME's own top-left corner stays off (shell-behaviour,
// the owner's choice).
//
// Each corner is two Meta.Barriers watched by the Shell's PressureBarrier (js/ui/layout.js,
// GNOME 50; the same parts as GNOME's HotCorner), on every monitor corner the screen really
// ends at (model.js). They are rebuilt when monitors or the settings change; nothing runs
// while the pointer is elsewhere. Actions go through core/desktopActions.js.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

import { DesktopActions } from '../../core/desktopActions.js';
import { normalizeAction } from '../../core/desktopActionsModel.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { GuavaSettings } from '../../lib/settings.js';
import {
    CORNERS, PRESSURE_THRESHOLD, PRESSURE_TIMEOUT, actionKey, atCorner, cornerBarriers,
    modifierKey, shouldFire, wantedCorners,
} from './model.js';

const DIRECTIONS = {
    'positive-x': Meta.BarrierDirection.POSITIVE_X,
    'negative-x': Meta.BarrierDirection.NEGATIVE_X,
    'positive-y': Meta.BarrierDirection.POSITIVE_Y,
    'negative-y': Meta.BarrierDirection.NEGATIVE_Y,
};
const MASKS = {
    shift: Clutter.ModifierType.SHIFT_MASK,
    ctrl: Clutter.ModifierType.CONTROL_MASK,
    alt: Clutter.ModifierType.MOD1_MASK,
    super: Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK,
};

export class HotCorners {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ks = null;
        this._actions = null;
        this._corners = null;   // CleanupRegistry of the built barriers
        this._built = [];       // [{monitor, corner}] (tests and the harness)
    }

    enable() {
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(this._cleanup);
        this._actions = new DesktopActions(this._ctx);
        this._ks.watch(CORNERS.flatMap(c => [actionKey(c), modifierKey(c)]), () => this._rebuild());
        this._cleanup.connect(Main.layoutManager, 'monitors-changed', () => this._rebuild());
        this._cleanup.add(() => this._clear());
        this._rebuild();
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** [{monitor, corner}] of the corners that have barriers now. */
    get corners() {
        return this._built;
    }

    _action(corner) {
        return normalizeAction(this._ks.string(actionKey(corner)));
    }

    _clear() {
        this._corners?.dispose();
        this._corners = null;
        this._built = [];
    }

    _rebuild() {
        this._clear();
        const monitors = Main.layoutManager.monitors;
        const actions = Object.fromEntries(CORNERS.map(c => [c, this._action(c)]));
        const wanted = wantedCorners(monitors, actions);
        if (!wanted.length)
            return;
        const reg = new CleanupRegistry();
        this._corners = reg;
        for (const { monitor, corner } of wanted)
            this._build(reg, monitor, corner);
        this._built = wanted;
    }

    _build(reg, index, corner) {
        const monitor = Main.layoutManager.monitors[index];
        const pressure = new Layout.PressureBarrier(PRESSURE_THRESHOLD, PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        const id = pressure.connect('trigger', () => this.fire(index, corner));
        reg.add(() => {
            pressure.disconnect(id);
            pressure.destroy();
        });
        for (const b of cornerBarriers(monitor, corner)) {
            const barrier = new Meta.Barrier({
                backend: global.backend,
                x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
                directions: DIRECTIONS[b.allow],
            });
            pressure.addBarrier(barrier);
            // Runs before the pressure barrier is destroyed (newest first)
            reg.add(() => {
                pressure.removeBarrier(barrier);
                barrier.destroy();
            });
        }
    }

    /**
     * The pointer pushed into a corner: run its action if its modifier is held.
     *
     * @param {number} index monitor index
     * @param {string} corner
     * @param {{force?: boolean}} [opts] force: skip the pointer and modifier checks (tests)
     * @returns {boolean} true when the action ran
     */
    fire(index, corner, { force = false } = {}) {
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return false;
        const [x, y, mods] = global.get_pointer();
        const held = new Set(Object.keys(MASKS).filter(m => mods & MASKS[m]));
        const action = this._action(corner);
        const ok = force || shouldFire({
            action,
            modifier: this._ks.string(modifierKey(corner)),
            held,
            fullscreen: !!monitor.inFullscreen,
            overview: Main.overview.visible,
            atCorner: atCorner(x, y, monitor, corner),
        });
        return ok && this._actions.run(action, { source: 'corner' });
    }
}
