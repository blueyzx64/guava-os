// SPDX-License-Identifier: GPL-3.0-or-later
// WindowState: the one place that records WHY a window is not in its normal place.
//
// Stage Manager, fullscreen Spaces, tiling and the dock all move or hide windows. Instead of
// each feature guessing what the others did, each one sets a flag here and every feature
// reads the flags of the others before it acts.
//
//   staged              Stage Manager put it off the stage (hidden, or minimized by Guava)
//   isolatedFullscreen  reserved: a full-screen window in its own Space (phase 3)
//   tiled               the tiling engine (features/windows) holds a tile and a restore rect
//   parkedInDock        reserved: the dock owns its minimize (phase 1)
//   splitView           one of a full-screen Split View pair (features/splitView): it left
//                       full screen on purpose and stays in that Space
//   guavaHelper          the window of a Guava helper process (the notch shelf's drag-out window):
//                       not a user window, so it counts as skip-taskbar everywhere (skipsTaskbar)
//   hidden              Hide / Hide Others (features/windows/hide.js) minimized it without
//                       effect; the dock should not show it among minimized windows
//
//   import { WindowState } from '../../core/windowState.js';
//   WindowState.set(win, 'staged', true);          // true if the flag changed
//   WindowState.has(win, 'staged');
//   WindowState.watch(cleanup, (win, flag, on) => ...);
//
// Rules for consumers (the policy; the registry only stores):
//   - the window controls ask WindowState.interceptMinimize(win) before win.minimize(), so
//     Stage Manager can send the window to its strip instead.
//   - fullscreen Spaces are paused by the feature registry (Stage Manager's conflictsWith),
//     not by checking the flag; stageActive is for new code.
//
// No gi imports: runs under `gjs -m` in tests. A window is any object; if it has
// connect/disconnect, its flags are dropped on 'unmanaged' by track().

export const FLAGS = Object.freeze(['staged', 'isolatedFullscreen', 'tiled', 'parkedInDock', 'splitView', 'hidden', 'guavaHelper']);

export class WindowStateRegistry {
    constructor() {
        this._flags = new Map();      // window -> Set<flag>
        this._unmanaged = new Map();  // window -> signal id
        this._listeners = new Set();
        this._stageActive = false;
        this._interceptor = null;
    }

    /** Set or clear a flag. Returns true when it changed. */
    set(win, flag, on = true) {
        if (!win)
            return false;
        if (!FLAGS.includes(flag))
            throw new Error(`WindowState: unknown flag "${flag}"`);
        let set = this._flags.get(win);
        const had = set?.has(flag) ?? false;
        if (had === !!on)
            return false;
        if (on) {
            if (!set) {
                set = new Set();
                this._flags.set(win, set);
                this._track(win);
            }
            set.add(flag);
        } else {
            set.delete(flag);
            if (set.size === 0)
                this._forget(win);
        }
        if (flag === 'staged')
            this._mirrorStaged(win, !!on);
        this._emit(win, flag, !!on);
        return true;
    }

    has(win, flag) {
        return this._flags.get(win)?.has(flag) ?? false;
    }

    /** Flags of one window, in FLAGS order. */
    flags(win) {
        const set = this._flags.get(win);
        return set ? FLAGS.filter(f => set.has(f)) : [];
    }

    /** Every window that carries the flag (insertion order). */
    list(flag) {
        const out = [];
        for (const [win, set] of this._flags) {
            if (set.has(flag))
                out.push(win);
        }
        return out;
    }

    /** Drop every flag of one window (call when it goes away). */
    clear(win) {
        const set = this._flags.get(win);
        if (!set)
            return;
        for (const flag of FLAGS) {
            if (set.has(flag))
                this.set(win, flag, false);
        }
    }

    /** Clear one flag on every window that has it. A feature calls this in disable(). */
    clearFlag(flag) {
        for (const win of this.list(flag))
            this.set(win, flag, false);
    }

    // ---- Stage Manager on/off -----------------------------------------------------------

    /** True while Stage Manager owns window placement. */
    get stageActive() {
        return this._stageActive;
    }

    setStageActive(on) {
        on = !!on;
        if (on === this._stageActive)
            return;
        this._stageActive = on;
        this._emit(null, 'stageActive', on);
    }

    // ---- minimize hook ------------------------------------------------------------------

    /**
     * Stage Manager registers a function(win) -> bool here. A caller that is about to minimize
     * a window on the user's behalf (the panel window controls) asks interceptMinimize(win) first
     * and skips win.minimize() when it returns true. Pass null to remove it.
     */
    setMinimizeInterceptor(fn) {
        this._interceptor = typeof fn === 'function' ? fn : null;
    }

    /** True when Stage Manager took over this minimize (the window went to the strip). */
    interceptMinimize(win) {
        if (!this._interceptor || !this._stageActive)
            return false;
        try {
            return !!this._interceptor(win);
        } catch (e) {
            console.error(`[Guava] windowState minimize interceptor: ${e.message}`);
            return false;
        }
    }

    // ---- change signal ------------------------------------------------------------------

    /**
     * fn(win, flag, on) runs after every change. For setStageActive: (null, 'stageActive', on).
     * `owner` is a CleanupRegistry (the callback is removed on dispose) or omitted.
     * @returns {Function} call it to stop watching
     */
    watch(owner, fn) {
        if (typeof owner === 'function') {
            fn = owner;
            owner = null;
        }
        this._listeners.add(fn);
        const stop = () => this._listeners.delete(fn);
        owner?.add(stop);
        return stop;
    }

    /** Drop everything (tests, extension teardown). Flags are cleared with change signals. */
    reset() {
        for (const win of [...this._flags.keys()])
            this.clear(win);
        this.setStageActive(false);
        this._interceptor = null;
    }

    // ---- internals ----------------------------------------------------------------------

    _emit(win, flag, on) {
        for (const fn of [...this._listeners]) {
            try {
                fn(win, flag, on);
            } catch (e) {
                console.error(`[Guava] windowState listener: ${e.message}`);
            }
        }
    }

    // Spec fallback: modules that cannot import the registry can read win._guavaStaged.
    _mirrorStaged(win, on) {
        try {
            if (on)
                win._guavaStaged = true;
            else
                delete win._guavaStaged;
        } catch (_e) {
            // frozen or destroyed object: the registry stays the source of truth
        }
    }

    _track(win) {
        if (typeof win.connect !== 'function' || this._unmanaged.has(win))
            return;
        try {
            this._unmanaged.set(win, win.connect('unmanaged', () => this.clear(win)));
        } catch (_e) {
            // not a GObject with that signal
        }
    }

    _forget(win) {
        this._flags.delete(win);
        const id = this._unmanaged.get(win);
        this._unmanaged.delete(win);
        if (id !== undefined && typeof win.disconnect === 'function') {
            try {
                win.disconnect(id);
            } catch (_e) {
                // window already gone
            }
        }
    }
}

export const WindowState = new WindowStateRegistry();

/** True for a window the taskbar, dock, switchers and Stage Manager must not list: Mutter's skip-taskbar, or a Guava helper's window. */
export const skipsTaskbar = win => !!win && (!!win.skip_taskbar || WindowState.has(win, 'guavaHelper'));
