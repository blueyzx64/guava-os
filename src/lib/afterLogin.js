// SPDX-License-Identifier: GPL-3.0-or-later
// Work a feature can do once the session is on screen (login, B38): not before the Shell's
// startup is complete and the first frames that show the session are painted. Nothing the user
// sees at login may wait for this (chrome, the look of what is open); parts that only answer
// input or show something on demand may.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Run fn at the first idle after the login (at once when the Shell is already up). The
 * cleanup cancels it; fn runs at most once.
 *
 * @param {CleanupRegistry} cleanup
 * @param {() => void} fn
 * @param {string} name source name
 */
export function afterLogin(cleanup, fn, name = 'after login') {
    const lm = Main.layoutManager;
    if (!lm._startingUp) {
        cleanup.idle(fn, { name });
        return;
    }
    const done = cleanup.connect(lm, 'startup-complete', () => {
        cleanup.release(done);
        cleanup.idle(fn, { name });
    });
}
