// SPDX-License-Identifier: GPL-3.0-or-later
// OsdRouter: the one place that intercepts the Shell's on-screen display (volume, brightness,
// keyboard backlight) and hands it to the Guava surface that should show it (the Shell side of
// core/osdModel.js).
//
//   ctx.osd.setSink(cleanup, 'pill', osd => { ... });   // a surface that can show them
//   osd = { kind, muted, fraction, icon, label, level, maxLevel }   see osdModel.classifyOsd
//
// Which sink gets a change is decided in osdModel.route() from the osd-location setting and
// from which sinks are registered right now; the notch registers 'notch' while it runs and
// the OSD feature registers 'pill'. A sink that throws is skipped for that change and the
// stock OSD shows it. Other monitors keep the stock OSD: both sinks live on the primary one.
//
// Shell API: Main.osdWindowManager._showOsdWindow(monitorIndex, icon, label, level, maxLevel)
// (js/ui/osdWindow.js; the same in 48.0, 49.0, 50.0 and main), see lib/compat.js canDivertOsd.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { canDivertOsd } from '../lib/compat.js';
import { classifyOsd, route } from './osdModel.js';

export class OsdRouter {
    /** @param {Gio.Settings} settings Guava's settings (osd-location) */
    constructor(settings) {
        this._settings = settings;
        this._sinks = new Map();    // 'notch' | 'pill' -> function(osd)
    }

    /** Intercept the Shell's OSD until `cleanup` is disposed (extension enable). */
    start(cleanup) {
        const manager = Main.osdWindowManager;
        if (!canDivertOsd(manager)) {
            console.warn('[Guava] the Shell has no _showOsdWindow: volume and brightness keep the stock OSD');
            return;
        }
        const router = this;
        cleanup.inject(manager, '_showOsdWindow', function (orig, monitorIndex, icon, label, level, maxLevel) {
            if (monitorIndex === Main.layoutManager.primaryIndex &&
                router._deliver(icon, label, level, maxLevel))
                return undefined;
            return orig.call(this, monitorIndex, icon, label, level, maxLevel);
        });
        cleanup.add(() => this._sinks.clear());
    }

    /**
     * Register the surface that shows OSDs as `name` ('notch' or 'pill'); undone when `owner`
     * (a CleanupRegistry) is disposed. A second registration under a name replaces the first.
     *
     * @param {{add: Function}} owner
     * @param {'notch'|'pill'} name
     * @param {Function} show called with the osd description
     */
    setSink(owner, name, show) {
        this._sinks.set(name, show);
        owner.add(() => {
            if (this._sinks.get(name) === show)
                this._sinks.delete(name);
        });
    }

    // True when a Guava surface took the OSD, false to let the stock one show it
    _deliver(icon, label, level, maxLevel) {
        const described = classifyOsd({ iconNames: icon?.names ?? [], level, maxLevel });
        const target = route({
            kind: described.kind,
            location: this._settings.get_string('osd-location'),
            sinks: { notch: this._sinks.has('notch'), pill: this._sinks.has('pill') },
        });
        if (target === 'stock')
            return false;
        try {
            this._sinks.get(target)({ ...described, icon, label, level, maxLevel });
            return true;
        } catch (e) {
            console.error(`[Guava] ${target} OSD failed, using the stock one:`, e);
            return false;
        }
    }
}
