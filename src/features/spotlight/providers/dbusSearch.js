// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME search providers over D-Bus (org.gnome.Shell.SearchProvider2): files (Nautilus),
// Calendar, Contacts, Characters and so on. Spotlight never indexes anything itself.
// Every call is async, takes the search's Cancellable and has a D-Bus timeout. Only Gio and
// GLib here (no Shell imports), so tests/spotlightDbus.test.js can run it against a fake
// provider on a private bus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    SEARCH_PROVIDER_IFACE, NAUTILUS_DESKTOP_ID, parseProviderIni, selectProviders, normalizeMeta,
    externalScore, pickIds,
} from '../providerInfo.js';
import { DesktopAppInfo } from '../../../lib/gioCompat.js';
import { normalize } from '../model.js';

const PROVIDER_DIR = 'gnome-shell/search-providers';
const SEARCH_SCHEMA = 'org.gnome.desktop.search-providers';
const CALL_TIMEOUT_MS = 1500;
const MAX_IDS = 8;

function callAsync(connection, info, method, params, replyType, cancellable, timeoutMs) {
    return new Promise((resolve, reject) => {
        connection.call(info.busName, info.objectPath, SEARCH_PROVIDER_IFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE,
            timeoutMs, cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function readFileAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                resolve(new TextDecoder().decode(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function listDirAsync(dir, cancellable) {
    return new Promise((resolve, reject) => {
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (d, res) => {
                try {
                    resolve(d.enumerate_children_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    }).then(enumerator => new Promise((resolve, reject) => {
        const names = [];
        const next = () => enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable, (en, res) => {
            try {
                const infos = en.next_files_finish(res);
                if (infos.length === 0) {
                    en.close_async(GLib.PRIORITY_DEFAULT, null, null);
                    resolve(names);
                    return;
                }
                for (const i of infos)
                    names.push(i.get_name());
                next();
            } catch (e) {
                reject(e);
            }
        });
        next();
    }));
}

/** Unpack one a{sv} meta into a plain object. Icon variants are kept for the glue below. */
function unpackMeta(dict) {
    const out = {};
    const str = v => (v?.is_of_type(new GLib.VariantType('s')) ? v.get_string()[0] : undefined);
    const raw = dict.deepUnpack();
    out.id = str(raw.id);
    out.name = str(raw.name);
    out.description = str(raw.description);
    out.clipboardText = str(raw.clipboardText);
    out.icon = raw.icon;        // serialised GIcon (Variant), or undefined
    out.gicon = str(raw.gicon); // older providers: icon string
    return out;
}

function iconFor(meta, fallbackGicon) {
    try {
        if (meta.icon)
            return Gio.icon_deserialize(meta.icon) ?? fallbackGicon;
        if (meta.gicon)
            return Gio.Icon.new_for_string(meta.gicon);
    } catch (e) {
        // bad icon from a provider: use the app icon
    }
    return fallbackGicon;
}

export class DBusSearch {
    /**
     * @param {{connection?:Gio.DBusConnection, searchSettings?:Gio.Settings|null}} [opts]
     */
    constructor(opts = {}) {
        this._connection = opts.connection ?? Gio.DBus.session;
        this._searchSettings = opts.searchSettings === undefined
            ? DBusSearch._openSearchSettings() : opts.searchSettings;
        this._dirs = opts.dirs ?? null;
        this._lookupApp = opts.lookupApp ?? (id => DesktopAppInfo.new(id));
        this._infos = null;
        this._loading = null;
    }

    static _openSearchSettings() {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(SEARCH_SCHEMA, true);
        return schema ? new Gio.Settings({ settings_schema: schema }) : null;
    }

    /** Read the provider .ini files. Async; safe to call twice (shares one load). */
    load(cancellable = null) {
        this._loading ??= this._load(cancellable).catch(e => {
            this._loading = null;
            throw e;
        });
        return this._loading;
    }

    /** Forget the cache (call when XDG data changes, e.g. an app was installed). */
    reset() {
        this._infos = null;
        this._loading = null;
    }

    async _load(cancellable) {
        const dirs = this._dirs ?? [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
            .map(d => GLib.build_filenamev([d, PROVIDER_DIR]));
        const infos = [];
        for (const path of dirs) {
            const dir = Gio.File.new_for_path(path);
            let names;
            try {
                names = await listDirAsync(dir, cancellable);
            } catch (e) {
                continue; // directory missing is normal
            }
            for (const name of names.filter(n => n.endsWith('.ini')).sort()) {
                try {
                    const text = await readFileAsync(dir.get_child(name), cancellable);
                    const info = parseProviderIni(text);
                    if (info && this._lookupApp(info.desktopId))
                        infos.push(info);
                } catch (e) {
                    // unreadable file: skip it
                }
            }
        }
        this._infos = infos;
        return infos;
    }

    _prefs(skip) {
        const s = this._searchSettings;
        return {
            disabled: s?.get_strv('disabled') ?? [],
            enabled: s?.get_strv('enabled') ?? [],
            sortOrder: s?.get_strv('sort-order') ?? [],
            disableExternal: s?.get_boolean('disable-external') ?? false,
            skip,
        };
    }

    /**
     * Providers for a SearchSession, given what the user turned on in Spotlight.
     * Call after load().
     * @param {{files:boolean}} opts `files` false drops the Nautilus provider
     */
    sessionProviders({ files }) {
        const infos = selectProviders(this._infos ?? [], this._prefs(files ? [] : [NAUTILUS_DESKTOP_ID]));
        return infos.map(info => this._wrap(info));
    }

    _wrap(info) {
        const appInfo = this._lookupApp(info.desktopId);
        const isFiles = info.desktopId === NAUTILUS_DESKTOP_ID;
        const appName = appInfo?.get_name() ?? info.busName;
        const appIcon = appInfo?.get_icon() ?? null;
        return {
            id: `dbus:${info.busName}`,
            timeoutMs: 1800,
            search: async (query, cancellable) => {
                const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
                if (terms.length === 0)
                    return [];
                const idsReply = await callAsync(this._connection, info, 'GetInitialResultSet',
                    new GLib.Variant('(as)', [terms]), '(as)', cancellable, CALL_TIMEOUT_MS);
                const ids = pickIds(idsReply.deepUnpack()[0], MAX_IDS);
                if (ids.length === 0 || cancellable?.is_cancelled())
                    return [];
                const metasReply = await callAsync(this._connection, info, 'GetResultMetas',
                    new GLib.Variant('(as)', [ids]), '(aa{sv})', cancellable, CALL_TIMEOUT_MS);
                const metas = metasReply.get_child_value(0);
                const items = [];
                const q = normalize(query);
                const n = metas.n_children();
                for (let i = 0; i < n; i++) {
                    const meta = unpackMeta(metas.get_child_value(i));
                    const row = normalizeMeta(meta);
                    if (!row)
                        continue;
                    items.push({
                        id: `${info.busName}:${row.id}`,
                        kind: isFiles ? 'file' : 'external',
                        group: isFiles ? 'documents' : 'other',
                        title: row.title,
                        subtitle: isFiles ? row.subtitle : (row.subtitle || appName),
                        gicon: iconFor(meta, appIcon),
                        score: externalScore(items.length, normalize(row.title) === q),
                        clipboardText: row.clipboardText,
                        // Files' ids are file:// URIs: Quick Look and the recent list use them
                        uri: isFiles && row.id.startsWith('file://') ? row.id : undefined,
                        source: { info, resultId: row.id, terms },
                    });
                }
                return items;
            },
        };
    }

    /** Open a result in its app. */
    activate(item, timestamp = 0) {
        const { info, resultId, terms } = item.source;
        return callAsync(this._connection, info, 'ActivateResult',
            new GLib.Variant('(sasu)', [resultId, terms, timestamp]), null, null, CALL_TIMEOUT_MS);
    }
}
