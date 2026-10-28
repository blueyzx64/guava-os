// SPDX-License-Identifier: GPL-3.0-or-later
// Low Power Mode (macOS Monterey): separate choices for
// "On battery" and "On power adapter", applied through power-profiles-daemon. Pure.

export const PROFILE = 'power-saver';

/**
 * Whether Low Power Mode applies right now.
 *
 * @param {{onBattery: boolean, battery: boolean, adapter: boolean, hasBattery?: boolean}} s
 *   battery/adapter: the user's two choices; hasBattery false (a desktop) counts as on the
 *   power adapter
 * @returns {boolean}
 */
export function lowPowerWanted({ onBattery, battery, adapter, hasBattery = true }) {
    return hasBattery && onBattery ? !!battery : !!adapter;
}

/**
 * What the Control Center's Low Power Mode control changes: the choice of the power source
 * in use, as on macOS where the switch follows the current source.
 *
 * @returns {{key: 'low-power-battery'|'low-power-adapter', value: boolean}}
 */
export function lowPowerToggle(state) {
    const onBattery = state.hasBattery !== false && state.onBattery;
    const key = onBattery ? 'low-power-battery' : 'low-power-adapter';
    return { key, value: !(onBattery ? state.battery : state.adapter) };
}

/**
 * The next step for the daemon: hold the power-saver profile, release the hold, or nothing.
 *
 * @param {boolean} wanted
 * @param {boolean} holding a hold cookie is held (or being requested)
 * @returns {'hold'|'release'|null}
 */
export function holdAction(wanted, holding) {
    if (wanted && !holding)
        return 'hold';
    if (!wanted && holding)
        return 'release';
    return null;
}

/**
 * Battery health from UPower's battery device, or null when it reports nothing usable.
 * macOS calls a battery under 80 % of its design capacity "Service Recommended".
 *
 * @param {{capacity?: number, energyFull?: number, energyFullDesign?: number,
 *   cycles?: number}} dev UPower Capacity (%), EnergyFull, EnergyFullDesign (Wh),
 *   ChargeCycles (-1 or 0 = unknown)
 * @returns {?{percent: number, cycles: ?number, condition: 'normal'|'service'}}
 */
export function batteryHealth({ capacity = 0, energyFull = 0, energyFullDesign = 0, cycles = -1 } = {}) {
    let percent = capacity > 0 ? capacity : 0;
    if (!percent && energyFull > 0 && energyFullDesign > 0)
        percent = (energyFull / energyFullDesign) * 100;
    if (!(percent > 0))
        return null;
    percent = Math.min(100, Math.round(percent));
    return {
        percent,
        cycles: cycles > 0 ? cycles : null,
        condition: percent < 80 ? 'service' : 'normal',
    };
}
