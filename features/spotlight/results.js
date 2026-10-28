// SPDX-License-Identifier: GPL-3.0-or-later
// What Spotlight shows for a parsed query, an empty field or a browse view. It asks the
// providers and returns sections (model.js shape); index.js owns the modal, the flow and the
// activation. Providers that talk to other processes are returned as SearchSession providers.
//
//   const results = new Results({ ks, gettext, apps, settings, clipboard, actions, files, menus });
//   results.local(parsed)        -> {group: items[]} answered from memory
//   results.external(parsed)     -> SearchSession providers (D-Bus search providers, LocalSearch, menus)
//   results.empty()              -> sections for the empty field (recents, history, suggestions)
//   await results.view('files')  -> sections for a browse view

import Shell from 'gi://Shell';

import { evaluateQuery } from './calculator.js';
import { looksLikeUrl, rank, webSearchUrl } from './model.js';
import {
    appsBrowse, decodeRecent, parseQuickKeys, quickKeyHit,
} from './queryModel.js';

const QUICK_KEY_SCORE = 2000;
const FILTERED_LIMIT = 40;
const VIEW_FILES = 30;
const VIEW_CLIPS = 30;
const MENU_RESULTS = 6;
const FILE_RESULTS = 8;

function note(id, title, subtitle, iconName) {
    return { id: 'note', items: [{ id: `note:${id}`, kind: 'note', title, subtitle, iconName }] };
}

export class Results {
    /**
     * @param {object} p
     * @param {object} p.ks GuavaSettings
     * @param {Function} p.gettext
     * @param {object} p.apps AppsProvider
     * @param {object} p.settings SettingsProvider
     * @param {object} p.clipboard ClipboardProvider
     * @param {object} p.actions ActionsProvider
     * @param {object} p.files LocalSearch
     * @param {object} p.dbus DBusSearch (GNOME search providers)
     * @param {() => ?object} p.menus the running menu bar feature (menuItems()), or null
     */
    constructor(p) {
        Object.assign(this, { _ks: p.ks, _: p.gettext, _apps: p.apps, _settings: p.settings,
            _clipboard: p.clipboard, _actions: p.actions, _files: p.files, _dbus: p.dbus,
            _menus: p.menus });
    }

    /** Capabilities the "/" filters need ('files', 'clipboard', 'menu'). */
    available() {
        const out = new Set();
        const ks = this._ks;
        if (ks.bool('spotlight-files'))
            out.add('files');
        if (ks.bool('spotlight-clipboard') && this._clipboard.available)
            out.add('clipboard');
        if (ks.bool('spotlight-menu-items') && typeof this._menus()?.menuItems === 'function')
            out.add('menu');
        return out;
    }

    /** Row limits: a filter shows many rows of its own kind. */
    limits(parsed) {
        const out = { web: 2 };
        for (const g of parsed.filter?.groups ?? [])
            out[g] = FILTERED_LIMIT;
        return out;
    }

    // ---- searching ------------------------------------------------------------------------

    /** Results answered in memory, by group. */
    local(parsed) {
        const { text, filter } = parsed;
        const ks = this._ks;
        const want = g => !filter || filter.groups.includes(g);
        const byGroup = {};
        if (want('apps'))
            byGroup.apps = this._apps.searchSync(text);
        if (want('actions') && (filter || (text && ks.bool('spotlight-actions'))))
            byGroup.actions = this._actions.searchSync(text);
        if (want('settings') && ks.bool('spotlight-settings'))
            byGroup.settings = this._settings.searchSync(text);
        if (want('clipboard') && ks.bool('spotlight-clipboard'))
            byGroup.clipboard = filter && !text ? this._clipboard.recent(FILTERED_LIMIT) : this._clipboard.searchSync(text);
        if (filter || !text)
            return byGroup;

        this._addQuickKeys(byGroup, text);
        if (ks.bool('spotlight-calculator')) {
            const result = evaluateQuery(text);
            if (result) {
                byGroup.calculator = [{
                    id: 'calc', kind: 'calc', title: result.text, subtitle: `${result.expression} =`,
                    iconName: 'accessories-calculator-symbolic', score: 1000, copyText: result.text,
                }];
            }
        }
        if (ks.bool('spotlight-web'))
            byGroup.web = this._web(text);
        return byGroup;
    }

    _addQuickKeys(byGroup, text) {
        const hit = quickKeyHit(parseQuickKeys(this._ks.strv('spotlight-quick-keys')), text);
        if (!hit)
            return;
        for (const target of hit.targets) {
            const [type, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
            const item = type === 'app' ? this._apps.lookup(id) : this._actions.itemFor(id, hit.args);
            if (!item)
                continue;
            const group = type === 'app' ? 'apps' : 'actions';
            const row = { ...item, score: QUICK_KEY_SCORE, quickKey: hit.alias };
            byGroup[group] = [row, ...(byGroup[group] ?? []).filter(x => x.id !== row.id)];
        }
    }

    _web(q) {
        const _ = this._;
        const out = [];
        if (looksLikeUrl(q)) {
            const url = /^https?:\/\//i.test(q) ? q : `https://${q}`;
            out.push({
                id: 'web-open', kind: 'web', title: `${_('Open')} ${q}`, subtitle: url,
                iconName: 'web-browser-symbolic', score: 0, url,
            });
        }
        const url = webSearchUrl(this._ks.string('spotlight-engine'), q);
        if (url) {
            out.push({
                id: 'web-search', kind: 'web', title: `${_('Search the web for')} “${q}”`,
                subtitle: _('Web'), iconName: 'system-search-symbolic', score: 0, url,
            });
        }
        return out;
    }

    /** Providers that answer later (other processes). Call after dbus.load(). */
    external(parsed) {
        const { filter } = parsed;
        const available = this.available();
        const providers = [];
        const files = available.has('files');
        // Files come from LocalSearch directly while it answers; GNOME's Files search provider
        // (which asks LocalSearch too) is the fallback, so a file never shows twice
        const direct = files && this._files.reachable !== false;
        if (filter?.files || (!filter && parsed.text && direct))
            providers.push(this._filesProvider(parsed));
        if ((!filter || filter.id === 'menu') && available.has('menu') && (filter || parsed.text))
            providers.push(this._menuProvider());
        if (!filter && parsed.text)
            providers.push(...this._dbus.sessionProviders({ files: files && !direct }));
        return providers;
    }

    _filesProvider(parsed) {
        return {
            id: 'localsearch',
            timeoutMs: 2500,
            search: (_q, cancellable) => this._files.search({
                text: parsed.text, filter: parsed.filter, limit: parsed.filter ? FILTERED_LIMIT : FILE_RESULTS,
            }, cancellable),
        };
    }

    _menuProvider() {
        return {
            id: 'menus',
            timeoutMs: 2500,
            search: async query => {
                const found = await this._menus()?.menuItems();
                if (!found)
                    return [];
                // The focused app's own icon, so a row reads as "in that app's menu"
                const gicon = Shell.WindowTracker.get_default().focus_app?.get_icon() ?? null;
                const rows = found.entries.map(e => ({
                    id: `menu:${e.path}:${e.label}`, kind: 'menu', title: e.label,
                    subtitle: `${e.path}`, gicon, iconName: 'open-menu-symbolic', run: e.run,
                }));
                const ranked = rank(rows, query, query ? MENU_RESULTS : FILTERED_LIMIT);
                // A menu item is never the top hit over an app or file with the same score
                return ranked.map(r => ({ ...r, score: Math.min(r.score, 700) }));
            },
        };
    }

    // ---- the empty field --------------------------------------------------------------------

    /** Recent results and searches, as rows. */
    history() {
        const ks = this._ks;
        if (!ks.bool('spotlight-history'))
            return { recent: [], history: [] };
        const recent = ks.strv('spotlight-recent-results').map(decodeRecent).filter(Boolean)
            .map(r => this._resolveRecent(r)).filter(Boolean);
        const history = ks.strv('spotlight-history-queries').map(q => ({
            id: `history:${q}`, kind: 'history', title: q, query: q,
            iconName: 'document-open-recent-symbolic',
        }));
        return { recent, history };
    }

    _resolveRecent(r) {
        switch (r.kind) {
        case 'app':
            return this._apps.lookup(r.id.replace(/^app:/, ''));
        case 'file':
            return this._files.itemFor(r);
        case 'command': {
            const [, actionId, seconds] = r.id.split(':');
            return this._actions.itemFor(actionId, seconds ? `${seconds}s` : '');
        }
        case 'app-action':
            return this._apps.desktopActions().find(a => a.id === r.id) ?? null;
        case 'setting':
            return this._settings.all().find(s => s.id === r.id) ?? null;
        default:
            return null;
        }
    }

    // ---- browse views -------------------------------------------------------------------------

    /** Sections for one browse view. Files is async (LocalSearch). */
    async view(id, cancellable) {
        const _ = this._;
        switch (id) {
        case 'apps':
            return appsBrowse(this._apps.all(), this._apps.mostUsedIds());
        case 'files': {
            if (!this._ks.bool('spotlight-files'))
                return [note('files-off', _('Files are turned off'), _('Turn on Files and documents in Guava’s Spotlight settings'), 'folder-symbolic')];
            let items;
            try {
                items = await this._files.search({ text: '', limit: VIEW_FILES }, cancellable);
            } catch (e) {
                if (cancellable?.is_cancelled())
                    return [];
                return [note('files-none', _('File search is not available'), _('GNOME’s file indexer (LocalSearch) is not running'), 'folder-symbolic')];
            }
            return items.length > 0 ? [{ id: 'recent-files', items }]
                : [note('files-empty', _('No recent files'), _('Files you change appear here'), 'folder-symbolic')];
        }
        case 'actions': {
            const appActions = [...this._apps.desktopActions()]
                .sort((a, b) => a.subtitle.localeCompare(b.subtitle) || a.title.localeCompare(b.title));
            const sections = [{ id: 'guava-actions', items: this._actions.guavaItems() }];
            if (appActions.length > 0)
                sections.push({ id: 'app-actions', items: appActions });
            if (this._ks.bool('spotlight-settings'))
                sections.push({ id: 'settings', items: this._settings.all().filter(s => s.kind === 'setting') });
            return sections;
        }
        case 'clipboard': {
            if (!this._ks.bool('spotlight-clipboard') || !this._clipboard.available)
                return [note('clip-off', _('Clipboard history is off'), _('Turn on Clipboard history in Guava Settings to see what you copied'), 'edit-paste-symbolic')];
            const clips = this._clipboard.recent(VIEW_CLIPS);
            return clips.length > 0 ? [{ id: 'clipboard', items: clips }]
                : [note('clip-empty', _('Nothing copied yet'), _('Text and images you copy appear here'), 'edit-paste-symbolic')];
        }
        default:
            return [];
        }
    }
}
