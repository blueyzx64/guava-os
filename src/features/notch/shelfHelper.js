// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the shelf drag-out helper (helpers/guava-shelf-helper, a separate package) while the
// shelf is open. A Shell extension cannot start a Wayland drag, so the helper owns a transparent
// window that this class moves exactly over the shelf's items; the user's press lands on it and
// starts a real drag with text/uri-list. See shelfHelperModel.js for the protocol and
// docs/features/notch.md.
//
// Without the helper installed everything stays as before (Open, Copy, ...): available is false.
// The helper's life follows the shelf: show() starts it, hide() and the cleanup stop it, and its
// stdin closing makes it quit by itself, so no window is ever left covering anything.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { WindowState } from '../../core/windowState.js';
import { HELPER, CLEAR_LINE, isHelperWindow, layoutOf, parseEvent, pointerOnNotch } from './shelfHelperModel.js';

export class ShelfHelper {
    /**
     * @param {CleanupRegistry} cleanup
     * @param {{onClick: (uri: string) => void, onHover: (on: boolean) => void,
     *   onDrag: (on: boolean) => void, onActive: (on: boolean) => void}} handlers
     *   onHover: the pointer is on the helper's window or a drag from it is running
     *   onDrag: a drag from the shelf started or ended
     *   onActive: the window is in place over the items (true) or gone (false)
     */
    constructor(cleanup, handlers) {
        this._h = handlers;
        this._proc = null;
        this._stdin = null;
        this._cancellable = null;
        this._frame = null;        // where the window goes {x, y, w, h}
        this._pending = null;      // the layout line waiting for the process to be ready
        this._windows = [];        // signal ids on global.display while running
        this._state = { helper: false, dragging: false };
        this._last = false;
        this._active = false;
        this._prevFocus = null;    // the window that had the focus before the helper took it
        this._alive = true;
        cleanup.add(() => {
            this._alive = false;
            this._stop();
        });
    }

    /** Is the helper installed? Checked on every call, so installing it needs no restart. */
    get available() {
        return GLib.find_program_in_path(HELPER.command) !== null;
    }

    get running() {
        return !!this._proc;
    }

    /** @returns {boolean} true if the window belongs to the helper */
    isHelperWindow(window) {
        return !!window && (WindowState.has(window, 'guavaHelper') ||
            isHelperWindow(window.get_wm_class?.(), window.get_title?.()));
    }

    // The helper's own window: by the process id (known at once), else by class and title
    _isMine(window) {
        const pid = this._proc ? Number(this._proc.get_identifier()) : 0;
        return (pid > 0 && window.get_pid() === pid) || this.isHelperWindow(window);
    }

    /**
     * Put the helper's window over these items (stage px), starting the helper if needed.
     * @param {{x: number, y: number, w: number, h: number}} box
     * @param {Array<{uri: string, icon: string, x: number, y: number, w: number, h: number}>} tiles
     */
    show(box, tiles) {
        if (!this._alive || !this.available || !tiles.length) {
            this.hide();
            return;
        }
        const { box: frame, line } = layoutOf(box, tiles);
        this._frame = frame;
        if (!this._proc && !this._start())
            return;
        this._send(line);
        this._placeAll();
    }

    /** Close the window and stop the helper. */
    hide() {
        this._stop();
    }

    _start() {
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            launcher.setenv('GDK_BACKEND', 'wayland', true);
            this._proc = launcher.spawnv([HELPER.command]);
        } catch (e) {
            console.error('[Guava] shelf helper did not start:', e.message);
            this._proc = null;
            return false;
        }
        const proc = this._proc;
        this._cancellable = new Gio.Cancellable();
        this._stdin = proc.get_stdin_pipe();
        this._read(new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() }), proc);
        proc.wait_async(this._cancellable, () => {
            if (this._proc === proc)
                this._stop();
        });
        // The window is placed as soon as it exists; mutter puts a new window somewhere first
        const display = global.display;
        this._prevFocus = display.focus_window;
        this._windows = [
            display.connect('window-created', (_d, window) => this._onWindow(window)),
            display.connect('notify::focus-window', () => this._onFocus()),
        ];
        return true;
    }

    _read(stream, proc) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (_e) {
                return;
            }
            if (line === null || this._proc !== proc)
                return;
            this._event(parseEvent(line));
            this._read(s, proc);
        });
    }

    _event(ev) {
        if (!ev)
            return;
        if (ev.event === 'click') {
            this._h.onClick(ev.uri);
        } else if (ev.event === 'hover') {
            this._state.helper = ev.value;
            this._reportHover();
        } else if (ev.event === 'drag') {
            this._state.dragging = ev.state === 'begin';
            this._h.onDrag(this._state.dragging);
            this._reportHover();
        }
    }

    _reportHover() {
        const on = pointerOnNotch(this._state);
        if (on === this._last)
            return;
        this._last = on;
        this._h.onHover(on);
    }

    _send(line) {
        try {
            this._stdin?.write_all(`${line}\n`, null);
        } catch (e) {
            console.error('[Guava] shelf helper is gone:', e.message);
            this._stop();
        }
    }

    _onWindow(window) {
        if (!this._frame || !this._isMine(window))
            return;
        // Not a user window for any Guava feature (dock, Stage Manager, switchers) from now on
        WindowState.set(window, 'guavaHelper', true);
        this._place(window);
        const check = () => this._check(window);
        window.connect('shown', () => this._place(window));
        window.connect('position-changed', check);
        window.connect('size-changed', check);
    }

    // A press on the helper's window focuses it. It is not an app: the focus goes back.
    _onFocus() {
        const focused = global.display.focus_window;
        if (!focused || !this.isHelperWindow(focused)) {
            this._prevFocus = focused;
            return;
        }
        const prev = this._prevFocus;
        if (prev?.get_compositor_private() && !prev.minimized)
            prev.activate(global.get_current_time());
        else
            global.display.unset_input_focus(global.get_current_time());
    }

    _placeAll() {
        for (const actor of global.get_window_actors()) {
            if (this._isMine(actor.meta_window)) {
                WindowState.set(actor.meta_window, 'guavaHelper', true);
                this._place(actor.meta_window);
            }
        }
    }

    _place(window) {
        const f = this._frame;
        if (!f || !this.isHelperWindow(window))
            return;
        window.make_above();
        window.stick();
        // Invisible, but still picked: a press on it reaches the helper
        const actor = window.get_compositor_private();
        if (actor)
            actor.opacity = 0;
        window.move_resize_frame(false, f.x, f.y, f.w, f.h);
        this._check(window);
    }

    // Active once the window is mapped exactly over the items; presses on them go to it then
    _check(window) {
        const f = this._frame;
        const r = window.get_frame_rect();
        const mapped = !!window.get_compositor_private()?.mapped;
        const placed = !!f && mapped && r.x === f.x && r.y === f.y && r.width === f.w && r.height === f.h;
        if (placed === this._active || !this.isHelperWindow(window))
            return;
        this._active = placed;
        this._h.onActive(placed);
    }

    _stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const id of this._windows)
            global.display.disconnect(id);
        this._windows = [];
        WindowState.clearFlag('guavaHelper');
        const proc = this._proc;
        this._proc = null;
        if (proc) {
            // Close the window, then the pipe; the helper quits on EOF. Force it if it does not.
            try {
                this._stdin?.write_all(`${CLEAR_LINE}\n`, null);
                this._stdin?.close(null);
            } catch (_e) {
                // already gone
            }
            proc.force_exit();
        }
        this._stdin = null;
        this._frame = null;
        this._prevFocus = null;
        if (this._active) {
            this._active = false;
            this._h.onActive(false);
        }
        if (this._state.dragging)
            this._h.onDrag(false);
        this._state = { helper: false, dragging: false };
        if (this._last) {
            this._last = false;
            this._h.onHover(false);
        }
    }
}
