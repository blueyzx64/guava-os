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
import { rebaseRestoreIndex, rebaseShield } from './model.js';

/** Longest Guava stays out of the Shell's extension order while a dock is taken out. */
const SHIELD_MAX_MS = 3000;

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
 * @param {string} selfUuid Guava's uuid (the extension that owns the dock)
 * @returns {ListMembersOwner} its `held` lists the docks Guava turned off
 */
export function keepOtherDocksOff(originals, cleanup, selfUuid) {
    // A dock enabled before Guava (the usual order) re-bases Guava when it is taken out of the
    // list: Guava stops and starts again, a second full start at every login (B22). The Shell
    // re-bases the extensions behind the one removed, in its order list; Guava steps out of that
    // list for the write and returns once the dock is out of it (the settings may deliver the
    // change later than the write; a timeout is the net). Private API (Main.extensionManager
    // ._extensionOrder, extensionSystem.js), guarded; without it the write is plain.
    const order = Main.extensionManager._extensionOrder;
    let pending = null;
    const stepBack = () => {
        if (!pending)
            return;
        const { after, timer } = pending;
        pending = null;
        cleanup.release(timer);
        if (!order.includes(selfUuid))
            order.splice(rebaseRestoreIndex(order, after), 0, selfUuid);
    };
    const dockInOrder = () => OTHER_DOCKS.some(uuid => order.includes(uuid));
    const shielded = fn => {
        const plan = Array.isArray(order) && selfUuid && !pending ? rebaseShield(order, selfUuid, OTHER_DOCKS) : null;
        if (!plan?.shield) {
            fn();
            return;
        }
        order.splice(order.indexOf(selfUuid), 1);
        pending = { after: plan.after, timer: cleanup.timeout(SHIELD_MAX_MS, () => stepBack(), { name: 'dock: re-base shield' }) };
        try {
            fn();
        } finally {
            if (!dockInOrder() && !rebasing())
                stepBack();
        }
    };
    cleanup.connect(Main.extensionManager, 'extension-state-changed', () => {
        if (pending && !dockInOrder() && !rebasing())
            stepBack();
    });
    cleanup.add(() => {
        // The user disabled Guava inside the shield window: the Shell found Guava absent from its
        // order (index -1) and will `splice(-1, 1)` the LAST entry when this disable returns. Put
        // Guava last, so that entry is Guava's own and no other extension is dropped.
        if (pending && !rebasing() && Main.extensionManager.lookup(selfUuid)?.state === ExtensionState.DEACTIVATING)
            pending.after = [];
        stepBack();
    });

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
            cleanup.idle(() => shielded(fn), { name: 'dock: other docks off' });
    };
    cleanup.connect(Main.extensionManager, 'extension-state-changed', () => {
        if (waiting && !activating()) {
            const fn = waiting;
            cleanup.idle(() => shielded(fn), { name: 'dock: other docks off' });
            waiting = null;
        }
    });
    const owner = new ListMembersOwner(originals, global.settings, 'enabled-extensions', OTHER_DOCKS, { defer });
    // From an idle, never inside enable(): the Shell reacts to the write at once, and its
    // re-base can disable Guava itself (see rebasing())
    cleanup.idle(() => shielded(() => owner.sync(true)), { name: 'dock: other docks off' });
    cleanup.add(() => owner.release({ keepStored: rebasing() }));
    return owner;
}
