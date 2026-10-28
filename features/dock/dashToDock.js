// SPDX-License-Identifier: GPL-3.0-or-later
// Only one dock: while Guava's dock runs, Dash to Dock is taken out of org.gnome.shell
// enabled-extensions (the Shell then disables it), and put back when Guava's dock stops. The
// entry is kept in core/originals, so a crash still gives it back at the next start, and any
// other change to the list made meanwhile is kept (ListMembersOwner).
//
// Shell API: global.settings (org.gnome.shell), Main.extensionManager.lookup(uuid).state and
// misc/extensionUtils.js ExtensionState; checked on GNOME 50.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { ListMembersOwner } from '../../core/originals.js';

/** Docks that cannot run beside Guava's. */
export const OTHER_DOCKS = Object.freeze(['dash-to-dock@micxgx.gmail.com']);

/**
 * Disabling an extension makes the Shell disable every extension enabled after it, Guava
 * included, and enable them again ("rebase", js/ui/extensionSystem.js
 * _callExtensionDisableWithRebase). Guava's disable() during that must not put the other dock
 * back, or the two would knock each other out forever; the stored entry carries over to the
 * enable that follows.
 */
function rebasing() {
    return OTHER_DOCKS.some(uuid => Main.extensionManager.lookup(uuid)?.state === ExtensionState.DEACTIVATING);
}

/**
 * Keep the other docks off until `cleanup` is disposed.
 *
 * @param {import('../../core/originals.js').OriginalsStore} originals ctx.originals
 * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup
 * @returns {ListMembersOwner} its `held` lists the docks Guava turned off
 */
export function keepOtherDocksOff(originals, cleanup) {
    // The user enabling Dash to Dock (the Extensions app) writes the list while the Shell is
    // still enabling it, asynchronously. Taking it out of the list meanwhile makes the Shell
    // forget it, and the dock would run on beside Guava's. So the strip waits until the dock
    // is active (the Shell has registered it by the next idle) and the Shell can disable it.
    let waiting = null;
    const activating = () => OTHER_DOCKS.some(uuid => Main.extensionManager.lookup(uuid)?.state === ExtensionState.ACTIVATING);
    const defer = fn => {
        if (activating())
            waiting = fn;
        else
            cleanup.idle(fn, { name: 'dock: other docks off' });
    };
    cleanup.connect(Main.extensionManager, 'extension-state-changed', () => {
        if (waiting && !activating()) {
            cleanup.idle(waiting, { name: 'dock: other docks off' });
            waiting = null;
        }
    });
    const owner = new ListMembersOwner(originals, global.settings, 'enabled-extensions', OTHER_DOCKS, { defer });
    // From an idle, never inside enable(): the Shell reacts to the write at once, and its
    // re-base can disable Guava itself (see rebasing())
    cleanup.idle(() => owner.sync(true), { name: 'dock: other docks off' });
    cleanup.add(() => owner.release({ keepStored: rebasing() }));
    return owner;
}
