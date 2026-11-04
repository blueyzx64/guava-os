// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
// Guava OS: the macOS desktop on GNOME Shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { CleanupRegistry } from './lib/disposables.js';
import { FeatureRegistry, isLater } from './lib/featureRegistry.js';
import { SurfaceLedger, sweepTargets } from './lib/lockModel.js';
import { Glass } from './lib/glass.js';
import { IconStyle } from './lib/iconStyle.js';
import { EventHub } from './core/events.js';
import { DebugLog } from './core/debugLog.js';
import { DesktopService } from './core/desktop.js';
import { LayoutService } from './core/layout.js';
import { Motion } from './core/motion.js';
import { TimerService } from './core/timers.js';
import { AppMenuService } from './core/appMenus/service.js';
import { OsdRouter } from './core/osd.js';
import { OriginalsStore, STORE_BACKUP_KEY, STORE_KEY, restoreStale } from './core/originals.js';
import { FEATURES } from './features.js';

// Keys Guava writes itself at run time. No `when` or restartOn reads them, and a write made
// during a refresh would re-enter the registry, so they do not trigger a pass.
const KEYS_THAT_NEVER_AFFECT_FEATURES = new Set(['clipboard-recording', STORE_KEY,
    STORE_BACKUP_KEY, 'dock-recent-apps', 'screenshots-last-selection', 'emoji-recents', 'emoji-skin-tone',
    'timers-state', 'notch-shelf', 'widgets-layout', 'desktop-icons-layout', 'menubar-item-registry', 'focus-state', 'focus-last']);

// Schemas whose keys Guava may own through core/originals.js
const openSettings = schemaId =>
    Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true)
        ? new Gio.Settings({ schema_id: schemaId }) : null;

/**
 * The composition root: core services, then the feature registry. Every feature
 * gets the same ctx:
 *   extension, settings (Guava's Gio.Settings), gettext, features ({instance(id)}),
 *   events (core/events.js), desktop (core/desktop.js), layout (core/layout.js),
 *   motion (core/motion.js), osd (core/osd.js), originals (core/originals.js), appMenus (core/appMenus/service.js),
 *   timers (core/timers.js), session ({locked}, the lock screen: lib/lockModel.js)
 */
// Guava declares the 'unlock-dialog' session mode (D-018): the Shell then keeps it enabled while the
// screen is locked, so a lock costs no teardown and an unlock restores everything at once. While
// locked every feature is suspended (surfaces hidden and inert, lib/lockModel.js) except the ones
// that declare `lockScreen: true` in features.js (D-022).
// disable() can still run while locked (the user turns Guava off there, or the Shell updates it);
// the GNOME keys it owns and the extensions it holds off then stay as they are, so nothing flashes.
let _heldAcrossLock = false;

export default class GuavaExtension extends Extension {
    enable() {
        try {
            this._enable();
        } catch (e) {
            // The Shell does not call disable() for an extension whose enable() threw: undo what was
            // set up so far (the OSD injection, session and settings handlers, the services), then
            // let it mark the extension as errored
            console.error('[Guava] enable failed, undoing:', e);
            try {
                this.disable();
            } catch (e2) {
                console.error('[Guava] disable after a failed enable also failed:', e2);
            }
            throw e;
        }
    }

    _enable() {
        this._cleanup = new CleanupRegistry();
        this._settings = this.getSettings();
        Glass.configure(this._settings);
        IconStyle.configure(this._settings);

        // Before any feature owns a GNOME key: one a crashed session still held must be the
        // user's again before a feature saves it.
        this._originals = new OriginalsStore(this._settings);
        // Lists a feature takes members out of (Dash to Dock) are left: GNOME never calls
        // disable() at logout, so the entry is there at every login, and giving the member back
        // now would make the Shell enable it just for the dock to remove it again. The dock
        // adopts the entry; whatever nobody adopted is given back once the features have started.
        if (!_heldAcrossLock) {
            try {
                restoreStale(this._originals, openSettings, { members: 'leave' });
            } catch (err) {
                console.error('[Guava] could not restore saved GNOME settings:', err);
            }
        }
        _heldAcrossLock = false;
        const generation = this._generation = (this._generation ?? 0) + 1;

        this._events = new EventHub();
        this._desktop = new DesktopService(this._events);
        this._layout = new LayoutService(this._events);
        this._motion = new Motion(this._events);
        this._motion.start();
        this._timers = new TimerService(this._events, this._settings);
        this._timers.start();
        this._appMenus = new AppMenuService({ events: this._events, desktop: this._desktop, layout: this._layout });
        this._osd = new OsdRouter(this._settings);
        this._osd.start(this._cleanup);

        this._features = new FeatureRegistry(CleanupRegistry, {
            onChange: (id, active) => this._events?.emit('feature-changed', { id, active }),
            now: () => GLib.get_monotonic_time() / 1000,
        });
        this._features.registerAll(FEATURES);
        // Off unless debug-logging is set (tools/guava-logs.sh): then a timeline in the journal
        this._debug = new DebugLog(this._settings, this._events, this, () => this._features);
        this._debug.start(this._cleanup);
        // Lock screen: ctx.session.locked, the 'session-locked' / 'session-unlocked' events
        const session = this._session = { locked: Main.sessionMode.isLocked };
        // Safety net for Guava-named chrome and panel buttons that no feature registered as a surface
        const sweep = new SurfaceLedger();
        const sweepWatch = new Map(); // actor -> [handler ids]: destroyed leaves the ledger, shown is hidden again
        const sweepStop = () => {
            for (const [a, ids] of sweepWatch)
                ids.forEach(id => a.disconnect(id));
            sweepWatch.clear();
        };
        const sweepRestore = () => {
            sweepStop();
            sweep.restore();
        };
        const sweepNow = () => {
            const boxes = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
            const top = [...Main.layoutManager.uiGroup.get_children(), ...boxes.flatMap(b => b?.get_children() ?? [])];
            for (const a of sweep.hide(sweepTargets(top, this._features.lockSurfaces())))
                sweepWatch.set(a, [
                    a.connect('destroy', () => {
                        sweepWatch.delete(a);
                        sweep.forget(a);
                    }),
                    a.connect('notify::visible', () => sweep.guard(a)),
                ]);
        };
        // Chrome a sub-registry adds while the screen is locked is swept as it arrives
        let sweepLater = 0;
        const sweepWatchAdds = [];
        const onSessionMode = () => {
            const locked = Main.sessionMode.isLocked;
            if (locked === session.locked)
                return;
            session.locked = locked;
            this._features?.setLocked(locked);
            if (locked) {
                sweepNow();
                const boxes = [Main.layoutManager.uiGroup, Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
                for (const box of boxes.filter(Boolean)) {
                    sweepWatchAdds.push([box, box.connect('child-added', () => {
                        sweepLater ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            sweepLater = 0;
                            if (Main.sessionMode.isLocked && this._features)
                                sweepNow();
                            return GLib.SOURCE_REMOVE;
                        });
                    })]);
                }
            } else {
                for (const [box, id] of sweepWatchAdds.splice(0))
                    box.disconnect(id);
                if (sweepLater) {
                    GLib.Source.remove(sweepLater);
                    sweepLater = 0;
                }
                sweepRestore();
                // The Shell's pass for its tracked chrome ran before ours (it connected first) and was
                // undone by the guard while locked: run it again so the dock stays hidden over a
                // full-screen window (RV2-2)
                Main.layoutManager._updateVisibility?.();
            }
            this._events?.emit(locked ? 'session-locked' : 'session-unlocked', {});
        };
        this._cleanup.connect(Main.sessionMode, 'updated', onSessionMode);
        this._cleanup.add(() => {
            for (const [box, id] of sweepWatchAdds.splice(0))
                box.disconnect(id);
            if (sweepLater)
                GLib.Source.remove(sweepLater);
            sweepLater = 0;
            sweepRestore();
        });
        // Many keys can change at once (Reset Everything): one pass for all of them
        const changedKeys = new Set();
        this._cleanup.connect(this._settings, 'changed', (_settings, key) => {
            if (KEYS_THAT_NEVER_AFFECT_FEATURES.has(key))
                return;
            if (!changedKeys.size) {
                this._cleanup.idle(() => {
                    const keys = [...changedKeys];
                    changedKeys.clear();
                    this._features?.refreshKeys(keys);
                }, { name: 'features: refresh' });
            }
            changedKeys.add(key);
        });

        // Staged start (login, B2): entries marked `later` in features.js start after the login
        const ctx = {
            extension: this,
            settings: this._settings,
            gettext: this.gettext.bind(this),
            // Read-only lookup of other running features: features.instance('stage-manager')
            features: { instance: id => this._features?.instance(id) ?? null },
            events: this._events,
            desktop: this._desktop,
            layout: this._layout,
            motion: this._motion,
            osd: this._osd,
            originals: this._originals,
            timers: this._timers,
            appMenus: this._appMenus,
            session,
            // A line in the debug log (a no-op while it is off): ctx.debug('dock', 'bounce', {appId})
            debug: (scope, message, data) => this._debug?.log(scope, message, data),
        };
        this._features.start(ctx, { holdBack: entry => isLater(entry, ctx) });
        this._features.setLocked(session.locked);
        if (session.locked)
            sweepNow();
        // After the startup animation (at login) and the first idle (always): the frames that
        // show the session come first
        const release = () => this._cleanup?.idle(() => this._features?.release(), { name: 'features: after login' });
        if (Main.layoutManager._startingUp) {
            const done = this._cleanup.connect(Main.layoutManager, 'startup-complete', () => {
                this._cleanup.release(done);
                release();
            });
        } else {
            release();
        }

        // After the dock took its entry (it does so from an idle queued before this one)
        this._features.settled().then(() => {
            if (this._generation === generation)
                this._cleanup?.idle(() => restoreStale(this._originals, openSettings, { members: 'only' }),
                    { name: 'originals: unclaimed lists' });
        });
    }

    disable() {
        // Session mode 'unlock-dialog' (EGO-M-008): Guava is declared for the lock screen so that it
        // stays loaded while the screen is locked (instant unlock, D-018). While locked its features
        // are suspended and inert, none of them handles keyboard input there, and nothing is
        // disabled selectively. This code runs for a real disable (the user, an update), where
        // isLocked is only true if that happens during a lock.
        _heldAcrossLock = Main.sessionMode.isLocked;
        if (this._originals)
            this._originals.keepStored = _heldAcrossLock;
        this._generation++;
        this._cleanup?.dispose();
        this._cleanup = null;
        this._features?.stop();
        this._features = null;
        this._timers?.stop();
        this._appMenus?.stop();
        this._motion?.stop();
        this._layout?.stop();
        this._desktop?.stop();
        this._events?.clear();
        this._appMenus = this._motion = this._layout = this._desktop = this._events = this._osd = this._timers = null;
        this._debug = null;
        this._originals = null;
        this._session = null;
        IconStyle.configure(null);
        Glass.configure(null);
        this._settings = null;
    }
}
