// SPDX-License-Identifier: GPL-3.0-or-later
// The Login Items page (macOS Ventura "Login Items & Extensions"): what starts at login and what may run in the background.
//
//   Open at Login             XDG autostart: ~/.config/autostart (the user's) over the system's
//                             dirs (/etc/xdg/autostart, ...); a user file of the same name wins
//   Allowed in the Background the portal permission store's `background` table, read-only here
//                             (GNOME Settings > Apps changes it)
//
// Only entries Guava wrote (X-Guava-Autostart=true, the dock's Open at Login) can be removed from
// this page; every other file belongs to the user or an app and is never touched.
//
// Pure JS (no gi imports): runs under `gjs -m` in tests.

/** The desktop-entry key that marks an autostart file as Guava's (features/dock writes it). */
export const GUAVA_MARK = 'X-Guava-Autostart';

/**
 * @typedef {object} EntryFields  what the adapter read from one .desktop file (GLib.KeyFile)
 * @property {string} fileName e.g. 'org.gnome.Calculator.desktop'
 * @property {?string} name localized Name
 * @property {?string} icon
 * @property {?string} hidden 'true' or null
 * @property {?string} gnomeEnabled X-GNOME-Autostart-enabled
 * @property {?string} guava the X-Guava-Autostart value
 * @property {string[]} onlyShowIn
 * @property {string[]} notShowIn
 */

/**
 * @typedef {object} LoginItem
 * @property {string} id the file name
 * @property {string} name
 * @property {?string} icon
 * @property {boolean} enabled starts at login in GNOME
 * @property {'user'|'system'} origin
 * @property {boolean} guava Guava wrote it
 * @property {boolean} removable Guava may delete it (its own user file only)
 */

const shownInGnome = (only, not) =>
    (only.length === 0 || only.includes('GNOME')) && !not.includes('GNOME');

/**
 * @param {EntryFields} f
 * @param {'user'|'system'} origin
 * @returns {LoginItem}
 */
export function loginItem(f, origin) {
    const guava = origin === 'user' && f.guava === 'true';
    return {
        id: f.fileName,
        name: f.name || f.fileName.replace(/\.desktop$/, ''),
        icon: f.icon || null,
        enabled: f.hidden !== 'true' && f.gnomeEnabled !== 'false' &&
            shownInGnome(f.onlyShowIn ?? [], f.notShowIn ?? []),
        origin,
        guava,
        removable: guava,
    };
}

/**
 * The effective list, XDG precedence: a user file hides the system file of the same name.
 * Sorted by name; system entries GNOME never starts (hidden or not for GNOME) are left out
 * unless a user file overrides them.
 *
 * @param {EntryFields[]} user
 * @param {EntryFields[]} system in XDG_CONFIG_DIRS order (first wins)
 * @returns {LoginItem[]}
 */
export function loginItems(user, system) {
    const byId = new Map();
    for (const f of user)
        byId.set(f.fileName, loginItem(f, 'user'));
    for (const f of system) {
        if (byId.has(f.fileName))
            continue;
        const item = loginItem(f, 'system');
        if (item.enabled)
            byId.set(f.fileName, item);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The permission store's background table as rows. Lookup('background', 'background') gives
 * {app id: ['yes'|'no'|'ask']}.
 *
 * @param {object} permissions
 * @returns {Array<{appId: string, state: 'yes'|'no'|'ask'}>}
 */
export function backgroundItems(permissions) {
    if (!permissions || typeof permissions !== 'object')
        return [];
    const rows = [];
    for (const [appId, value] of Object.entries(permissions)) {
        const state = Array.isArray(value) ? value[0] : null;
        if (appId && ['yes', 'no', 'ask'].includes(state))
            rows.push({ appId, state });
    }
    return rows.sort((a, b) => a.appId.localeCompare(b.appId));
}
