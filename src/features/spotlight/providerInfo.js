// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for GNOME search providers (org.gnome.Shell.SearchProvider2): parse the
// *.ini files in /usr/share/gnome-shell/search-providers, apply the user's search settings
// (org.gnome.desktop.search-providers) and normalise result metas. No gi imports.

export const SEARCH_PROVIDER_IFACE = 'org.gnome.Shell.SearchProvider2';
export const NAUTILUS_DESKTOP_ID = 'org.gnome.Nautilus.desktop';

const GROUP = 'Shell Search Provider';
// D-Bus names and object paths come from files on disk; check them before any call.
const BUS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const OBJECT_PATH_RE = /^\/([A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*)?$/;

/**
 * Parse one provider .ini file.
 * @param {string} text file contents
 * @returns {{desktopId:string, busName:string, objectPath:string, version:number,
 *            defaultDisabled:boolean}|null} null when invalid or not version 2+
 */
export function parseProviderIni(text) {
    if (typeof text !== 'string' || text.length > 8192)
        return null;
    let inGroup = false;
    const kv = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';'))
            continue;
        if (line.startsWith('[')) {
            inGroup = line === `[${GROUP}]`;
            continue;
        }
        if (!inGroup)
            continue;
        const eq = line.indexOf('=');
        if (eq > 0)
            kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    const { DesktopId: desktopId, BusName: busName, ObjectPath: objectPath } = kv;
    const version = Number.parseInt(kv.Version ?? '', 10);
    if (!desktopId || !desktopId.endsWith('.desktop') || !BUS_NAME_RE.test(busName ?? '') ||
        !OBJECT_PATH_RE.test(objectPath ?? '') || !(version >= 2))
        return null;
    return {
        desktopId, busName, objectPath, version,
        defaultDisabled: (kv.DefaultDisabled ?? '').toLowerCase() === 'true',
    };
}

/**
 * Pick and order providers the way GNOME Settings > Search does.
 * @param {Array<object>} infos parsed ini entries (duplicates by desktopId: first wins)
 * @param {{disabled?:string[], enabled?:string[], sortOrder?:string[], disableExternal?:boolean,
 *          skip?:string[]}} prefs
 */
export function selectProviders(infos, prefs = {}) {
    const disabled = new Set(prefs.disabled ?? []);
    const enabled = new Set(prefs.enabled ?? []);
    const skip = new Set(prefs.skip ?? []);
    if (prefs.disableExternal)
        return [];
    const seen = new Set();
    const out = [];
    for (const info of infos) {
        if (!info || seen.has(info.desktopId))
            continue;
        seen.add(info.desktopId);
        if (skip.has(info.desktopId) || disabled.has(info.desktopId))
            continue;
        if (info.defaultDisabled && !enabled.has(info.desktopId))
            continue;
        out.push(info);
    }
    const order = prefs.sortOrder ?? [];
    const rankOf = info => {
        const i = order.indexOf(info.desktopId);
        return i < 0 ? order.length : i;
    };
    return out.map((info, i) => ({ info, i }))
        .sort((a, b) => rankOf(a.info) - rankOf(b.info) || a.i - b.i)
        .map(x => x.info);
}

/**
 * Turn an unpacked GetResultMetas entry (plain object) into a row. `icon` strings from the
 * provider are a serialised GIcon; the glue turns it into an icon. Missing name = dropped.
 * @returns {{id:string, title:string, subtitle:string, iconString:string|null,
 *            iconData:*|null, clipboardText:string|null}|null}
 */
export function normalizeMeta(meta) {
    if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !meta.name)
        return null;
    return {
        id: meta.id,
        title: meta.name.slice(0, 300),
        subtitle: typeof meta.description === 'string' ? meta.description.slice(0, 300) : '',
        iconString: typeof meta.icon === 'string' ? meta.icon : null,
        iconData: meta['icon-data'] ?? null,
        clipboardText: typeof meta.clipboardText === 'string' ? meta.clipboardText : null,
    };
}

/**
 * Score for provider-ranked results: the provider's own order is kept, earlier is better.
 * Between the weak-match floor and below the top-hit threshold so a file never beats an app
 * for the top hit unless the provider has it first with an exact title.
 */
export function externalScore(index, exactTitle = false) {
    return (exactTitle ? 700 : 350) - Math.min(index, 40) * 5;
}

/** Limit how many ids are asked for as metas. */
export function pickIds(ids, max = 8) {
    return Array.isArray(ids) ? ids.filter(x => typeof x === 'string').slice(0, max) : [];
}
