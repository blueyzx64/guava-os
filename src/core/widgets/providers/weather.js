// SPDX-License-Identifier: GPL-3.0-or-later
// Weather data from the Shell's own weather client: the one the date menu holds, so the
// location comes from GNOME Weather's settings exactly as the Shell does, and Guava adds no
// second GWeather fetcher or geolocation request.
//
// Shell API: js/misc/weather.js WeatherClient ('changed', available, hasLocation, loading,
// info, update(), activateApp()), reached through Main.panel.statusArea.dateMenu
// ._weatherItem._weatherClient (private, 48-51). WeatherClient has no destroy(), which is why
// Guava borrows it instead of creating one.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Provider } from './base.js';

const FORECASTS = 5;

export function shellWeatherClient() {
    return Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
}

function forecasts(info) {
    const out = [];
    const now = Date.now() / 1000;
    for (const f of info.get_forecast_list?.() ?? []) {
        const [ok, stamp] = f.get_value_update();
        if (!ok || stamp < now - 1800)
            continue;
        out.push({ time: stamp, temp: f.get_temp_summary(), icon: f.get_symbolic_icon_name() });
        if (out.length === FORECASTS)
            break;
    }
    return out;
}

export class WeatherProvider extends Provider {
    initial() {
        return { state: 'unavailable' };
    }

    run(cleanup) {
        const client = shellWeatherClient();
        this._client = client;
        cleanup.add(() => {
            this._client = null;
        });
        if (!client) {
            this.publish({ state: 'unavailable' });
            return;
        }
        const id = client.connect('changed', () => this._read());
        cleanup.add(() => client.disconnect(id));
        client.update();
        this._read();
    }

    /** Open GNOME Weather (the widget's click). */
    open() {
        this._client?.activateApp();
    }

    _read() {
        const c = this._client;
        if (!c)
            return;
        const info = c.info;
        let state = 'ready';
        if (!c.available)
            state = 'unavailable';
        else if (!c.hasLocation)
            state = 'no-location';
        else if (!info.is_valid())
            state = c.loading ? 'loading' : 'offline';
        if (state !== 'ready') {
            this.publish({ state });
            return;
        }
        this.publish({
            state,
            location: info.get_location_name(),
            temp: info.get_temp_summary(),
            summary: info.get_conditions() !== '-' ? info.get_conditions() : info.get_sky(),
            icon: info.get_symbolic_icon_name(),
            forecasts: forecasts(info),
        });
    }
}
