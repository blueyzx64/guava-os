// SPDX-License-Identifier: GPL-3.0-or-later
// Show Desktop feature entry (features.js: `cls: ShowDesktop`).
//
// A small top-bar button and a shortcut push every window of the current workspace aside, like
// macOS: each window slides toward the screen edge nearest its centre and a thin sliver stays
// on screen (model.js has the edge choice and the offsets). Only the window actors are
// translated: windows are never moved, resized or minimized, so nothing about them changes and
// a crash leaves them where they were. A second press, clicking a peeking window, focusing or
// opening any window, switching workspace or opening the overview brings them back.
// Desktop icons (DING) are not moved and stay clickable.
//
// Stage Manager: while it runs, the toggle is handed to its `toggleDesktop()` when it has one
// (looked up through ctx.features at use time). Without it, this file's own animation runs and
// leaves windows Stage Manager hid (opacity 0) alone.
//
// Shortcuts (the safe way, nothing written to GNOME's settings):
//   - Guava's own `show-desktop-shortcut` (default Super+D, free in GNOME 50) through
//     lib/keybindings.js (Main.wm.addKeybinding), removed on disable.
//   - GNOME's own `show-desktop` action (org.gnome.desktop.wm.keybindings, empty by default in
//     GNOME; some distributions bind Super+D) gets a custom handler through
//     Main.wm.setCustomKeybindingHandler while this runs, so the user's binding plays Guava's
//     animation. Disable hands the action back to mutter (Meta.keybindings_set_custom_handler
//     with null restores its built-in handler). The user's accelerator is never changed.
//
// Disable is an exact mirror: every touched actor is put back to translation 0 and the opacity
// it had before, even mid-animation.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { skipsTaskbar } from '../../core/windowState.js';
import { PanelLayout } from '../../core/panelLayout.js';
import { watchReducedMotion } from '../../lib/compat.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { Keybindings } from '../../lib/keybindings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { isClick } from '../../lib/clickModel.js';
import { durationFor, focusEnds, isMovable, planReveal, wallpaperClickToggles } from './model.js';

const STOCK_ACTION = 'show-desktop';
// Guava's own icon in icons/: a screen with two windows pushed to its edges
const ICON = 'guava-show-desktop-symbolic';

const TYPE_NAMES = new Map([
    [Meta.WindowType.NORMAL, 'normal'],
    [Meta.WindowType.DIALOG, 'dialog'],
    [Meta.WindowType.MODAL_DIALOG, 'modal-dialog'],
    [Meta.WindowType.UTILITY, 'utility'],
    [Meta.WindowType.DESKTOP, 'desktop'],
    [Meta.WindowType.DOCK, 'dock'],
]);

function facts(win, ws) {
    const actor = win.get_compositor_private();
    return {
        type: TYPE_NAMES.get(win.get_window_type()) ?? 'other',
        minimized: win.minimized,
        skipTaskbar: skipsTaskbar(win),
        onWorkspace: win.located_on_workspace(ws),
        visible: !!actor?.visible,
        opacity: actor?.opacity ?? 0,
    };
}

export class ShowDesktop {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ = s => ctx.gettext(s);
        this._ks = null;
        this._button = null;
        this._buttonCleanup = null;
        this._session = null;       // signals that end Show Desktop, live while shown
        this._touched = new Map();  // actor -> {opacity, destroyId}: everything we moved
        this._shown = false;
        this._prevFocus = null;
        this._reduced = false;
        this._press = null;         // a primary press on the wallpaper, waiting for its release
    }

    enable() {
        const cleanup = this._cleanup;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        watchReducedMotion(cleanup, r => {
            this._reduced = r;
        });

        this._ks.watch('show-desktop-button', () => this._syncButton());
        this._syncButton();
        cleanup.add(() => this._removeButton());

        if (this._ks.strv('show-desktop-shortcut').length > 0)
            Keybindings.add(cleanup, 'show-desktop-shortcut', this._ctx.settings, () => this.toggle());

        Main.wm.setCustomKeybindingHandler(STOCK_ACTION, Shell.ActionMode.NORMAL, () => this.toggle());
        cleanup.add(() => Meta.keybindings_set_custom_handler(STOCK_ACTION, null));

        // Click wallpaper to reveal desktop (macOS Sonoma). Only a press and release that both
        // reach the wallpaper itself (Meta.BackgroundActor) count: desktop icons (DING) draw in
        // their own window over it, so a click on them, or between them, is theirs.
        cleanup.connect(global.stage, 'captured-event', (_s, event) => this._wallpaperEvent(event));

        // Newest first: windows go back before anything else is torn down
        cleanup.add(() => this._snapBack());
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** True while the desktop is shown by Guava's own animation. */
    get shown() {
        return this._shown;
    }

    /** Show the desktop, or bring the windows back. Stage Manager handles it while it runs. */
    toggle() {
        const stage = this._ctx.features?.instance?.('stage-manager');
        if (typeof stage?.toggleDesktop === 'function') {
            try {
                stage.toggleDesktop();
                this._syncChecked();
                return;
            } catch (e) {
                console.error('[Guava] Stage Manager toggleDesktop failed, using Show Desktop:', e);
            }
        }
        if (this._shown)
            this.restore();
        else
            this.reveal();
    }

    _wallpaperEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const onWallpaper = event.get_button() === Clutter.BUTTON_PRIMARY &&
            global.stage.get_event_actor(event) instanceof Meta.BackgroundActor;
        const [x, y] = event.get_coords();
        const point = { x, y, time: event.get_time() };
        if (type === Clutter.EventType.BUTTON_PRESS) {
            this._press = onWallpaper ? point : null;
            return Clutter.EVENT_PROPAGATE;
        }
        const press = this._press;
        this._press = null;
        if (!onWallpaper || !isClick(press, point))
            return Clutter.EVENT_PROPAGATE;
        const stage = this._ctx.features?.instance?.('stage-manager');
        const toggles = wallpaperClickToggles({
            mode: this._ks.string('click-wallpaper-reveals-desktop'),
            stageActive: !!stage,
            stageHandles: !!stage && this._ks.bool('stage-manager-wallpaper-click'),
            blocked: Main.overview.visible || Main.modalCount > 0,
        });
        // After the release is delivered (the background menu and DND see a normal click)
        if (toggles)
            this._cleanup.idle(() => this.toggle(), { name: 'show-desktop-wallpaper' });
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- motion --------------------------------------------------------------

    _duration() {
        return durationFor(this._ks.string('show-desktop-speed'));
    }

    _motion() {
        return St.Settings.get().enable_animations;
    }

    /** Ease `actor` to translation (x, y). Reduced motion: fade out, jump, fade in. */
    _move(actor, x, y, done) {
        const rec = this._touched.get(actor);
        const ms = this._motion() ? this._duration() : 0;
        if (this._reduced && ms > 0) {
            actor.ease({
                opacity: 0,
                duration: ms / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    actor.set_translation(x, y, 0);
                    actor.ease({
                        opacity: rec?.opacity ?? 255,
                        duration: ms / 2,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: done,
                    });
                },
            });
            return;
        }
        actor.ease({
            translation_x: x,
            translation_y: y,
            duration: ms,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: done,
        });
    }

    _track(actor) {
        if (this._touched.has(actor))
            return;
        const destroyId = actor.connect('destroy', () => this._touched.delete(actor));
        this._touched.set(actor, { opacity: actor.opacity, destroyId });
    }

    _untrack(actor) {
        const rec = this._touched.get(actor);
        if (!rec)
            return;
        this._touched.delete(actor);
        actor.disconnect(rec.destroyId);
    }

    // ---- reveal / restore ----------------------------------------------------

    reveal() {
        if (this._shown)
            return;
        if (Main.overview.visible) {
            // From the overview: close it first, then reveal once it is gone
            const token = this._cleanup.connect(Main.overview, 'hidden', () => {
                this._cleanup.release(token);
                this.reveal();
            });
            Main.overview.hide();
            return;
        }
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => w && isMovable(facts(w, ws)));
        if (!wins.length)
            return;

        const plans = planReveal(wins.map(w => ({
            id: w,
            parentId: w.get_transient_for() ?? null,
            frame: w.get_frame_rect(),
            area: ws.get_work_area_for_monitor(w.get_monitor()),
        })));

        this._shown = true;
        this._prevFocus = global.display.focus_window;
        for (const w of wins) {
            const actor = w.get_compositor_private();
            const plan = plans.get(w);
            this._track(actor);
            this._move(actor, plan.x, plan.y, null);
        }
        this._watchSession(ws);
        // Keystrokes must not land in a window the user can no longer see. Clicking a sliver
        // or the desktop icons gives focus back, and focusing a real window ends Show Desktop.
        global.display.unset_input_focus(global.get_current_time());
        this._syncChecked();
    }

    /**
     * @param {{instant?: boolean, refocus?: boolean}} [opts] instant for a workspace switch or
     *   the overview; refocus gives the focus back to the window that had it (button, shortcut)
     */
    restore({ instant = false, refocus = true } = {}) {
        if (!this._shown)
            return;
        this._shown = false;
        this._session?.dispose();
        this._session = null;

        for (const actor of [...this._touched.keys()]) {
            if (instant) {
                this._reset(actor);
                continue;
            }
            this._move(actor, 0, 0, () => {
                // A new reveal may have started meanwhile; it owns the actor again then
                if (!this._shown)
                    this._reset(actor);
            });
        }

        const prev = this._prevFocus;
        this._prevFocus = null;
        if (refocus && prev && !global.display.focus_window && prev.get_compositor_private())
            prev.activate(global.get_current_time());
        this._syncChecked();
    }

    _reset(actor) {
        const rec = this._touched.get(actor);
        if (!rec)
            return;
        actor.remove_transition('translation-x');
        actor.remove_transition('translation-y');
        actor.remove_transition('opacity');
        actor.set_translation(0, 0, 0);
        actor.opacity = rec.opacity;
        this._untrack(actor);
    }

    _watchSession(ws) {
        const s = new CleanupRegistry();
        this._session = s;
        s.connect(global.display, 'notify::focus-window', () => {
            const w = global.display.focus_window;
            if (w && focusEnds(facts(w, ws)))
                this.restore({ refocus: false });
        });
        s.connect(global.display, 'window-created', () => this.restore({ refocus: false }));
        s.connect(global.workspace_manager, 'active-workspace-changed',
            () => this.restore({ instant: true, refocus: false }));
        s.connect(Main.overview, 'showing', () => this.restore({ instant: true, refocus: false }));
    }

    /** Disable: everything back at once, mid-animation included. */
    _snapBack() {
        this._shown = false;
        this._session?.dispose();
        this._session = null;
        this._prevFocus = null;
        for (const actor of [...this._touched.keys()])
            this._reset(actor);
    }

    // ---- top-bar button ------------------------------------------------------

    _syncButton() {
        const want = this._ks.bool('show-desktop-button');
        if (want && !this._button)
            this._addButton();
        else if (!want && this._button)
            this._removeButton();
    }

    _addButton() {
        const reg = new CleanupRegistry();
        const button = new PanelMenu.Button(0.5, this._('Show Desktop'), true);
        reg.actor(button);
        button.add_style_class_name('guava-show-desktop');
        const file = this._ctx.extension?.dir?.get_child('icons').get_child(`${ICON}.svg`);
        button.add_child(new St.Icon({
            gicon: file ? new Gio.FileIcon({ file }) : null,
            fallback_icon_name: 'user-desktop-symbolic',
            style_class: 'system-status-icon',
        }));
        reg.connect(button, 'button-press-event', () => {
            this.toggle();
            return Clutter.EVENT_STOP;
        });
        reg.connect(button, 'touch-event', (_a, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this.toggle();
            return Clutter.EVENT_STOP;
        });
        reg.connect(button, 'key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            if (sym !== Clutter.KEY_Return && sym !== Clutter.KEY_KP_Enter && sym !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;
            this.toggle();
            return Clutter.EVENT_STOP;
        });
        // Stage Manager's desktop also ends by a focus change (a strip click, a new window) or a
        // workspace switch: follow it so the button is checked exactly while the desktop shows
        // (a moment later: Stage Manager settles its state in an idle)
        let pending = 0;
        const later = () => {
            if (!pending) {
                pending = reg.timeout(60, () => {
                    pending = 0;
                    this._syncChecked();
                    return false;
                }, { name: 'show-desktop-checked' });
            }
        };
        reg.connect(global.display, 'notify::focus-window', later);
        reg.connect(global.workspace_manager, 'active-workspace-changed', later);
        Main.panel.addToStatusArea('guava-show-desktop', button, 0, 'right');
        PanelLayout.claim(reg, {
            id: 'show-desktop', actor: button.container, box: 'right',
            anchor: { before: ['clipboard', 'quickSettings'], fallback: 'last' },
        });
        this._buttonCleanup = reg;
        this._button = button;
        this._syncChecked();
    }

    _removeButton() {
        this._buttonCleanup?.dispose();
        this._buttonCleanup = null;
        this._button = null;
    }

    /** Is the desktop shown, by this feature or by Stage Manager? */
    _desktopShown() {
        if (this._shown)
            return true;
        try {
            return !!this._ctx.features?.instance?.('stage-manager')?.isDesktopShown;
        } catch (_e) {
            return false;
        }
    }

    _syncChecked() {
        if (!this._button)
            return;
        if (this._desktopShown())
            this._button.add_style_pseudo_class('checked');
        else
            this._button.remove_style_pseudo_class('checked');
    }
}
