// SPDX-License-Identifier: GPL-3.0-or-later
// AppMenuService: the menus of the focused app, for the menu bar now and Spotlight's menu
// search later (P6). It owns the providers, a cache, and command activation.
//
//   const menus = ctx.appMenus.acquire(cleanup);
//   const target = menus.targetFor(metaWindow);      // plain description of the window
//   menus.peek(target);                              // cached provider result, or null
//   await menus.results(target);                     // fetch if missing or stale
//   menus.build(target, results, { generic, accels, _ });   // -> menus (core/appMenus/model.js)
//   menus.activate(target, item.command);
//   menus.registerProvider(cleanup, provider);       // P6: GTK menu bars, DBusMenu, AT-SPI
//   menus.onChanged(cleanup, target => ...);         // a provider saw the app's menus change
//
// Providers: {id, menubar?, supports(target), fetch(target, cancellable, {actions}) ->
// Promise<{actions?, menus?, menubar?}>, activate(target, command) -> Promise<boolean>,
// start?(host), release?(windowId), stop?()}.
//   - Action providers (no `menubar` flag) are asked together; their actions are concatenated
//     and their menus merged into Guava's (core/appMenus/model.js mergeNativeMenus).
//   - Menu bar providers (`menubar: true`: GTK exported menus, DBusMenu, AT-SPI) are asked
//     afterwards, in registration order, with the actions already known; the first that
//     returns a menu bar wins and replaces Guava's File/Edit/View (nativeModel.js applyMenubar).
//   - host.changed(windowId, {structure}) marks a window's result stale and tells onChanged()
//     listeners: structure true when menus came or went (org.gtk.Menus Changed, DBusMenu
//     LayoutUpdated, a window registering its menu), false when only states changed
//     (org.gtk.Actions Changed). release(windowId) runs when the window goes, stop() when the
//     provider is removed or the service stops.
//   - A provider that fails (a timeout, a busy app) leaves the result incomplete: it is shown,
//     but stays stale, so the next menu open asks again.
//
// Cache: one entry per window (its app.* and win.* actions), dropped when the window goes and
// marked stale when it gains focus, so a menu opened later re-reads the app's actions. Nothing
// is fetched while menus are closed, except once for a window never seen before (the menu
// titles depend on what the app exports). Pending calls are cancelled when the last user
// releases the service.
//
// Shell API: Shell.WindowTracker, Meta.Window get_gtk_* (through targetFor()).

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import { CleanupRegistry } from '../../lib/disposables.js';
import { buildMenus, mergeNativeMenus } from './model.js';
import { applyMenubar } from './nativeModel.js';
import { GtkActionsProvider } from './gtkActions.js';
import { GenericCommands } from './commands.js';
import { x11WindowId } from '../../lib/compat.js';

const EMPTY = Object.freeze({
    actions: Object.freeze([]), menus: Object.freeze([]), menubar: Object.freeze([]), complete: true,
});

export class AppMenuService {
    /**
     * @param {{events, desktop, layout}} core the core services
     */
    constructor({ events, desktop, layout }) {
        this._core = { events, desktop, layout };
        this._refs = 0;
        this._cleanup = null;
        this._actions = new GtkActionsProvider();
        this._providers = [this._actions];
        this._cache = new Map(); // windowId -> {value, promise, stale}
        this._cancellable = null;
        this._commands = null;
        this._listeners = new Set();
        this._host = Object.freeze({ changed: (windowId, how) => this._changed(windowId, how) });
    }

    acquire(owner) {
        this._refs++;
        if (this._refs === 1)
            this._start();
        let released = false;
        owner.add(() => {
            if (released)
                return;
            released = true;
            if (--this._refs === 0)
                this._stopTracking();
        });
        return this;
    }

    stop() {
        this._refs = 0;
        this._stopTracking();
    }

    /**
     * Add a provider (asked after the built-in ones) while `owner` lives.
     *
     * @returns {Function} remove it
     */
    registerProvider(owner, provider) {
        this._providers.push(provider);
        this._cache.clear();
        provider.start?.(this._host);
        const remove = () => {
            const i = this._providers.indexOf(provider);
            if (i >= 0) {
                this._providers.splice(i, 1);
                this._cache.clear();
                provider.stop?.();
            }
        };
        owner.add(remove);
        return remove;
    }

    /**
     * Call `fn(windowId, {structure})` while `owner` lives whenever a provider reports that a
     * window's menus changed (its cached result is stale by then).
     */
    onChanged(owner, fn) {
        this._listeners.add(fn);
        owner.add(() => this._listeners.delete(fn));
    }

    /**
     * The plain description of a window every provider reads.
     *
     * @param {?Meta.Window} win null for the desktop (no focused window)
     * @param {?Shell.App} [fallbackApp] the app to describe when there is no window
     * @returns {?object} {windowId, appId, appName, pid, xid, title,
     *   gtk: {busName, appPath, windowPath, menubarPath, appMenuPath}|null}
     */
    targetFor(win, fallbackApp = null) {
        const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : fallbackApp;
        if (!app)
            return null;
        const busName = win?.get_gtk_unique_bus_name?.() ?? null;
        const gtk = busName ? {
            busName,
            appPath: win.get_gtk_application_object_path() || null,
            windowPath: win.get_gtk_window_object_path() || null,
            menubarPath: win.get_gtk_menubar_object_path?.() || null,
            appMenuPath: win.get_gtk_app_menu_object_path?.() || null,
        } : null;
        return {
            windowId: win ? win.get_stable_sequence() : null,
            appId: app.get_id(),
            appName: app.get_name(),
            pid: win ? win.get_pid() : null,
            xid: win ? x11WindowId(win) : null,
            title: win ? win.get_title() ?? '' : '',
            gtk,
        };
    }

    /** @returns {?{actions, menus}} the cached result, without fetching */
    peek(target) {
        return target ? this._cache.get(this._key(target))?.value ?? null : null;
    }

    /** @returns {boolean} true when the cached result should be re-read */
    isStale(target) {
        const entry = target ? this._cache.get(this._key(target)) : null;
        return !entry?.value || entry.stale;
    }

    /**
     * The providers' result for a window: cached, or fetched when missing or stale.
     *
     * @returns {Promise<{actions: object[], menus: object[]}>}
     */
    results(target) {
        if (!target || !this._cleanup)
            return Promise.resolve(EMPTY);
        const key = this._key(target);
        const entry = this._cache.get(key) ?? { value: null, promise: null, stale: true };
        this._cache.set(key, entry);
        if (entry.value && !entry.stale)
            return Promise.resolve(entry.value);
        if (entry.promise)
            return entry.promise;
        const cancellable = this._cancellable;
        entry.promise = this._fetch(target, cancellable).then(value => {
            if (this._cache.get(key) === entry && !cancellable.is_cancelled()) {
                entry.value = value;
                entry.stale = !value.complete;
            }
            entry.promise = null;
            return value;
        });
        return entry.promise;
    }

    /** Forget a window's cached result. */
    invalidate(target) {
        if (target)
            this._cache.delete(this._key(target));
    }

    /**
     * The menus for a window from a provider result (see core/appMenus/model.js buildMenus).
     *
     * @param {object} target
     * @param {?{actions, menus}} results
     * @param {{generic: object, accels: object, _: Function}} opts
     */
    build(target, results, { generic, accels, _ }) {
        const built = buildMenus({
            appName: target.appName, actions: results?.actions ?? [], generic, accels, _,
        });
        return applyMenubar(mergeNativeMenus(built, results?.menus ?? []), results?.menubar ?? []);
    }

    /**
     * Run a menu item's command.
     *
     * @returns {Promise<boolean>} false when it could not run
     */
    async activate(target, command) {
        if (!target || !command || !this._commands)
            return false;
        if (command.provider === 'generic')
            return this._commands.run(command.name, target, command.target);
        const provider = this._providers.find(p => p.id === command.provider);
        return provider ? provider.activate(target, command) : false;
    }

    // ---- internals ----------------------------------------------------------------------

    _key(target) {
        return target.windowId ?? `app:${target.appId}`;
    }

    async _fetch(target, cancellable) {
        let complete = true;
        const ask = (p, known) => p.fetch(target, cancellable, known).catch(e => {
            complete = false;
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`[Guava] app menus: provider ${p.id} failed: ${e.message}`);
            return null;
        });
        const supported = this._providers.filter(p => p.supports(target));
        const parts = await Promise.all(supported.filter(p => !p.menubar).map(p => ask(p, {})));
        const actions = [];
        const menus = [];
        const add = part => {
            for (const a of part?.actions ?? [])
                actions.push(a);
            for (const m of part?.menus ?? [])
                menus.push(m);
        };
        parts.forEach(add);
        // Menu bar providers in order: the first real menu bar wins
        let menubar = [];
        for (const p of supported.filter(x => x.menubar)) {
            if (cancellable.is_cancelled())
                break;
            const part = await ask(p, { actions });
            add(part);
            if (part?.menubar?.length) {
                menubar = part.menubar;
                break;
            }
        }
        return Object.freeze({ actions, menus, menubar, complete });
    }

    _changed(windowId, { structure = true } = {}) {
        const entry = this._cache.get(windowId);
        if (entry)
            entry.stale = true;
        for (const fn of this._listeners)
            fn(windowId, { structure });
    }

    _start() {
        const cleanup = new CleanupRegistry();
        this._cleanup = cleanup;
        const { events, desktop, layout } = this._core;
        desktop.acquire(cleanup);
        layout.acquire(cleanup);
        this._cancellable = new Gio.Cancellable();
        this._commands = new GenericCommands({ events, desktop, layout });
        this._actions.start(this._host);
        events.on('window-removed', ({ window }) => {
            this._cache.delete(window.id);
            for (const p of this._providers)
                p.release?.(window.id);
        }, cleanup);
        events.on('window-focused', ({ window }) => {
            const entry = window ? this._cache.get(window.id) : null;
            if (entry)
                entry.stale = true;
        }, cleanup);
    }

    _stopTracking() {
        if (!this._cleanup)
            return;
        this._cancellable.cancel();
        this._cancellable = null;
        this._commands.stop();
        this._commands = null;
        this._cache.clear();
        const extra = this._providers.filter(p => p !== this._actions);
        this._providers = [this._actions];
        for (const p of extra)
            p.stop?.();
        this._actions.stop();
        const cleanup = this._cleanup;
        this._cleanup = null;
        cleanup.dispose();
    }
}
