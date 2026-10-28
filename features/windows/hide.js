// SPDX-License-Identifier: GPL-3.0-or-later
// Hide and Hide Others (macOS ⌘H / ⌥⌘H; feature id 'app-hide', key windows-app-hide).
//
// Wayland has no hidden apps, so this emulates them: the app's windows are minimized without
// the minimize effect (Main.wm.skipNextEffect) and flagged 'hidden' in core/windowState, so
// the dock leaves them out of its minimized area. Activating the app again (dock, switcher,
// focusing any of its windows) brings all of them back at once, as on macOS.
//
// Who asks: the shortcuts here (Super+H, Alt+Super+H), and any feature through the
// 'app-hide-requested' event (the menu bar's App menu: Hide, Hide Others, Show All). After a
// change this announces 'app-hidden'.
//
// GNOME binds Super+H to minimize. While Guava's Hide shortcut uses an accelerator of GNOME's
// minimize binding, Guava takes it out of org.gnome.desktop.wm.keybindings minimize through
// core/originals (saved, given back exactly on disable).
//
// Guava is disabled on every screen lock: the hidden windows simply stay minimized, and which
// app they were hidden for is kept in module state (ids of live windows only) so activating the
// app after unlock still brings them all back.
//
// Shell API: Main.wm.skipNextEffect(actor) (js/ui/windowManager.js), Meta.Window
// minimize/unminimize, global.display.focus_window.

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GuavaSettings } from '../../lib/settings.js';
import { Keybindings } from '../../lib/keybindings.js';
import { normalizeAccel } from '../../lib/keybindingsModel.js';
import { SettingOwner } from '../../core/originals.js';
import { WindowState } from '../../core/windowState.js';

import { HiddenApps, planHide } from './hideModel.js';

const WM_KEYS_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const HIDE_KEY = 'windows-hide-shortcut';
const HIDE_OTHERS_KEY = 'windows-hide-others-shortcut';

// Survives disable (screen lock): [[appId, [window ids]]]
let _saved = [];

export class AppHide {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._hidden = null;
        this._busy = false;
    }

    enable() {
        const { settings, events } = this._ctx;
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(settings);
        ks.attach(cleanup);
        this._desktop = this._ctx.desktop.acquire(cleanup);

        const model = this._desktop.model;
        this._hidden = HiddenApps.from(_saved, id => !!model.window(id)?.minimized);
        _saved = [];
        for (const [, ids] of this._hidden.toJSON()) {
            for (const id of ids) {
                const w = this._desktop.metaWindow(id);
                if (w)
                    WindowState.set(w, 'hidden', true);
            }
        }
        cleanup.add(() => {
            _saved = this._hidden.toJSON();
            WindowState.clearFlag('hidden');
            this._hidden = null;
        });

        // Super+H belongs to GNOME's minimize by default: take the accelerators Guava uses
        const minimize = new SettingOwner(this._ctx.originals,
            new Gio.Settings({ schema_id: WM_KEYS_SCHEMA }), 'minimize', {
                type: 'as',
                transform: original => this._withoutGuavaAccels(original, settings),
            });
        const syncMinimize = () => {
            const original = minimize.original;
            const wanted = this._withoutGuavaAccels(original, settings).length !== original.length;
            if (wanted && minimize.owning)
                minimize.reapply();
            else
                minimize.sync(wanted);
        };
        syncMinimize();
        cleanup.add(() => minimize.release());
        ks.watch([HIDE_KEY, HIDE_OTHERS_KEY], syncMinimize);

        Keybindings.add(cleanup, HIDE_KEY, settings, () => this.hide(this._focusedApp()));
        Keybindings.add(cleanup, HIDE_OTHERS_KEY, settings, () => this.hideOthers(this._focusedApp()));

        events.on('app-hide-requested', ({ appId, mode }) => {
            if (mode === 'hide')
                this.hide(appId);
            else if (mode === 'others')
                this.hideOthers(appId);
            else if (mode === 'all')
                this.showAll();
        }, cleanup);
        // Activating a hidden app brings all its hidden windows back
        events.on('app-focused', ({ appId }) => {
            if (appId && !this._busy && this._hidden?.has(appId))
                this.show(appId);
        }, cleanup);
        events.on('window-changed', ({ window, fields }) => {
            if (this._busy || !fields.includes('minimized') || window.minimized)
                return;
            const appId = this._hidden?.appOf(window.id);
            if (appId)
                this.show(appId);
        }, cleanup);
        events.on('window-removed', ({ window }) => {
            const gone = this._hidden?.forgetWindow(window.id);
            if (gone)
                events.emit('app-hidden', { appId: gone, hidden: false });
        }, cleanup);
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // ---- API ----------------------------------------------------------------------------------

    /** @returns {string[]} the apps Guava hid */
    get hiddenApps() {
        return this._hidden?.apps() ?? [];
    }

    hide(appId) {
        this._apply(planHide('hide', appId, this._desktop.model.windows()));
    }

    hideOthers(appId) {
        this._apply(planHide('others', appId, this._desktop.model.windows()));
    }

    /** Bring a hidden app's windows back (the most recent one ends on top). */
    show(appId) {
        const ids = this._hidden.show(appId);
        if (!ids.length)
            return;
        this._busy = true;
        try {
            for (const id of [...ids].reverse()) {
                const w = this._desktop.metaWindow(id);
                if (!w)
                    continue;
                WindowState.set(w, 'hidden', false);
                if (w.minimized) {
                    this._skipEffect(w);
                    w.unminimize();
                }
            }
            global.display.focus_window?.raise();
        } finally {
            this._busy = false;
        }
        this._ctx.events.emit('app-hidden', { appId, hidden: false });
    }

    showAll() {
        for (const appId of this._hidden.apps())
            this.show(appId);
    }

    // ---- internals ------------------------------------------------------------------------------

    _focusedApp() {
        return this._desktop.model.focusedApp;
    }

    _withoutGuavaAccels(original, settings) {
        const guava = new Set([HIDE_KEY, HIDE_OTHERS_KEY].flatMap(k => settings.get_strv(k)).map(normalizeAccel));
        return original.filter(a => !guava.has(normalizeAccel(a)));
    }

    _skipEffect(win) {
        const actor = win.get_compositor_private();
        if (actor)
            Main.wm.skipNextEffect(actor);
    }

    _apply(plan) {
        if (!plan.size)
            return;
        this._busy = true;
        try {
            for (const [appId, ids] of plan) {
                const done = [];
                for (const id of ids) {
                    const w = this._desktop.metaWindow(id);
                    if (!w?.can_minimize())
                        continue;
                    WindowState.set(w, 'hidden', true);
                    this._skipEffect(w);
                    w.minimize();
                    done.push(id);
                }
                this._hidden.hide(appId, done);
            }
        } finally {
            this._busy = false;
        }
        for (const appId of plan.keys()) {
            if (this._hidden.has(appId))
                this._ctx.events.emit('app-hidden', { appId, hidden: true });
        }
    }
}
