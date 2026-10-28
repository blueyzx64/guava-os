// SPDX-License-Identifier: GPL-3.0-or-later
// WindowHider: takes windows off the stage and puts them back, without minimize().
//
// A hidden window keeps running, and keeps its place, size, workspace and stacking. Only its
// actor changes: opacity 0 (not visible = false, so the app keeps getting frame callbacks and
// the strip's clone stays live) and hidden from pick, so the pointer goes through it. The
// WindowState 'staged' flag tells the other features (dock, window controls) why.
//
// The Shell writes opacity 255 at the end of its own map/unminimize effects: a notify::opacity
// guard puts 0 back on a hidden window. restoreAll() returns every actor to how it was found,
// and is the feature's last cleanup step.
//
// Private API: none. Shell.util_set_hidden_from_pick (public, used by windowPreview.js, 48-51).

import Shell from 'gi://Shell';

import { WindowState } from '../../core/windowState.js';

export class WindowHider {
    /** @param {import('../../lib/disposables.js').CleanupRegistry} cleanup */
    constructor(cleanup) {
        this._cleanup = cleanup;
        this._records = new Map();   // Meta.Window -> {opacity, guard, actor}
        cleanup.add(() => this.restoreAll());
    }

    isHidden(win) {
        return this._records.has(win);
    }

    /** Every window hidden now. */
    hiddenWindows() {
        return [...this._records.keys()];
    }

    /** Hide a window's actor (its flight, if any, is the caller's). @returns {boolean} changed */
    hide(win) {
        if (this._records.has(win))
            return false;
        const actor = win.get_compositor_private();
        if (!actor)
            return false;
        // An actor caught mid-fade would restore half transparent: it is shown at 255
        const opacity = actor.get_transition('opacity') || actor.opacity === 0 ? 255 : actor.opacity;
        actor.remove_transition('opacity');
        actor.opacity = 0;
        Shell.util_set_hidden_from_pick(actor, true);
        const rec = { opacity, actor, guard: 0, destroyed: 0 };
        rec.guard = this._cleanup.connect(actor, 'notify::opacity', () => {
            if (actor.opacity !== 0 && !actor.get_transition('opacity'))
                actor.opacity = 0;
        });
        // Mutter can destroy the actor before the window's 'unmanaged' reaches us: drop the
        // record then, so show() never touches a disposed actor
        rec.destroyed = this._cleanup.connect(actor, 'destroy', () => {
            if (this._records.get(win) === rec)
                this.forget(win);
        });
        this._records.set(win, rec);
        WindowState.set(win, 'staged', true);
        return true;
    }

    /**
     * Give a hidden window its actor back.
     * @param {Meta.Window} win
     * @param {{keepTransparent?: boolean}} [opts] a flight shows it when it lands
     * @returns {?number} the opacity the window had (null if it was not hidden)
     */
    show(win, { keepTransparent = false } = {}) {
        const rec = this._records.get(win);
        if (!rec)
            return null;
        this._records.delete(win);
        this._cleanup.release(rec.guard);
        this._cleanup.release(rec.destroyed);
        Shell.util_set_hidden_from_pick(rec.actor, false);
        if (!keepTransparent)
            rec.actor.opacity = rec.opacity;
        WindowState.set(win, 'staged', false);
        return rec.opacity;
    }

    /** A window is going away: drop its record without touching it again. */
    forget(win) {
        const rec = this._records.get(win);
        if (!rec)
            return;
        this._records.delete(win);
        this._cleanup.release(rec.guard);
        this._cleanup.release(rec.destroyed);
        WindowState.set(win, 'staged', false);
    }

    /** Put every window back as found. Sync; safe twice. */
    restoreAll() {
        for (const win of [...this._records.keys()])
            this.show(win);
        WindowState.clearFlag('staged');
    }
}
