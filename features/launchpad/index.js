// SPDX-License-Identifier: GPL-3.0-or-later
// Launchpad (macOS 11–15): a full-screen
// glass grid of every app, with pages, search, folders, drag to reorder, keyboard navigation and
// jiggle mode with an ⓧ on the apps their owner can remove.
//
// Ways in, all ending in toggle():
//   - the 'launchpad-requested' event (core/events): the dock's Launchpad tile, the pinch
//     gesture and hot corners emit it with their source
//   - Guava's launchpad-shortcut (default Super+A and F4). Super+A is GNOME's "Show all apps":
//     while Launchpad runs, GNOME's toggle-application-view key loses the accelerators Launchpad
//     uses, through core/originals (crash-safe; the user's value comes back on disable)
//
// Data: store.js (GNOME's app folders and app-picker-layout, so GNOME's grid stays in sync).
// The view (view.js) exists only while Launchpad is open. ⓧ back ends: uninstall.js.

import Gio from 'gi://Gio';

import { SettingOwner } from '../../core/originals.js';
import { Keybindings, MODAL_MODES } from '../../lib/keybindings.js';
import { normalizeAccel } from '../../lib/keybindingsModel.js';
import { ModalSurface } from '../../lib/modalSurface.js';
import { GuavaSettings } from '../../lib/settings.js';
import { freeAccels } from './model.js';
import { LaunchpadStore } from './store.js';
import { UninstallService } from './uninstall.js';
import { LaunchpadView, dropBackdropCache } from './view.js';

const SHELL_KEYS = 'org.gnome.shell.keybindings';
const APP_VIEW_KEY = 'toggle-application-view';

export class Launchpad {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this.view = null;
    }

    enable() {
        const ctx = this._ctx;
        const cleanup = this._cleanup;
        this.motion = ctx.motion;
        this.gettext = s => ctx.gettext(s);
        this._ks = new GuavaSettings(ctx.settings);
        this._ks.attach(cleanup);
        this.store = new LaunchpadStore(cleanup, { gettext: this.gettext, onChanged: () => this.view?.refresh() });
        this.uninstall = new UninstallService(cleanup);

        ctx.events.on('launchpad-requested', () => this.toggle(), cleanup);

        // Super+A: Launchpad's shortcut wins over GNOME's app grid for the accelerators it uses
        const shellKeys = new Gio.Settings({ schema_id: SHELL_KEYS });
        this._appView = new SettingOwner(ctx.originals, shellKeys, APP_VIEW_KEY, {
            type: 'as',
            transform: original => freeAccels(original, this._ks.strv('launchpad-shortcut'), normalizeAccel),
        });
        const syncAppView = () => {
            const original = this._appView.original;
            const free = freeAccels(original, this._ks.strv('launchpad-shortcut'), normalizeAccel);
            this._appView.sync(free.length !== original.length);
            this._appView.reapply();
        };
        this._ks.watch(['launchpad-shortcut'], syncAppView);
        syncAppView();
        cleanup.add(() => this._appView.release());
        // Added after GNOME's binding let go of the same accelerators (removed before it is back)
        Keybindings.add(cleanup, 'launchpad-shortcut', ctx.settings, () => this.toggle(), { modes: MODAL_MODES });

        // Another Guava modal opening closes Launchpad, and Launchpad closes theirs
        cleanup.add(ModalSurface.registerForeign('launchpad', () => this.close({ immediate: true })));
        cleanup.add(() => this.close({ immediate: true }));
        cleanup.add(dropBackdropCache);
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** Jiggle mode shows ⓧ (launchpad-delete-apps). */
    get canDelete() {
        return this._ks.bool('launchpad-delete-apps');
    }

    get isOpen() {
        return !!this.view;
    }

    toggle() {
        if (this.view)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.view)
            return true;
        ModalSurface.closeAll();
        const view = new LaunchpadView(this);
        if (!view.open())
            return false;
        this.view = view;
        return true;
    }

    /** @param {{immediate?: boolean}} [opts] */
    close({ immediate = false } = {}) {
        const view = this.view;
        if (!view)
            return;
        this.view = null;
        if (immediate)
            view.destroy();
        else
            view.close();
    }

    /** Before jiggle mode shows its ⓧ: whether GNOME Software is on the bus. */
    async probeUninstall() {
        await this.uninstall.probe();
    }

    /** The user confirmed the alert: ask the app's owner to remove it. */
    requestUninstall(rule, app) {
        this.uninstall.uninstall(rule).catch(e =>
            console.warn(`[Guava] launchpad: could not ask to remove ${app.get_id()}: ${e.message}`));
    }
}
