// SPDX-License-Identifier: GPL-3.0-or-later
// Focus modes (features.js `focus`; macOS Monterey).
//
//   model.js       the rules: profiles, schedules, app triggers, what may notify (tested)
//   indicator.js   the Control Center tile with the mode menu, and the menu-bar icon
//   here           the adapter: reads the settings and the clock, applies the result
//
// While a mode is active, banners from apps it does not allow are held back through
// NotificationRouter.setBannerFilter: they are acknowledged and stay in the Notification
// Center, as on macOS. Critical notifications (time-sensitive) break through unless the mode
// says otherwise. GNOME's Do Not Disturb key (org.gnome.desktop.notifications show-banners)
// follows the "Do Not Disturb" mode both ways, so the stock toggle, Alt-click on the clock and
// other apps agree with Guava.
//
// Timers: one GLib timeout to the next schedule edge or "for 1 hour" end, re-armed on every
// evaluation; app triggers react to window events from core/desktop. Nothing polls.
//
// Private Shell API: quickSettings._doNotDisturb (GNOME 49-51, panel.js), hidden while the
// Focus tile replaces it.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NotificationRouter } from '../../core/notificationRouter.js';
import { keepHidden } from '../../lib/keepHidden.js';
import { whenQuickSettingsReady } from '../../lib/quickSettings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { FocusIndicator } from './indicator.js';
import {
    HOUR_MS, allows, choose, evaluate, minutesToText, nextEdge, parseProfiles, parseState,
    serializeState, untilTomorrow,
} from './model.js';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const DND_ID = 'dnd';

export class Focus {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._profiles = [];
        this._result = { active: null, manual: null, until: null };
        this._timer = 0;
        this._indicator = null;
        this._writingDnd = false;
        this._dndByAutomation = false;
    }

    enable() {
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(cleanup);
        this._ks = ks;
        this._desktop = this._ctx.desktop.acquire(cleanup);

        ks.watch(['focus-profiles', 'focus-state'], () => this._evaluate());
        ks.watch('focus-menubar-icon', () => this._syncIndicator());
        for (const event of ['window-added', 'window-removed'])
            this._ctx.events.on(event, () => this._onAppsChanged(), cleanup);
        this._ctx.events.on('window-changed', ({ fields }) => fields.includes('appId') && this._onAppsChanged(), cleanup);

        NotificationRouter.setBannerFilter(cleanup, notification => this._allows(notification));
        NotificationRouter.connect(cleanup, state => this._onDndChanged(state.dnd));
        whenQuickSettingsReady(cleanup, qs => this._addIndicator(qs), 'Focus');

        // GNOME's Do Not Disturb already on (stock toggle, an earlier session): that is the mode,
        // chosen before the first evaluation so it is not switched off
        const wanted = evaluate({
            profiles: parseProfiles(ks.string('focus-profiles')),
            manual: parseState(ks.string('focus-state')),
            now: Date.now(),
            openApps: this._openApps(),
        }).active;
        if (NotificationRouter.state().dnd && wanted?.id !== DND_ID)
            this._writeState({ id: DND_ID, until: 0 });
        this._evaluate();

        cleanup.add(() => {
            // A mode an automation turned on goes with Guava; a manual Do Not Disturb stays, as
            // GNOME's own toggle would
            if (this._dndByAutomation)
                this._writeDnd(false);
        });
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    // ---- public: the notch, the Notification Center and tests ------------------------------

    /** @returns {{id: ?string, name: ?string, icon: ?string, reason: ?string, until: ?number}} */
    state() {
        const profile = this._activeProfile();
        return {
            id: profile?.id ?? null, name: profile?.name ?? null, icon: profile?.icon ?? null,
            reason: this._result.active?.reason ?? null, until: this._result.until,
        };
    }

    profiles() {
        return this._profiles;
    }

    /**
     * @param {string} id
     * @param {0|'hour'|'tomorrow'|number} duration 0: until turned off; a number is ms
     */
    turnOn(id, duration = 0) {
        const now = Date.now();
        let ms = typeof duration === 'number' ? duration : 0;
        if (duration === 'hour')
            ms = HOUR_MS;
        else if (duration === 'tomorrow')
            ms = untilTomorrow(now) - now;
        this._ks.setString('focus-last', id);
        this._writeState(choose(this._result.active, id, ms, now, false));
    }

    turnOff() {
        const now = Date.now();
        const auto = evaluate({ profiles: this._profiles, manual: null, now, openApps: this._openApps() }).active;
        this._writeState(choose(this._result.active, null, 0, now, !!auto));
    }

    toggle() {
        if (this._result.active)
            this.turnOff();
        else
            this.turnOn(this._profiles.some(p => p.id === this._ks.string('focus-last')) ? this._ks.string('focus-last') : DND_ID);
    }

    // ---- evaluation ------------------------------------------------------------------------

    _openApps() {
        return this._desktop.model.apps();
    }

    _activeProfile() {
        const id = this._result.active?.id;
        return id ? this._profiles.find(p => p.id === id) ?? null : null;
    }

    _onAppsChanged() {
        if (this._profiles.some(p => p.appTriggers.length))
            this._evaluate();
    }

    _evaluate() {
        this._profiles = parseProfiles(this._ks.string('focus-profiles'));
        const manual = parseState(this._ks.string('focus-state'));
        const now = Date.now();
        const before = this._result.active;
        this._result = evaluate({ profiles: this._profiles, manual, now, openApps: this._openApps() });
        // An expired or finished choice is dropped from the setting too
        if (serializeState(this._result.manual) !== serializeState(manual)) {
            this._writeState(this._result.manual);
            return;
        }
        this._arm(nextEdge(this._profiles, this._result.manual, now), now);
        this._syncDnd();
        this._syncIndicator();
        const after = this._result.active;
        if (before?.id !== after?.id || before?.reason !== after?.reason) {
            const s = this.state();
            this._ctx.events.emit('focus-changed', { id: s.id, name: s.name, icon: s.icon, reason: s.reason });
        }
    }

    _writeState(state) {
        // The settings watcher evaluates again
        this._ks.setString('focus-state', serializeState(state));
    }

    _arm(edge, now) {
        if (this._timer) {
            this._cleanup.release(this._timer);
            this._timer = 0;
        }
        if (edge === null)
            return;
        const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, edge - now));
        this._timer = this._cleanup.timeout(delay, () => {
            this._timer = 0;
            this._evaluate();
            return GLib.SOURCE_REMOVE;
        }, { name: 'focus schedule edge' });
    }

    _allows(notification) {
        const profile = this._activeProfile();
        if (!profile)
            return true;
        return allows(profile, {
            appId: NotificationRouter.appIdOf(notification.source),
            urgency: notification.urgency,
        });
    }

    // ---- GNOME's Do Not Disturb ------------------------------------------------------------

    _writeDnd(on) {
        if (NotificationRouter.state().dnd === on)
            return;
        this._writingDnd = true;
        try {
            NotificationRouter.setDnd(on);
        } finally {
            this._writingDnd = false;
        }
    }

    _syncDnd() {
        const active = this._result.active;
        const dnd = active?.id === DND_ID;
        this._dndByAutomation = dnd && active.reason !== 'manual';
        this._writeDnd(dnd);
    }

    /** The key changed outside Guava's Focus (stock toggle, Alt-click on the clock, an app). */
    _onDndChanged(dnd) {
        if (this._writingDnd)
            return;
        const isDnd = this._result.active?.id === DND_ID;
        if (dnd && !isDnd)
            this.turnOn(DND_ID);
        else if (!dnd && isDnd)
            this.turnOff();
    }

    // ---- Control Center tile and menu-bar icon --------------------------------------------

    _addIndicator(qs) {
        const _ = this._ctx.gettext;
        const indicator = new FocusIndicator({
            gettext: _,
            profiles: () => this._profiles,
            active: () => this._result.active,
            turnOn: (id, duration) => this.turnOn(id, duration),
            turnOff: () => this.turnOff(),
            toggle: () => this.toggle(),
            openSettings: () => {
                Main.panel.closeQuickSettings?.();
                this._ctx.extension.openPreferences();
            },
        });
        this._indicator = indicator;
        // The stock Do Not Disturb tile and icon step aside: Focus covers both
        const stock = qs._doNotDisturb;
        if (stock) {
            this._cleanup.add(keepHidden(stock));
            for (const item of stock.quickSettingsItems ?? [])
                this._cleanup.add(keepHidden(item));
        }
        qs.addExternalIndicator(indicator);
        this._cleanup.add(() => {
            this._indicator = null;
            indicator.quickSettingsItems.forEach(item => item.destroy());
            indicator.destroy();
        });
        this._syncIndicator();
    }

    _syncIndicator() {
        if (!this._indicator)
            return;
        const profile = this._activeProfile();
        const until = this._result.until;
        let subtitle = '';
        if (profile && until) {
            const d = new Date(until);
            subtitle = this._ctx.gettext('Until %s').replace('%s', minutesToText(d.getHours() * 60 + d.getMinutes()));
        } else if (profile && this._result.active.reason !== 'manual') {
            subtitle = this._result.active.reason === 'app' ? this._ctx.gettext('While the app is open') : this._ctx.gettext('Scheduled');
        }
        this._indicator.sync(profile, subtitle, this._ks.bool('focus-menubar-icon'));
    }
}
