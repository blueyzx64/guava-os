// SPDX-License-Identifier: GPL-3.0-or-later
// Keep a Shell actor hidden while a Guava feature is on, even when its own code shows it
// again, and give it back the visibility its owner asked for last.
//
//   const undo = keepHidden(actor, { resync: a => a._sync?.() });
//   undo();   // on disable: visible again if the owner wanted it, then resync

/**
 * @param {Clutter.Actor} actor
 * @param {{resync?: (actor: Clutter.Actor) => void}} [opts] called after the restore, so an
 *   owner that recomputes its visibility (world clocks, weather) gets the last word
 * @returns {() => void} undo, safe to call once the actor is destroyed
 */
export function keepHidden(actor, { resync } = {}) {
    let wanted = actor.visible;
    let dead = false;
    const destroyId = actor.connect('destroy', () => {
        dead = true;
    });
    const visibleId = actor.connect('notify::visible', () => {
        if (!actor.visible)
            return;
        wanted = true;
        actor.hide();
    });
    actor.hide();

    let done = false;
    return () => {
        if (done || dead)
            return;
        done = true;
        actor.disconnect(visibleId);
        actor.disconnect(destroyId);
        actor.visible = wanted;
        try {
            resync?.(actor);
        } catch (e) {
            console.warn(`[Guava] keepHidden resync failed: ${e.message}`);
        }
    };
}
