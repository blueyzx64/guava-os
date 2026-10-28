// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight: a centred glass search bar. A Super tap opens it (it takes over the Shell's
// overlay-key from the Activities overview), and an optional extra shortcut opens it too.
//
// Layers:
//   model.js, queryModel.js, actionsModel.js,
//   calculator.js, providerInfo.js             pure, unit-tested
//   providers/*.js                             adapters to Shell, Gio, D-Bus and LocalSearch
//   results.js                                 what to show for a query, the empty field or a view
//   view.js                                    St widgets inside lib/modalSurface.js
//   index.js (this file)                       wiring: settings, shortcuts, search flow, activation
//
// Tahoe features: browse views (Super+1..4), "/" filters, Actions with typed parameters, Quick
// Keys, search history, Quick Look (Space, through Sushi) and the focused app's menu items
// (Tab scopes to them; they come from the menu bar feature while it runs).
//
// It does not route through Main.overview search, so skipOverviewOnLogin and
// focusOnOverviewExit never see it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Keybindings, MODAL_MODES } from '../../lib/keybindings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { ModalSurface } from '../../lib/modalSurface.js';

import { SearchSession, buildEmptySections, buildSections } from './model.js';
import {
    filterById, filterText, historyStep, parseQuery, pushHistory, pushRecent, toggleView,
} from './queryModel.js';
import { OverlayKeyTakeover } from './overlayKey.js';
import { ActionsProvider } from './providers/actions.js';
import { AppsProvider } from './providers/apps.js';
import { ClipboardProvider } from './providers/clipboard.js';
import { DBusSearch } from './providers/dbusSearch.js';
import { LocalSearch } from './providers/localSearch.js';
import { QuickLook } from './providers/quickLook.js';
import { SettingsProvider } from './providers/settings.js';
import { Results } from './results.js';
import { SpotlightView } from './view.js';

const LOG = '[Guava] spotlight:';
const LAUNCHPAD_DESKTOP_ID = 'org.gnome.Shell.Extensions.Guava.Launchpad.desktop';
const EXTERNAL_DEBOUNCE_MS = 80;
const WIDTH = 680;
const OFFSET_TOP = 140;
const RADIUS = 26;

export class SpotlightFeature {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._view = null;
        this._parsed = null;
        this._local = {};
        this._session = null;
        this._debounce = 0;
        this._externalReady = false;
        this._enabled = false;
        this._loadCancellable = null;
        this._viewCancellable = null;
        this._viewId = null;
        this._historyIndex = -1;
        this._recalled = null;
    }

    enable() {
        const { settings, gettext } = this._ctx;
        const cleanup = this._cleanup;
        this._enabled = true;
        cleanup.add(() => (this._enabled = false));
        this._loadCancellable = new Gio.Cancellable();
        cleanup.add(() => {
            this._loadCancellable.cancel();
            this._loadCancellable = null;
        });
        const ks = new GuavaSettings(settings);
        ks.attach(cleanup);
        this._ks = ks;
        this._ = gettext;

        this._apps = new AppsProvider(cleanup, { hiddenIds: [LAUNCHPAD_DESKTOP_ID] });
        this._settingsProvider = new SettingsProvider(this._ctx);
        this._clipboard = new ClipboardProvider(gettext, () => this._ctx.features.instance('clipboard-history'));
        this._dbus = new DBusSearch();
        cleanup.add(() => this._dbus.reset());
        this._files = new LocalSearch();
        cleanup.add(() => this._files.close());
        this._quickLook = new QuickLook();
        this._actions = new ActionsProvider(this._ctx, cleanup, this._apps);
        this._results = new Results({
            ks, gettext, apps: this._apps, settings: this._settingsProvider, clipboard: this._clipboard,
            actions: this._actions, files: this._files, dbus: this._dbus,
            menus: () => this._ctx.features.instance('menu-bar'),
        });
        // Warm the app index after the Shell is idle, so the first keystroke is fast
        cleanup.idle(() => this._apps.warm(), { name: 'spotlight-warm' });

        this._modal = new ModalSurface(cleanup, {
            id: 'spotlight',
            accessibleName: gettext('Spotlight'),
            width: WIDTH,
            position: 'top',
            offsetTop: OFFSET_TOP,
            radius: RADIUS,
            styleClass: 'guava-spotlight',
            build: frame => this._build(frame),
            onClosed: () => this._closed(),
        });
        cleanup.add(() => this._closed());

        // The extension is torn down on lock, but close at once on any lock transition too
        cleanup.connect(Main.sessionMode, 'updated', () => {
            if (Main.sessionMode.isLocked)
                this._modal.close({ immediate: true });
        });

        // A Super tap: take over overlay-key while the key is on; give it back when it goes off
        const takeover = new OverlayKeyTakeover(() => this.toggle());
        this._takeover = takeover;
        cleanup.add(() => {
            takeover.stop();
            this._takeover = null;
        });
        const applySuper = () => {
            if (ks.bool('spotlight-on-super'))
                takeover.start();
            else
                takeover.stop();
        };
        applySuper();
        ks.watch(['spotlight-on-super'], applySuper);
        // History off: forget what was kept, as macOS's "Clear Spotlight History"
        ks.watch(['spotlight-history'], () => {
            if (!ks.bool('spotlight-history'))
                this.clearHistory();
        });

        // Optional extra shortcut (empty by default). Registered always; an empty list binds nothing.
        if (ks.has('spotlight-shortcut'))
            Keybindings.add(cleanup, 'spotlight-shortcut', settings, () => this.toggle(), { modes: MODAL_MODES });
    }

    disable() {
        // Everything is in the cleanup registry, which is disposed right after this returns.
        this._modal?.close({ immediate: true });
    }

    toggle() {
        this._modal?.toggle();
    }

    /** Open with a browse view showing ('apps', 'files', 'actions', 'clipboard'); harness and shortcuts. */
    openView(id) {
        if (!this._modal.isOpen)
            this._modal.open();
        this._setView(id);
    }

    clearHistory() {
        this._ks.setStrv('spotlight-history-queries', []);
        this._ks.setStrv('spotlight-recent-results', []);
    }

    // ---- modal lifecycle

    _build(frame) {
        this._view = new SpotlightView({
            motion: this._ctx.motion,
            gettext: this._,
            onQuery: text => this._search(text),
            onActivate: (item, opts) => this._activate(item, opts),
            onCopy: item => this._copy(item),
            onClose: () => this._modal.close(),
            onView: id => this._setView(toggleView(this._viewId, id)),
            onHistory: direction => this._recall(direction),
            onTab: () => this._scopeMenus(),
            onPreview: item => this._preview(item),
        });
        const focus = this._view.build(frame);
        this._settingsProvider.invalidate();
        this._quickLook.reset();
        this._files.retry();
        if (this._ks.bool('spotlight-quick-look'))
            this._quickLook.check(this._loadCancellable).catch(() => {});
        this._viewId = null;
        this._historyIndex = -1;
        this._search('');
        return focus;
    }

    _closed() {
        this._cancelSearch();
        this._view?.destroy();
        this._view = null;
        this._parsed = null;
        this._local = {};
        this._viewId = null;
    }

    _cancelSearch() {
        if (this._debounce) {
            this._cleanup.release(this._debounce);
            this._debounce = 0;
        }
        this._session?.cancel();
        this._session = null;
        this._viewCancellable?.cancel();
        this._viewCancellable = null;
    }

    // ---- search

    _search(text) {
        const parsed = parseQuery(text, { available: this._results.available() });
        this._parsed = parsed;
        this._cancelSearch();
        if (parsed.raw !== this._recalled)
            this._historyIndex = -1;
        this._syncChrome();
        if (!parsed.raw) {
            this._local = {};
            if (this._viewId)
                this._showView(this._viewId);
            else
                this._view.setSections(this._emptySections());
            return;
        }
        if (parsed.suggest) {
            this._local = {};
            this._view.setSections(parsed.suggest.length > 0 ? [{
                id: 'filters', items: parsed.suggest.map(f => ({
                    id: `filter:${f.id}`, kind: 'filter', title: `/${f.aliases[0]}`, subtitle: this._(f.label),
                    iconName: 'edit-find-symbolic', filter: f,
                })),
            }] : []);
            return;
        }

        // Local providers answer at once, in memory
        this._local = this._results.local(parsed);

        // Providers that talk to other processes stream in after a short debounce
        this._debounce = this._cleanup.timeout(EXTERNAL_DEBOUNCE_MS, () => {
            this._debounce = 0;
            this._startExternal(parsed).then(() => {
                // No provider to wait for: the filter's empty state can show now
                if (!this._session)
                    this._render();
            });
            return GLib.SOURCE_REMOVE;
        }, { name: 'spotlight-debounce' });
        this._render();
    }

    async _startExternal(parsed) {
        if (!parsed.filter && !this._externalReady) {
            try {
                await this._dbus.load(this._loadCancellable);
                this._externalReady = true;
            } catch (e) {
                if (this._enabled)
                    console.warn(`${LOG} could not read search providers: ${e.message}`);
            }
            if (!this._enabled || this._parsed !== parsed || !this._view)
                return;
        }
        const providers = this._results.external(parsed);
        if (providers.length === 0)
            return;
        this._session = new SearchSession({
            providers,
            schedule: (ms, fn) => {
                const token = this._cleanup.timeout(ms, () => {
                    fn();
                    return GLib.SOURCE_REMOVE;
                }, { name: 'spotlight-provider-timeout' });
                return () => this._cleanup.release(token);
            },
            makeCancellable: () => new Gio.Cancellable(),
            onUpdate: () => this._render(),
            onError: (id, e) => {
                if (e.message !== 'timeout')
                    console.debug(`${LOG} provider ${id}: ${e.message}`);
            },
        });
        this._session.start(parsed.text);
    }

    _emptySections() {
        const ks = this._ks;
        // Privacy: copied text shows on an empty search only when the user asked for it
        const clips = ks.bool('spotlight-clipboard') && ks.bool('spotlight-recent-clipboard')
            ? this._clipboard.recent(4) : [];
        return buildEmptySections(this._apps.recent(6), clips, this._results.history());
    }

    _render() {
        const parsed = this._parsed;
        if (!this._view || !parsed?.raw)
            return;
        const external = this._session?.byGroup(parsed.text, 40) ?? {};
        const byGroup = { ...this._local };
        for (const [group, items] of Object.entries(external))
            byGroup[group] = [...(byGroup[group] ?? []), ...items].sort((a, b) => b.score - a.score);
        // A "/" filter that found nothing says so once every provider has answered
        const waiting = this._debounce || this._session?.busy;
        this._view.setSections(buildSections(byGroup, { limits: this._results.limits(parsed) }),
            { empty: !!parsed.filter && !waiting, waiting: !!waiting });
    }

    // ---- browse views, history, scopes

    _setView(id) {
        if (!this._view)
            return;
        this._viewId = this._ks.bool('spotlight-views') ? id : null;
        if (this._view.text)
            this._view.setText('');   // the empty field shows the view
        else
            this._search('');
    }

    async _showView(id) {
        const cancellable = new Gio.Cancellable();
        this._viewCancellable = cancellable;
        const view = this._view;
        try {
            const sections = await this._results.view(id, cancellable);
            if (!cancellable.is_cancelled() && this._view === view && this._viewId === id && !this._parsed?.raw)
                view.setSections(sections);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`${LOG} view ${id}: ${e.message}`);
        }
    }

    _syncChrome() {
        const parsed = this._parsed;
        this._view.setChrome({
            views: this._ks.bool('spotlight-views') && !parsed.raw,
            activeView: this._viewId,
            chip: parsed.filter ? this._(parsed.filter.label) : null,
        });
    }

    /** Up/Down in the field walk the search history. @returns {boolean} handled */
    _recall(direction) {
        const list = this._ks.bool('spotlight-history') ? this._ks.strv('spotlight-history-queries') : [];
        const text = this._view.text.trim();
        // Only from an empty field (not a browse view, which takes the arrows), or while walking it
        if (list.length === 0 || (!text && this._viewId) || (text && text !== this._recalled))
            return false;
        if (!text && direction > 0)
            return false;
        const step = historyStep(list, this._historyIndex, direction);
        this._historyIndex = step.index;
        this._recalled = step.text;
        this._view.setText(step.text);
        return true;
    }

    /** Tab: scope the search to the focused app's menu items, and back. @returns {boolean} handled */
    _scopeMenus() {
        const menu = filterById('menu');
        if (!this._results.available().has('menu'))
            return false;
        const parsed = this._parsed;
        this._view.setText(parsed?.filter === menu ? parsed.text : filterText(menu, parsed?.text ?? ''));
        return true;
    }

    /** Space on a file: Quick Look. @returns {boolean} handled */
    _preview(item) {
        if (!item?.uri?.startsWith('file://') || !this._ks.bool('spotlight-quick-look') || !this._quickLook.available)
            return false;
        this._remember(item);
        // Sushi is a window of its own: the modal grab must go first so it gets the keyboard
        this._modal.close();
        this._quickLook.show(item.uri).catch(e => console.warn(`${LOG} Quick Look: ${e.message}`));
        return true;
    }

    _remember(item) {
        const ks = this._ks;
        if (!ks.bool('spotlight-history'))
            return;
        const query = this._parsed?.raw ?? '';
        if (query)
            ks.setStrv('spotlight-history-queries', pushHistory(ks.strv('spotlight-history-queries'), query));
        const recent = pushRecent(ks.strv('spotlight-recent-results'), item);
        if (recent.join('\n') !== ks.strv('spotlight-recent-results').join('\n'))
            ks.setStrv('spotlight-recent-results', recent);
    }

    // ---- actions

    _copy(item) {
        const text = item.copyText ?? item.clipboardText ?? (item.kind === 'clipboard' ? null : item.title);
        if (item.kind === 'clipboard')
            this._clipboard.activate(item);
        else if (text)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._modal.close();
    }

    _activate(item, { reveal = false } = {}) {
        // Rows that change the search keep Spotlight open
        switch (item.kind) {
        case 'filter':
            this._view.setText(filterText(item.filter));
            return;
        case 'history':
            this._view.setText(item.query);
            return;
        case 'note':
            return;
        default:
            break;
        }
        this._remember(item);
        // Close first so the grab is gone and focus is back before another app takes it
        this._modal.close();
        try {
            this._run(item, reveal);
        } catch (e) {
            console.warn(`${LOG} activating ${item.id} failed: ${e.message}`);
        }
    }

    _run(item, reveal) {
        switch (item.kind) {
        case 'app':
            this._apps.activate(item);
            break;
        case 'command':
        case 'app-action':
            this._actions.run(item);
            break;
        case 'menu':
            Promise.resolve(item.run()).catch(e => console.warn(`${LOG} menu item: ${e.message}`));
            break;
        case 'setting':
        case 'action':
            this._settingsProvider.activate(item);
            break;
        case 'clipboard':
            this._clipboard.activate(item);
            break;
        case 'calc':
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.copyText);
            break;
        case 'web':
            this._openUri(item.url, /^https?:\/\//i);
            break;
        case 'file':
            if (reveal)
                this._reveal(item);
            else if (item.source)
                this._activateExternal(item);
            else
                this._openUri(item.uri, /^file:\/\//);
            break;
        case 'external':
            this._activateExternal(item);
            break;
        default:
            break;
        }
    }

    _activateExternal(item) {
        this._dbus.activate(item, global.get_current_time()).catch(e => {
            if (this._enabled)
                console.warn(`${LOG} activate failed: ${e.message}`);
        });
    }

    _openUri(uri, allowed) {
        if (!allowed.test(uri ?? ''))
            return;
        Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, (_o, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                console.warn(`${LOG} open failed: ${e.message}`);
            }
        });
    }

    /** Ctrl+Enter: show the file in Files (org.freedesktop.FileManager1.ShowItems). */
    _reveal(item) {
        const uri = item.uri ?? item.source?.resultId;
        if (!uri?.startsWith('file://'))
            return;
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
            null, Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    // No file manager service: open the item itself instead
                    if (!this._enabled)
                        return;
                    if (item.source)
                        this._activateExternal(item);
                    else
                        this._openUri(uri, /^file:\/\//);
                }
            });
    }
}
