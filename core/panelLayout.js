// SPDX-License-Identifier: GPL-3.0-or-later
// PanelLayout: the one owner of "who sits where" in the top bar.
//
// Features that put an actor into the panel claim a slot here instead of picking an index
// themselves. A slot is a box ('left' | 'center' | 'right') plus an anchor that names
// neighbours by status-area role or by another claim id:
//
//   const slot = PanelLayout.claim(cleanup, {
//       id: 'my-item',
//       actor: indicator.container,                         // the child of the panel box
//       box: 'left',
//       anchor: {before: ['quickSettings'], fallback: 'last'},
//   });
//   slot.update({box: 'right', anchor: {last: true}});      // move later
//   slot.release();                                         // also runs on cleanup.dispose()
//
// Anchors: {first:true} | {last:true} | {before:[ids], fallback?} | {after:[ids], fallback?}
// (fallback: 'first' | 'last', default 'last'; used when no named neighbour is in the box).
//
// The claim is re-applied (in one idle) whenever another extension or module adds a child to
// a box we hold a claim in, so late arrivals (calendar moving the date menu, the window title)
// do not push claimed actors out of place. It never destroys actors; the owner does.
//
// Claims in use and the order they give (left to right; foreign = stock or other extensions):
//   left box :  [guava-menubar-logo] [foreign...] [guava-menubar-apps]
//   right box:  [foreign...] [show-desktop] [clipboard] [guava-menubar-privacy] [quickSettings]
//               [foreign...]
//   center box: notch placeholder
// clipboard {before: quickSettings}; show-desktop {before: clipboard, quickSettings};
// guava-menubar-logo {first};
// guava-menubar-apps {after: activities, guava-menubar-logo};
// guava-menubar-privacy {before: quickSettings}.
//
// Stock items the menu bar does not show are hidden here too, so one module knows what the
// top bar holds:
//
//   PanelLayout.hide(cleanup, 'activities');   // shown again on cleanup.dispose()
//
// Private Shell API: Main.panel._leftBox/_centerBox/_rightBox. Same names in 48-51 as far as
// the shell sources used for this extension's skills go; not run on a real shell yet.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { keepHidden } from '../lib/keepHidden.js';
import { targetIndex } from './panelLayoutModel.js';

const BOX_PROPS = { left: '_leftBox', center: '_centerBox', right: '_rightBox' };

const claims = new Map();   // id -> claim
const watches = new Map();  // box name -> {box, id}
let idleId = 0;

function boxActor(name) {
    const prop = BOX_PROPS[name];
    return prop ? Main.panel?.[prop] ?? null : null;
}

function keyMap() {
    const map = new Map();
    for (const [role, indicator] of Object.entries(Main.panel?.statusArea ?? {})) {
        if (indicator?.container)
            map.set(indicator.container, role);
    }
    for (const claim of claims.values())
        map.set(claim.actor, claim.id);
    return map;
}

function place(claim) {
    const box = boxActor(claim.box);
    const actor = claim.actor;
    if (!box || !actor)
        return;

    const names = keyMap();
    const keys = box.get_children()
        .filter(c => c !== actor)
        .map(c => names.get(c) ?? null);
    const index = targetIndex(keys, claim.anchor);

    if (actor.get_parent() === box) {
        if (box.get_children().indexOf(actor) !== index)
            box.set_child_at_index(actor, index);
        return;
    }
    actor.get_parent()?.remove_child(actor);
    box.insert_child_at_index(actor, index);
}

function rebalanceSoon() {
    if (idleId)
        return;
    idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        idleId = 0;
        for (const claim of [...claims.values()])
            place(claim);
        return GLib.SOURCE_REMOVE;
    });
    GLib.Source.set_name_by_id(idleId, '[guava] PanelLayout rebalance');
}

function syncWatches() {
    const used = new Set([...claims.values()].map(c => c.box));
    for (const [name, w] of [...watches]) {
        if (used.has(name))
            continue;
        try {
            w.box.disconnect(w.id);
        } catch (_e) {
            // Box already gone with the panel.
        }
        watches.delete(name);
    }
    for (const name of used) {
        const box = boxActor(name);
        const existing = watches.get(name);
        if (existing && existing.box === box)
            continue;
        if (box)
            watches.set(name, { box, id: box.connect('child-added', rebalanceSoon) });
    }
    if (!claims.size && idleId) {
        GLib.Source.remove(idleId);
        idleId = 0;
    }
}

function drop(claim) {
    if (claims.get(claim.id) !== claim)
        return;
    claims.delete(claim.id);
    if (claim.destroyId) {
        try {
            claim.actor.disconnect(claim.destroyId);
        } catch (_e) {
            // Actor already destroyed.
        }
        claim.destroyId = 0;
    }
    syncWatches();
}

export const PanelLayout = {
    /**
     * Claim a place in the panel for `actor` and put it there now.
     *
     * @param {CleanupRegistry} cleanup the claim is released when it is disposed
     * @param {{id: string, actor: Clutter.Actor, box: string, anchor?: object}} spec
     * @returns {{update: Function, release: Function}}
     */
    claim(cleanup, { id, actor, box, anchor = { last: true } }) {
        if (!BOX_PROPS[box])
            throw new Error(`PanelLayout: unknown box '${box}'`);
        const old = claims.get(id);
        if (old)
            drop(old);

        const claim = { id, actor, box, anchor, destroyId: 0 };
        claim.destroyId = actor.connect('destroy', () => {
            claim.destroyId = 0;
            drop(claim);
        });
        claims.set(id, claim);
        syncWatches();
        place(claim);

        const slot = {
            update: ({ box: newBox, anchor: newAnchor } = {}) => {
                if (claims.get(id) !== claim)
                    return;
                if (newBox) {
                    if (!BOX_PROPS[newBox])
                        throw new Error(`PanelLayout: unknown box '${newBox}'`);
                    claim.box = newBox;
                }
                if (newAnchor)
                    claim.anchor = newAnchor;
                syncWatches();
                place(claim);
            },
            release: () => drop(claim),
        };
        cleanup?.add(() => slot.release());
        return slot;
    },

    /**
     * Hide a stock status-area item (its container, so its slot and spacing go too) while the
     * cleanup lives. Panel._updatePanel() shows every container again on a session mode
     * change; keepHidden() hides it again and gives back the visibility it was asked for last.
     *
     * @param {CleanupRegistry} cleanup
     * @param {string} role a Main.panel.statusArea key, e.g. 'activities'
     * @returns {boolean} false when the item does not exist
     */
    hide(cleanup, role) {
        const container = Main.panel?.statusArea?.[role]?.container ?? null;
        if (!container)
            return false;
        cleanup.add(keepHidden(container));
        return true;
    },

    /** @returns {string[]} ids of live claims (tests, debugging) */
    claimed() {
        return [...claims.keys()];
    },
};
