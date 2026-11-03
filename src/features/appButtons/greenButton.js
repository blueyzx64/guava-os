// SPDX-License-Identifier: GPL-3.0-or-later
// The green button (feature id 'green-button', key windows-green-button-fullscreen, on): the
// maximize button of an app's own titlebar enters full screen, as on macOS; on a full-screen
// window it leaves full screen. With move-window-to-new-workspace on, full screen then gets its
// own Space as usual.
//
// The apps draw their buttons, so Guava only sees Mutter's maximized state change. Which changes
// came from the button is decided by greenButtonModel.js: no Clutter event being handled (an
// app's own request), no grab op, a window older than SETTLE_MS, and the pointer on the button
// band of the titlebar. Super+Up, Shell menus (Zoom), Guava's tiling and drags keep maximizing.
// The change is turned around in the notify handler itself, before the app has drawn the
// maximized size: the maximized state goes back to what it was, then full screen toggles.
//
// Shell API: Meta.Window notify::maximized-horizontally / -vertically, is_maximized,
// maximize/unmaximize, make_fullscreen/unmake_fullscreen; Clutter.get_current_event();
// global.display window-created, grab-op-begin/-end; global.get_pointer(). Checked on 50.6.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { isMaximized, maximizeWindow, unmaximizeWindow } from '../../lib/compat.js';
import { WM_SCHEMA } from './buttonLayout.js';
import { buttonBand, greenButtonAction } from './greenButtonModel.js';
import { parseButtonLayout } from './model.js';

export class GreenButton {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._born = new WeakMap();   // Meta.Window -> monotonic µs it was created
        this._state = new Map();      // Meta.Window -> {maximized}
        this._layout = null;
        this._grabbing = false;
        this._acting = false;
    }

    enable() {
        const cleanup = this._cleanup;
        const wm = new Gio.Settings({ schema_id: WM_SCHEMA });
        const readLayout = () => {
            this._layout = parseButtonLayout(wm.get_string('button-layout'));
        };
        readLayout();
        cleanup.connect(wm, 'changed::button-layout', readLayout);

        const display = global.display;
        cleanup.connect(display, 'grab-op-begin', () => {
            this._grabbing = true;
        });
        cleanup.connect(display, 'grab-op-end', () => {
            this._grabbing = false;
        });
        cleanup.connect(display, 'window-created', (_d, win) => {
            this._born.set(win, GLib.get_monotonic_time());
            this._track(win);
        });
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        cleanup.add(() => {
            for (const [win, entry] of this._state) {
                for (const id of entry.ids)
                    win.disconnect(id);
            }
            this._state.clear();
        });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    _track(win) {
        if (!win || this._state.has(win) || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        const entry = { maximized: isMaximized(win), ids: [] };
        const changed = () => this._onChanged(win, entry);
        entry.ids.push(
            win.connect('notify::maximized-horizontally', changed),
            win.connect('notify::maximized-vertically', changed),
            win.connect('unmanaged', () => {
                for (const id of entry.ids)
                    win.disconnect(id);
                this._state.delete(win);
            }));
        this._state.set(win, entry);
    }

    _onChanged(win, entry) {
        const maximized = isMaximized(win);
        const wasMaximized = entry.maximized;
        entry.maximized = maximized;
        if (this._acting || maximized === wasMaximized)
            return;
        const born = this._born.get(win);
        const [x, y] = global.get_pointer();
        const action = greenButtonAction({
            maximized, wasMaximized,
            fullscreen: win.is_fullscreen(),
            hasEvent: Clutter.get_current_event() !== null,
            grabbing: this._grabbing,
            ageMs: born === undefined ? Infinity : (GLib.get_monotonic_time() - born) / 1000,
            pointer: { x, y },
            band: buttonBand(win.get_frame_rect(), this._layout),
        });
        if (!action)
            return;
        this._acting = true;
        try {
            // The maximized state goes back first, so leaving full screen lands where it was
            if (wasMaximized)
                maximizeWindow(win);
            else
                unmaximizeWindow(win);
            entry.maximized = wasMaximized;
            if (action === 'enter')
                win.make_fullscreen();
            else
                win.unmake_fullscreen();
        } catch (e) {
            console.error(`[Guava] green button: ${action} full screen failed for ${win.get_wm_class()}: ${e.message}`);
        } finally {
            this._acting = false;
        }
    }
}
