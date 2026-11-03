// SPDX-License-Identifier: GPL-3.0-or-later
// Control Center controls pinned to the menu bar: the `menubar-pinned` contract between the
// Control Center's Edit Controls, the prefs and features/menuBarItems. Pure, no gi imports.

const N_ = s => s;

/** "Show in Menu Bar" choices (macOS: Always, When Active, Never). */
export const PIN_MODES = Object.freeze(['always', 'active', 'never']);

/**
 * Controls that can live in the menu bar, with what "active" means for each. The battery has
 * no "when active" (it is either shown or not); `percent` marks the item with a % label.
 */
export const PINNABLE = Object.freeze([
    { id: 'wifi', title: N_('Wi-Fi'), active: N_('When connected') },
    { id: 'bluetooth', title: N_('Bluetooth'), active: N_('When a device is connected') },
    { id: 'sound', title: N_('Sound'), active: N_('When not muted') },
    { id: 'battery', title: N_('Battery'), active: null },
    { id: 'focus', title: N_('Focus'), active: N_('When on') },
    { id: 'now-playing', title: N_('Now Playing'), active: N_('When playing') },
    { id: 'keyboard-brightness', title: N_('Keyboard Brightness'), active: N_('When lit') },
    { id: 'screen-recording', title: N_('Screen Recording'), active: N_('While recording') },
].map(p => Object.freeze(p)));

const PIN_IDS = new Set(PINNABLE.map(p => p.id));

/**
 * The `menubar-pinned` strv ("wifi=always") as a map; unknown ids and modes dropped. Not
 * listed = Never (the macOS default for everything GNOME's status pill already shows).
 *
 * @returns {Map<string, 'always'|'active'>}
 */
export function parsePins(strv) {
    const pins = new Map();
    for (const entry of strv ?? []) {
        const [id, mode] = String(entry).split('=');
        if (PIN_IDS.has(id) && (mode === 'always' || mode === 'active') && !pins.has(id))
            pins.set(id, PINNABLE.find(p => p.id === id).active ? mode : 'always');
    }
    return pins;
}

/** @returns {string[]} the strv with `id` set to `mode` ('never' removes it) */
export function setPin(strv, id, mode) {
    const pins = parsePins(strv);
    if (mode === 'never' || !PIN_IDS.has(id))
        pins.delete(id);
    else
        pins.set(id, mode);
    return [...pins].map(([k, v]) => `${k}=${v}`);
}

/** @returns {'always'|'active'|'never'} */
export function pinMode(strv, id) {
    return parsePins(strv).get(id) ?? 'never';
}

/** Whether a pinned item shows now. */
export function pinShown(mode, active) {
    return mode === 'always' || (mode === 'active' && !!active);
}

/** The battery item's text: macOS shows no percentage unless asked. */
export function batteryText(percent, showPercent) {
    return showPercent && Number.isFinite(percent) ? `${Math.round(percent)}%` : '';
}

