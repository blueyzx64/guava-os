// SPDX-License-Identifier: GPL-3.0-or-later
// Applications: Shell.AppSystem + Shell.AppUsage. The index is built once, lazily, and rebuilt
// when apps are installed or removed, so a keystroke only scores a few hundred short strings.
// The same records feed the Apps browse view and the apps' .desktop actions ("New Private
// Window"), which Spotlight lists as actions.

import Shell from 'gi://Shell';

import { DesktopAppInfo } from '../../../lib/compat.js';
import { rank, usageBoost } from '../model.js';

const MAX_RESULTS = 12;

export class AppsProvider {
    /**
     * @param {object} cleanup CleanupRegistry
     * @param {{hiddenIds?: string[]}} [opts] desktop ids never shown (Guava's synthetic Launchpad app)
     */
    constructor(cleanup, opts = {}) {
        this._system = Shell.AppSystem.get_default();
        this._usage = Shell.AppUsage.get_default();
        this._hidden = new Set(opts.hiddenIds ?? []);
        this._gettext = opts.gettext ?? (s => s);
        this._index = null;
        this._actions = null;
        const drop = () => {
            this._index = null;
            this._actions = null;
        };
        cleanup.connect(this._system, 'installed-changed', drop);
        cleanup.add(drop);
    }

    _build() {
        const records = [];
        const actions = [];
        for (const info of this._system.get_installed()) {
            const id = info.get_id();
            if (!id || this._hidden.has(id) || !info.should_show())
                continue;
            const desktop = info instanceof DesktopAppInfo ? info : null;
            records.push({
                id: `app:${id}`,
                kind: 'app',
                appId: id,
                title: info.get_display_name() || info.get_name(),
                subtitle: desktop?.get_generic_name() ?? '',
                keywords: [id.replace(/\.desktop$/, ''), ...(desktop?.get_keywords() ?? [])],
                gicon: info.get_icon(),
            });
            const name = info.get_display_name() || info.get_name();
            for (const action of desktop?.list_actions() ?? []) {
                const label = desktop.get_action_name(action);
                if (!label)
                    continue;
                actions.push({
                    id: `app-action:${id}:${action}`,
                    kind: 'app-action',
                    appId: id,
                    action,
                    title: label,
                    subtitle: name,
                    keywords: [name, action],
                    gicon: info.get_icon(),
                });
            }
        }
        this._index = records;
        this._actions = actions;
        return records;
    }

    /** Every app record (the Apps view), in index order. */
    all() {
        return this._index ?? this._build();
    }

    /** The apps' .desktop actions as rows. */
    desktopActions() {
        if (!this._actions)
            this._build();
        return this._actions;
    }

    /** Most used app ids, most used first. */
    mostUsedIds() {
        return this._usage.get_most_used().map(app => app.get_id());
    }

    /** The record of one app, or null (for a recent result whose app was removed). */
    lookup(appId) {
        return this.all().find(r => r.appId === appId) ?? null;
    }

    /** Run a .desktop action ("New Private Window"). */
    launchAction(item) {
        const app = this._system.lookup_app(item.appId);
        const info = app?.get_app_info();
        if (!info?.list_actions?.().includes(item.action)) {
            console.warn(`[Guava] spotlight: action ${item.action} of ${item.appId} is gone`);
            return false;
        }
        info.launch_action(item.action, global.create_app_launch_context(0, -1));
        return true;
    }

    /** Build the index now (call from an idle after enable). */
    warm() {
        this._index ??= this._build();
    }

    _usageOrder() {
        const order = new Map();
        this._usage.get_most_used().forEach((app, i) => order.set(app.get_id(), i));
        return order;
    }

    /** Ranked app rows for a query (sync, in-memory). */
    searchSync(query) {
        const records = this._index ?? this._build();
        const order = this._usageOrder();
        const boosted = records.map(r => ({ ...r, boost: usageBoost(order.get(r.appId) ?? -1) }));
        return rank(boosted, query, MAX_RESULTS);
    }

    /** Most used apps, for the empty-query suggestions. */
    recent(limit = 6) {
        const records = this._index ?? this._build();
        const byId = new Map(records.map(r => [r.appId, r]));
        const out = [];
        for (const app of this._usage.get_most_used()) {
            const rec = byId.get(app.get_id());
            if (rec)
                out.push({ ...rec });
            if (out.length >= limit)
                break;
        }
        return out;
    }

    /** Open or focus the app. */
    activate(item) {
        const app = this._system.lookup_app(item.appId);
        if (!app) {
            console.warn(`[Guava] spotlight: app ${item.appId} is gone`);
            return false;
        }
        app.activate();
        return true;
    }
}
