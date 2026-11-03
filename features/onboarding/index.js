// SPDX-License-Identifier: GPL-3.0-or-later
// Onboarding: the Shell's part of the Setup Assistant. While the `onboarding` key is 'new'
// (features.js runs this only then), once the session is idle it opens Guava's preferences
// once with the key set to 'requested'; prefs.js presents the assistant
// (prefs/setupAssistant.js). Not in a session other than the user's, and never over
// the overview (GNOME starts in it) or another modal such as GNOME's welcome dialog: then it
// asks again when the overview closes or a window gets the focus. Rules: model.js.
//
// Shell API: Main.overview 'hidden', global.display notify::focus-window,
// Main.sessionMode.currentMode, Main.modalCount, Extension.openPreferences().

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ONBOARDING_KEY, offerDecision } from './model.js';

export class Onboarding {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        this._waiting = this._queued = false;
        // An idle after enable: at login the overview (or GNOME's welcome dialog) is up by then,
        // so the offer waits for it (_askAgainLater)
        this._cleanup.idle(() => this._offer(), { name: 'guava onboarding' });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    _offer() {
        const { settings, extension } = this._ctx;
        const decision = offerDecision({
            state: settings.get_string(ONBOARDING_KEY),
            sessionMode: Main.sessionMode.currentMode,
            overviewVisible: Main.overview.visible,
            modalOpen: Main.modalCount > 0,
        });
        if (decision === 'later')
            this._askAgainLater();
        if (decision !== 'offer')
            return;
        settings.set_string(ONBOARDING_KEY, 'requested');
        // The Shell asks the prefs service over D-Bus and waits for its answer (25 s at most). A slow or
        // failed start is logged, not left as an unhandled rejection; the key stays 'requested', so the
        // assistant still shows the next time the window opens
        Promise.resolve(extension.openPreferences()).catch(e =>
            console.warn(`[Guava] onboarding: could not open the preferences window: ${e.message}`));
    }

    // The overview closing, or a window getting the focus (no modal holds it then)
    _askAgainLater() {
        if (this._waiting)
            return;
        this._waiting = true;
        const again = () => {
            if (this._queued)
                return;
            this._queued = true;
            this._cleanup.idle(() => {
                this._queued = false;
                this._offer();
            }, { name: 'guava onboarding' });
        };
        this._cleanup.connect(Main.overview, 'hidden', again);
        this._cleanup.connect(global.display, 'notify::focus-window', again);
    }
}
