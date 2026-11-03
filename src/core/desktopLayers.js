// SPDX-License-Identifier: GPL-3.0-or-later
// DesktopLayers: how the things Guava draws on the desktop share it. Desktop icons and desktop
// widgets both live in global.window_group above the wallpaper and below every window.
//
//   const layers = DesktopLayers.acquire(cleanup);
//   layers.stack(cleanup, { id: 'icons', rank: 10, actor });   // kept above the wallpaper, in rank order
//   const reserve = layers.reserve(cleanup, 'widgets');
//   reserve.set(rects);                                        // stage rectangles others flow around
//   layers.onReserved(cleanup, () => ...);                     // somebody else's rectangles changed
//   layers.reserved('icons');                                  // everyone's rectangles but 'icons'
//
// A layer sits right above the Shell's background group, or above the desktop-icons window of
// an extension that draws its own (DING), and is put back there whenever Mutter restacks.
// Ranks: icons 10, widgets 20 (a widget covers an icon, as on macOS).
//
// Shell API (private, checked on 50.6): Main.layoutManager._backgroundGroup.

import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ReserveStore, stackOrder } from './desktopLayersModel.js';

export const RANKS = Object.freeze({ icons: 10, widgets: 20 });

class DesktopLayerService {
    constructor() {
        this._layers = [];            // {id, rank, actor, cleanup}
        this._reserve = new ReserveStore();
        this._listeners = new Set();
        this._restackId = 0;
    }

    /**
     * Keep an actor in the desktop stack until `cleanup` is disposed. The caller adds the actor
     * to global.window_group (or not: it is added here when it has no parent).
     */
    stack(cleanup, layer) {
        const entry = { id: layer.id, rank: layer.rank, actor: layer.actor };
        this._layers.push(entry);
        if (!layer.actor.get_parent())
            global.window_group.add_child(layer.actor);
        if (!this._restackId)
            this._restackId = global.display.connect('restacked', () => this.restack());
        this.restack();
        cleanup.add(() => {
            this._layers = this._layers.filter(l => l !== entry);
            if (!this._layers.length && this._restackId) {
                global.display.disconnect(this._restackId);
                this._restackId = 0;
            }
        });
    }

    /** Put every layer back above the wallpaper, in rank order. */
    restack() {
        const wg = global.window_group;
        let below = Main.layoutManager._backgroundGroup ?? null;
        for (const a of global.get_window_actors()) {
            if (a.meta_window?.get_window_type() === Meta.WindowType.DESKTOP && a.get_parent() === wg)
                below = a;
        }
        for (const { actor } of stackOrder(this._layers)) {
            if (actor.get_parent() !== wg)
                continue;
            if (below && below.get_parent() === wg) {
                if (actor.get_previous_sibling() !== below)
                    wg.set_child_above_sibling(actor, below);
                below = actor;
            } else if (wg.get_child_at_index(1) !== actor) {
                wg.set_child_at_index(actor, 1);
            }
        }
    }

    /** A handle to publish rectangles under an owner id; cleared when `cleanup` is disposed. */
    reserve(cleanup, owner) {
        cleanup.add(() => this._publish(owner, []));
        return { set: rects => this._publish(owner, rects) };
    }

    _publish(owner, rects) {
        if (!this._reserve.set(owner, rects))
            return;
        for (const fn of [...this._listeners]) {
            try {
                fn(owner);
            } catch (e) {
                console.error('[Guava] desktop layers listener failed:', e);
            }
        }
    }

    /** Stage rectangles other layers keep clear of (all owners but `except`). */
    reserved(except = null) {
        return this._reserve.all(except);
    }

    /** Called with the owner id whenever somebody's rectangles change. */
    onReserved(cleanup, fn) {
        this._listeners.add(fn);
        cleanup.add(() => this._listeners.delete(fn));
    }
}

let service = null;
let refs = 0;

export const DesktopLayers = {
    /** Use the service; the last release drops it. */
    acquire(cleanup) {
        service ??= new DesktopLayerService();
        refs++;
        const mine = service;
        let released = false;
        cleanup.add(() => {
            if (released)
                return;
            released = true;
            if (--refs === 0 && service === mine)
                service = null;
        });
        return mine;
    },
};
