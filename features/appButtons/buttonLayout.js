// SPDX-License-Identifier: GPL-3.0-or-later
// Owns org.gnome.desktop.wm.preferences button-layout, so every titlebar follows Guava: GTK 3,
// GTK 4 and libadwaita, Chromium/Electron (GTK titlebar) and Mutter's server-side frames.
// AppButtonsFeature (appButtons.js) is its one user: the apps' own buttons on the chosen side
// (appButtonsLayout).
//
// The user's own layout is kept by core/originals.js (crash-safe: restored at the next start
// if a session ended without giving it back).
//
// No gi imports: the settings objects are passed in (Gio.Settings in the Shell, fakes in tests).

import { SettingOwner } from '../../core/originals.js';

export const WM_SCHEMA = 'org.gnome.desktop.wm.preferences';
const WM_KEY = 'button-layout';

export class ButtonLayoutOwner extends SettingOwner {
    /**
     * @param {import('../../core/originals.js').OriginalsStore} store ctx.originals
     * @param {object} wmSettings Gio.Settings of org.gnome.desktop.wm.preferences
     * @param {() => void} onOriginalChanged the user changed the layout while Guava owns it
     * @param {(original: string) => string} transform the layout Guava sets for a given original
     */
    constructor(store, wmSettings, onOriginalChanged, transform) {
        super(store, wmSettings, WM_KEY, { type: 's', transform, onOriginalChanged });
    }
}
