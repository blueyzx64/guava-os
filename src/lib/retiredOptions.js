// SPDX-License-Identifier: GPL-3.0-or-later
// Options taken out of Preferences (2026-11, the user's call) whose features stay in the code:
// Stage Manager, Guava's Control Center layout, Liquid Glass and the lock screen styling. They are
// off by default, and with no switch left a user who had turned one on could never turn it off,
// so they are reset once, at the first start after the change (`options-revision`).
// Desktop icons and widgets are not here: the desktop's right-click menu still toggles them.

export const RETIRED = ['stage-manager', 'control-center', 'liquid-glass', 'lockscreen-style'];
export const REVISION_KEY = 'options-revision';
export const REVISION = 1;

/**
 * @param {{get_int: Function, set_int: Function, reset: Function}} settings
 * @returns {string[]} the keys reset now (empty when already done)
 */
export function retireOptions(settings) {
    if (settings.get_int(REVISION_KEY) >= REVISION)
        return [];
    for (const key of RETIRED)
        settings.reset(key);
    settings.set_int(REVISION_KEY, REVISION);
    return [...RETIRED];
}
