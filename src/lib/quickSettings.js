// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Settings is built asynchronously (QuickSettings._setupIndicators awaits its items), so
// a feature started with the Shell may find it half done. Every feature that reaches into it
// waits here, in one bounded way.
//
// Private Shell API: quickSettings._backgroundApps (the last field _setupIndicators assigns),
// ._system, .menu._grid (GNOME 48-51); stockKeys() reads the indicator fields listed in
// features/controlCenter/shell.js (the Control Center and the pinned menu bar controls).

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WAIT_MS = 200;
const WAIT_ATTEMPTS = 50; // 10 s

/** The Quick Settings panel button once its built-in items exist, else null. */
export function readyQuickSettings() {
    const qs = Main.panel.statusArea.quickSettings;
    return qs?._backgroundApps && qs._system && qs.menu?._grid ? qs : null;
}

/**
 * Call fn(quickSettings) once Quick Settings is complete: now, or from a bounded retry that
 * the cleanup cancels.
 *
 * @param {CleanupRegistry} cleanup
 * @param {(qs: object) => void} fn
 * @param {string} name for the log and the source name
 */
export function whenQuickSettingsReady(cleanup, fn, name) {
    const qs = readyQuickSettings();
    if (qs) {
        fn(qs);
        return;
    }
    let attempts = 0;
    cleanup.timeout(WAIT_MS, () => {
        const ready = readyQuickSettings();
        if (ready) {
            fn(ready);
            return GLib.SOURCE_REMOVE;
        }
        if (++attempts >= WAIT_ATTEMPTS) {
            console.error(`[Guava] ${name}: Quick Settings never finished building`);
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }, { name: `${name} waits for Quick Settings` });
}

/**
 * The stock Quick Settings items by the Control Center's model key (features/controlCenter/
 * model.js STOCK), shared with the menu bar's pinned controls.
 *
 * @returns {Map<Clutter.Actor, string>} stock item actor -> model key
 */
export function stockKeys(qs) {
    const keys = new Map();
    const tag = (key, items) => {
        for (const item of items ?? []) {
            if (item)
                keys.set(item, key);
        }
    };
    const items = indicator => indicator?.quickSettingsItems;

    const net = qs._network;
    tag('wifi', [net?._wirelessToggle]);
    tag('wired', [net?._wiredToggle]);
    tag('modem', [net?._modemToggle]);
    tag('bt-tether', [net?._btToggle]);
    tag('vpn', [net?._vpnToggle]);
    tag('bluetooth', items(qs._bluetooth));
    tag('dnd', items(qs._doNotDisturb));
    tag('brightness', items(qs._brightness));
    tag('backlight', items(qs._backlight));
    tag('volume-out', items(qs._volumeOutput));
    tag('volume-in', items(qs._volumeInput));
    tag('dark-style', items(qs._darkMode));
    tag('night-light', items(qs._nightLight));
    tag('power-saver', items(qs._powerProfiles));
    tag('rotation', items(qs._autoRotate));
    tag('airplane', items(qs._rfkill));
    tag('location', items(qs._location));
    tag('camera', items(qs._camera));
    tag('remote-access', items(qs._remoteAccess));
    tag('thunderbolt', items(qs._thunderbolt));
    tag('unsafe', items(qs._unsafeMode));
    tag('background-apps', items(qs._backgroundApps));
    tag('system', items(qs._system));
    return keys;
}
