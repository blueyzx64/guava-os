// SPDX-License-Identifier: GPL-3.0-or-later
// LauncherEntry (com.canonical.Unity.LauncherEntry): the pure state. Apps send
//   Update(s app_uri, a{sv} properties)
// with app_uri "application://<desktop id>" and any of count (x), count-visible (b),
// progress (d), progress-visible (b), urgent (b). Each update merges into the app's entry;
// an entry goes away with the D-Bus name that sent it. No gi imports.
//
//   const entries = new LauncherEntries();
//   const appId = entries.update(sender, uri, props);   // null if the uri is not an app
//   entries.get(appId);                                 // {count, countVisible, ...} or null
//   entries.senderGone(sender);                         // the app ids that lost their entry

const PREFIX = 'application://';

const FIELDS = Object.freeze({
    'count': ['count', v => Number(v)],
    'count-visible': ['countVisible', v => !!v],
    'progress': ['progress', v => Number(v)],
    'progress-visible': ['progressVisible', v => !!v],
    'urgent': ['urgent', v => !!v],
});

export const EMPTY_ENTRY = Object.freeze({ count: 0, countVisible: false, progress: 0, progressVisible: false, urgent: false });

/** The desktop id of an "application://" uri, with ".desktop" added when it lacks it. */
export function appIdFromUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith(PREFIX))
        return null;
    const id = uri.slice(PREFIX.length);
    if (!id || id.includes('/'))
        return null;
    return id.endsWith('.desktop') ? id : `${id}.desktop`;
}

/** True when an entry shows nothing (no count, no progress, not urgent). */
export const isBlank = e => !e || (!e.countVisible && !e.progressVisible && !e.urgent);

export class LauncherEntries {
    constructor() {
        this._entries = new Map();   // appId -> frozen entry
        this._senders = new Map();   // sender -> Set<appId>
    }

    /**
     * @param {string} sender the D-Bus unique name
     * @param {string} uri application://...
     * @param {object} props unpacked a{sv}
     * @returns {?string} the app id whose entry changed, or null
     */
    update(sender, uri, props) {
        const appId = appIdFromUri(uri);
        if (!appId)
            return null;
        const next = { ...(this._entries.get(appId) ?? EMPTY_ENTRY) };
        for (const [key, value] of Object.entries(props ?? {})) {
            const field = FIELDS[key];
            if (field)
                next[field[0]] = field[1](value);
        }
        this._entries.set(appId, Object.freeze(next));
        if (sender) {
            let apps = this._senders.get(sender);
            if (!apps)
                this._senders.set(sender, apps = new Set());
            apps.add(appId);
        }
        return appId;
    }

    get(appId) {
        return this._entries.get(appId) ?? null;
    }

    /** Senders currently holding entries. */
    senders() {
        return [...this._senders.keys()];
    }

    /** Drop the entries of a name that left the bus. @returns {string[]} app ids */
    senderGone(sender) {
        const apps = this._senders.get(sender);
        this._senders.delete(sender);
        if (!apps)
            return [];
        const gone = [];
        for (const appId of apps) {
            const stillHeld = [...this._senders.values()].some(set => set.has(appId));
            if (!stillHeld && this._entries.delete(appId))
                gone.push(appId);
        }
        return gone;
    }

    clear() {
        this._entries.clear();
        this._senders.clear();
    }
}
