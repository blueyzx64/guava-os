// SPDX-License-Identifier: GPL-3.0-or-later
// DesktopActions: runs one desktop action (core/desktopActionsModel.js) for hot corners,
// gestures and the app switcher, so each entry point behaves the same.
//
//   const actions = new DesktopActions(ctx);
//   actions.run('app-expose', { source: 'corner' });
//
// The action's owner is asked through ctx (never imported):
//   mission-control       the mission-control feature's toggle(); fallback: Main.overview
//   app-expose            'app-expose-requested' (Mission Control); fallback: the overview
//   desktop               the show-desktop feature's toggle() (it hands off to Stage Manager)
//   notification-center   the date menu, whose opening the menu bar turns into
//                         'notification-center-requested' (the Notification Center, P5)
//   launchpad             'launchpad-requested'; fallback: the app grid
//   lock-screen           Main.screenShield.lock()
//   display-sleep         Main.screenShield.activate(): the same as org.gnome.ScreenSaver
//                         SetActive(true); GNOME blanks the screen and locks on its own policy
// No state: create one per feature.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { actionAllowed, normalizeAction } from './desktopActionsModel.js';

const LOG = '[Guava] desktop actions:';

export class DesktopActions {
    /** @param {{events, features, desktop}} ctx */
    constructor(ctx) {
        this._ctx = ctx;
    }

    /** Can `action` run now (not locked; nothing that stacks over Mission Control). */
    allowed(action) {
        return actionAllowed(normalizeAction(action), {
            overview: Main.overview.visible,
            locked: Main.sessionMode.isLocked,
        });
    }

    /**
     * @param {string} action a DESKTOP_ACTIONS id
     * @param {{source: string, appId?: ?string}} opts source names the entry point
     * @returns {boolean} true when something ran
     */
    run(action, { source, appId = null }) {
        action = normalizeAction(action);
        if (!this.allowed(action))
            return false;
        const { events } = this._ctx;
        switch (action) {
        case 'mission-control':
            // Mission Control's own toggle also leaves App Exposé for Mission Control
            (this._ctx.features?.instance('mission-control') ?? Main.overview).toggle();
            return true;
        case 'app-expose':
            if (events.listenerCount('app-expose-requested') > 0) {
                // The front app, while core/desktop tracks (it does whenever a feature uses it)
                appId ??= this._ctx.desktop?.tracking ? this._ctx.desktop.model.focusedApp : null;
                events.emit('app-expose-requested', { appId, source });
            } else {
                Main.overview.show();
            }
            return true;
        case 'desktop': {
            const desktop = this._ctx.features.instance('show-desktop');
            if (typeof desktop?.toggle !== 'function')
                return false;
            desktop.toggle();
            return true;
        }
        case 'notification-center': {
            const menu = Main.panel.statusArea.dateMenu?.menu;
            menu?.toggle();
            return !!menu;
        }
        case 'launchpad':
            if (events.listenerCount('launchpad-requested') > 0)
                events.emit('launchpad-requested', { source });
            else
                Main.overview.showApps();
            return true;
        case 'lock-screen':
            if (!Main.screenShield) {
                console.warn(`${LOG} no screen shield in this session`);
                return false;
            }
            Main.screenShield.lock(true);
            return true;
        case 'display-sleep':
            if (!Main.screenShield)
                return false;
            Main.screenShield.activate(true);
            return true;
        }
        return false;
    }
}
