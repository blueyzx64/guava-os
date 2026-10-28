/*
 * Guava OS – macOS-inspired enhancements for GNOME Shell.
 * Copyright (C) 2025  Arnis Kemlers
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { CleanupRegistry } from './lib/disposables.js';
import { FeatureRegistry } from './lib/featureRegistry.js';
import { Glass } from './lib/glass.js';
import { IconStyle } from './lib/iconStyle.js';
import { EventHub } from './core/events.js';
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
 *   timers (core/timers.js)
 */
// The Shell disables every extension while the screen is locked and enables it again at unlock
// (Guava has no 'unlock-dialog' session mode: its UI has no place on the lock screen). The GNOME
// keys it owns and the extensions it holds off stay as they are meanwhile, so an unlock changes
// nothing and nothing flashes; set by disable(), read by the enable() that follows.
let _heldAcrossLock = false;

export default class GuavaExtension extends Extension {
    enable() {
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
        });
        this._features.registerAll(FEATURES);
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

        this._features.start({
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
        });

        // After the dock took its entry (it does so from an idle queued before this one)
        this._features.settled().then(() => {
            if (this._generation === generation)
                this._cleanup?.idle(() => restoreStale(this._originals, openSettings, { members: 'only' }),
                    { name: 'originals: unclaimed lists' });
        });
    }

    disable() {
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
        this._originals = null;
        IconStyle.configure(null);
        Glass.configure(null);
        this._settings = null;
    }
}
