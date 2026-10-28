// SPDX-License-Identifier: GPL-3.0-or-later
// Rounded window corners (features.js: `cls: RoundedCorners`, key `rounded-corners`, on by
// default). `rounded-corners-which` picks the corners: the top two (default) or all four.
//
// One GuavaRoundedCornersEffect (effect.js) per window actor, added on enable and for every
// window created later (display `window-created`). The effect is disabled, not removed, while
// the window does not qualify (tiled, fullscreen, excluded app; maximized unless the transparent menu bar
// shows its corners); see model.qualifies.
// Geometry follows size-changed; whether a window qualifies follows the maximize, fullscreen,
// type and identity notifies.
// Disable removes every effect and disconnects every signal (per-window owners plus the
// feature's CleanupRegistry). Clones (overview, Stage Manager strip and flights) skip the
// effect on purpose (effect.js): sharp thumbnails matter more than corners at that size.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { GuavaSettings } from '../../lib/settings.js';
import { EFFECT_NAME, effectClass } from './effect.js';
import { clampRadius, cornerMask, frameInActor, qualifies } from './model.js';

const TYPES = new Map([
    [Meta.WindowType.NORMAL, 'normal'],
    [Meta.WindowType.DIALOG, 'dialog'],
    [Meta.WindowType.MODAL_DIALOG, 'modal-dialog'],
]);

// What can change whether a window gets corners. A move never changes the frame inside its
// actor, so position-changed (every frame of a drag) is not watched; a resize only moves the
// corners (size-changed -> geometry only, no re-evaluation).
const WINDOW_SIGNALS = [
    'notify::maximized-horizontally', 'notify::maximized-vertically', 'notify::fullscreen',
    'notify::window-type', 'notify::title', 'notify::wm-class', 'notify::gtk-application-id',
];

const SHELL_PID = new Gio.Credentials().get_unix_pid();

export class RoundedCorners {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._windows = new Map();   // Meta.WindowActor -> {win, effect}
        this._config = { radius: 12, blacklist: [], corners: cornerMask('top'), roundMaximized: true };
        this._Effect = null;
        this._pending = new Map();   // Meta.Window without an actor yet -> stop()
    }

    enable() {
        this._Effect = effectClass();
        if (!this._Effect) {
            console.warn('[Guava] rounded corners need Shell.GLSLEffect (GNOME Shell 48-50)');
            return;
        }
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(this._cleanup);
        const read = () => {
            this._config = {
                radius: clampRadius(ks.int('rounded-corners-radius')),
                blacklist: ks.strv('rounded-corners-blacklist'),
                corners: cornerMask(ks.string('rounded-corners-which')),
                // The transparent menu bar leaves the top corners of a maximized window on show
                roundMaximized: ks.bool('menubar-transparent') && !ks.bool('menubar-solid-on-window'),
            };
        };
        read();
        ks.watch(['rounded-corners-radius', 'rounded-corners-blacklist', 'rounded-corners-which',
            'menubar-transparent', 'menubar-solid-on-window'], () => {
            read();
            this._syncAll();
        });

        this._cleanup.add(() => {
            [...this._pending.values()].forEach(stop => stop());
            this._untrackAll();
        });
        this._cleanup.connect(global.display, 'window-created', (_d, win) => this._onCreated(win));
        for (const actor of global.get_window_actors())
            this._track(actor);
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this
    }

    _onCreated(win) {
        const actor = win.get_compositor_private();
        if (actor) {
            this._track(actor);
            return;
        }
        // Not composited yet: wait for its first frame (or its end)
        if (this._pending.has(win))
            return;
        const done = () => {
            this._pending.delete(win);
            win.disconnectObject(this._pending);
        };
        this._pending.set(win, done);
        win.connectObject('shown', () => {
            done();
            const a = win.get_compositor_private();
            if (a)
                this._track(a);
        }, 'unmanaged', done, this._pending);
    }

    _track(actor) {
        if (this._windows.has(actor))
            return;
        const win = actor.get_meta_window?.() ?? actor.meta_window;
        if (!win)
            return;
        const effect = new this._Effect();
        effect.enabled = false;
        actor.add_effect_with_name(EFFECT_NAME, effect);
        const rec = { win, effect };
        this._windows.set(actor, rec);
        for (const sig of WINDOW_SIGNALS)
            win.connectObject(sig, () => this._sync(actor), rec);
        win.connectObject('size-changed', () => this._syncGeometry(rec), rec);
        actor.connectObject('destroy', () => this._untrack(actor, true), rec);
        this._sync(actor);
    }

    _untrack(actor, destroyed = false) {
        const rec = this._windows.get(actor);
        if (!rec)
            return;
        this._windows.delete(actor);
        rec.win.disconnectObject(rec);
        actor.disconnectObject(rec);
        if (!destroyed)
            actor.remove_effect(rec.effect);
    }

    _untrackAll() {
        for (const actor of [...this._windows.keys()])
            this._untrack(actor);
    }

    _syncAll() {
        for (const actor of this._windows.keys())
            this._sync(actor);
    }

    _info(win) {
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        return {
            type: TYPES.get(win.get_window_type()) ?? 'other',
            overrideRedirect: win.is_override_redirect(),
            maximizedH: win.maximized_horizontally,
            maximizedV: win.maximized_vertically,
            fullscreen: win.is_fullscreen(),
            shellOwned: win.get_pid() === SHELL_PID,
            title: win.get_title(),
            ids: [
                win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id(),
                win.get_sandboxed_app_id(), app?.get_id(),
            ],
        };
    }

    _sync(actor) {
        const rec = this._windows.get(actor);
        if (!rec)
            return;
        const { win, effect } = rec;
        const on = qualifies(this._info(win), this._config);
        if (effect.enabled !== on)
            effect.enabled = on;
        this._syncGeometry(rec);
    }

    // Where the corners go: the frame inside the actor (shadows and CSD margins excluded)
    _syncGeometry({ win, effect }) {
        if (!effect.enabled)
            return;
        // Maximized: the top corners only, whatever the setting, the bottom ones meet the dock
        const corners = win.maximized_horizontally && win.maximized_vertically
            ? cornerMask('top') : this._config.corners;
        effect.setGeometry(frameInActor(win.get_frame_rect(), win.get_buffer_rect()),
            this._config.radius, corners);
    }
}
