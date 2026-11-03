// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets: the ONE widget model for every surface that shows widgets (the desktop layer,
// the Notification Center's widgets area, the notch's Widgets tab).
//
//   import { Widgets } from '../../core/widgets/index.js';
//   const host = Widgets.acquire(cleanup, ctx.gettext);   // released with cleanup
//   host.registry.kinds();                                // [{id, title, category, sizes, ...}]
//   host.registry.sizesFor('weather', 'center');          // no extra-large outside the desktop
//   const view = host.createView('weather', { size: 'small', config: {} }, cleanup);
//   box.add_child(view.actor); view.setActive(true);      // see view.js
//
// Data providers (clock, calendar, weather, batteries, media, system) are shared between all
// views of all surfaces and lazy: a provider runs only while at least one ACTIVE view uses
// it, so with no visible widget nothing runs (no timer, no D-Bus subscription).
// Layout helpers for any surface (grid, snapping, persistence) are in ./model.js.
//
// The host lives while someone holds it; the last release stops every provider.

import { ProviderPool, WidgetRegistry } from './model.js';
import { WidgetView } from './view.js';
import { TimeProvider } from './providers/time.js';
import { CalendarProvider } from './providers/calendar.js';
import { WeatherProvider } from './providers/weather.js';
import { BatteriesProvider } from './providers/batteries.js';
import { MediaProvider } from './providers/media.js';
import { SystemProvider } from './providers/system.js';
import clock from './kinds/clock.js';
import calendar from './kinds/calendar.js';
import weather from './kinds/weather.js';
import batteries from './kinds/batteries.js';
import nowPlaying from './kinds/nowPlaying.js';
import system from './kinds/system.js';

/** Built-in kinds in gallery order. */
const KINDS = [clock, calendar, weather, batteries, nowPlaying, system];

class WidgetHost {
    constructor(gettext) {
        this.gettext = gettext;
        const env = { gettext };
        this.pool = new ProviderPool({
            time: () => new TimeProvider(env),
            calendar: () => new CalendarProvider(env),
            weather: () => new WeatherProvider(env),
            batteries: () => new BatteriesProvider(env),
            media: () => new MediaProvider(env),
            system: () => new SystemProvider(env),
        });
        this.registry = new WidgetRegistry();
        for (const k of KINDS)
            this.registry.register(k);
    }

    /**
     * Build a view; it is destroyed when `owner` is disposed (or its actor is destroyed).
     *
     * @param {string} kind
     * @param {{size: string, config?: object, scale?: number}} opts
     * @param {{add: Function}} [owner]
     * @returns {WidgetView}
     */
    createView(kind, opts, owner = null) {
        const def = this.registry.get(kind);
        if (!def)
            throw new Error(`Widgets: unknown kind '${kind}'`);
        const view = new WidgetView(this, def, opts);
        owner?.add(() => view.destroy());
        return view;
    }

    /** Provider ids running now (for tests and the idle check). */
    activeProviders() {
        return this.pool.active();
    }

    stop() {
        this.pool.stopAll();
    }
}

let host = null;
let refs = 0;

export const Widgets = {
    /**
     * @param {{add: Function}} cleanup the use ends when it is disposed
     * @param {(s: string) => string} gettext the extension's
     * @returns {WidgetHost}
     */
    acquire(cleanup, gettext) {
        host ??= new WidgetHost(gettext);
        refs++;
        const mine = host;
        let released = false;
        cleanup.add(() => {
            if (released)
                return;
            released = true;
            refs--;
            if (refs === 0 && host === mine) {
                host = null;
                mine.stop();
            }
        });
        return mine;
    },

    /** The running host, or null (for probes). */
    get current() {
        return host;
    },
};
