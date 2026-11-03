// SPDX-License-Identifier: GPL-3.0-or-later
// Background apps: the pure part. xdg-desktop-portal's Background portal publishes the apps
// that run without a window as org.freedesktop.background.Monitor BackgroundApps (aa{sv}, each
// with app_id, and optionally instance and message); GNOME's Quick Settings list the same.

/**
 * Desktop ids of the listed apps, in order, without duplicates.
 *
 * @param {object[]} list unpacked BackgroundApps
 * @returns {string[]}
 */
export function backgroundAppIds(list) {
    const out = [];
    for (const entry of Array.isArray(list) ? list : []) {
        const id = typeof entry?.app_id === 'string' ? entry.app_id.trim() : '';
        if (!id || id.includes('/'))
            continue;
        const desktopId = id.endsWith('.desktop') ? id : `${id}.desktop`;
        if (!out.includes(desktopId))
            out.push(desktopId);
    }
    return out;
}

/** The D-Bus name and object path a GApplication exports for a desktop id. */
export function gApplicationPath(desktopId) {
    const name = desktopId.replace(/\.desktop$/, '');
    return { name, path: `/${name.replace(/\./g, '/').replace(/-/g, '_')}` };
}
