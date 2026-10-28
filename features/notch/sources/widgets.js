// SPDX-License-Identifier: GPL-3.0-or-later
// State for the Widgets tab that lives in the Shell: the microphone (the Shell's mixer
// control, js/ui/status/volume.js getMixerControl, GNOME 45-51) and the weather the date menu
// already fetches (its WeatherSection's WeatherClient: private `_weatherItem._weatherClient`
// in js/ui/dateMenu.js, checked on 48-51). Guava never starts a second weather client, so no
// extra location or network requests. Both are read on signals only.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';

/**
 * @param {CleanupRegistry} cleanup
 * @param {() => void} onChange called when mic() or weather() may have changed
 * @returns {{mic: () => {available: boolean, muted: boolean}, toggleMic: () => void,
 *   weather: () => object|null, openWeather: () => void}}
 */
export function watchWidgets(cleanup, onChange) {
    const control = getMixerControl();
    let stream = null;
    let streamId = 0;
    const dropStream = () => {
        if (stream && streamId)
            stream.disconnect(streamId);
        stream = null;
        streamId = 0;
    };
    const follow = () => {
        dropStream();
        stream = control?.get_default_source?.() ?? null;
        if (stream)
            streamId = stream.connect('notify::is-muted', onChange);
        onChange();
    };
    if (control) {
        cleanup.connect(control, 'default-source-changed', follow);
        cleanup.connect(control, 'state-changed', follow);
    }
    cleanup.add(dropStream);
    follow();

    const client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
    if (client?.connect) {
        const id = client.connect('changed', onChange);
        cleanup.add(() => client.disconnect(id));
    }

    return {
        mic: () => ({ available: !!stream, muted: !!stream?.is_muted }),
        toggleMic: () => stream?.change_is_muted(!stream.is_muted),
        weather: () => {
            if (!client?.available || !client.hasLocation)
                return null;
            const info = client.info;
            if (!info?.is_valid?.())
                return { loading: !!client.loading };
            return {
                temp: info.get_temp_summary?.() ?? '',
                icon: info.get_symbolic_icon_name?.() ?? 'weather-overcast-symbolic',
                location: info.get_location_name?.() ?? '',
                summary: info.get_sky?.() || info.get_weather_summary?.() || '',
            };
        },
        openWeather: () => client?.activateApp?.(),
    };
}
