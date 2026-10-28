// SPDX-License-Identifier: GPL-3.0-or-later
// The app's part of the menu bar: the focused app's name in bold, then its menus.
//
// The menus come from core/appMenus (ctx.appMenus): generic menus for every app, plus the
// GTK actions the app exports. With native menus on, this part registers the menu bar
// providers while it runs: the GTK exported menu bar and DBusMenu (Qt, Electron and other
// Xwayland apps), then AT-SPI when its experimental setting is on. A native menu bar
// replaces File, Edit and View; the App, Window and Help menus stay Guava's. Titles are known from the cached provider result; the items
// are built only when a menu opens, so a closed menu bar costs nothing but a label update on
// focus changes. With no focused window (the desktop) the menus are Files', as Finder's are
// on macOS; in the overview the app menus step aside.
//
// Every title is a PanelMenu.Button registered with the panel's menu manager, so hovering
// from one open menu to the next and Left/Right on the keyboard move between them, like
// macOS. focus() (Ctrl+F2) opens the app menu with its first item selected.
//
// Shell API: PanelMenu.Button, PopupMenu, Main.panel.menuManager, Shell.AppSystem.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { skipsTaskbar } from '../../core/windowState.js';
import { PanelLayout } from '../../core/panelLayout.js';
import { menuEntries, searchMenus, WM_ACCEL_SLOTS } from '../../core/appMenus/model.js';
import { GtkMenusProvider } from '../../core/appMenus/gtkMenus.js';
import { DBusMenuProvider } from '../../core/appMenus/dbusMenu.js';
import { AtspiProvider } from '../../core/appMenus/atspi.js';
import { fitMenus } from './model.js';
import { LazyMenu, menuHeading, menuItem } from './menuItems.js';
import { MenuGlass } from '../../lib/menuGlass.js';

export const APPS_CLAIM = 'guava-menubar-apps';
const OVERFLOW_ID = 'overflow';
const OVERFLOW_TITLE = '»';
const DESKTOP_APP = 'org.gnome.Nautilus.desktop';
const SOFTWARE_APP = 'org.gnome.Software.desktop';
const HELP_RESULTS = 8;

/**
 * Lays its children out in a row (mirrored in right-to-left text) and, when they do not fit,
 * leaves the menus that do not (past the strip's edge, clipped) and shows the "»" button instead, so a long
 * menu list never runs into the notch or the clock. The first child is the app name (always
 * shown) and `more` the "»" button; their widths come from model.js fitMenus.
 *
 * `onFit(shown, total)` is called when the split changes. It runs inside an allocation, so a
 * handler must only queue work (an idle), never touch the actors.
 */
const OverflowLayout = GObject.registerClass(
class GuavaMenuOverflowLayout extends Clutter.LayoutManager {
    _init() {
        super._init();
        this.more = null;
        this.onFit = null;
        this._fit = '';
    }

    _menus(container) {
        return container.get_children().filter(c => c.visible && c !== this.more);
    }

    vfunc_get_preferred_width(container, forHeight) {
        let min = 0;
        let nat = 0;
        for (const child of this._menus(container)) {
            const [, n] = child.get_preferred_width(forHeight);
            if (!min)
                min = n;
            nat += n;
        }
        return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
        let min = 0;
        let nat = 0;
        for (const child of container.get_children()) {
            if (!child.visible && child !== this.more)
                continue;
            const [m, n] = child.get_preferred_height(-1);
            min = Math.max(min, m);
            nat = Math.max(nat, n);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        const height = box.get_height();
        const width = box.get_width();
        const menus = this._menus(container);
        const widths = menus.map(c => c.get_preferred_width(height)[1]);
        const moreWidth = this.more ? this.more.get_preferred_width(height)[1] : 0;
        const rtl = container.get_text_direction() === Clutter.TextDirection.RTL;
        const fit = fitMenus(widths, width, moreWidth, rtl);
        const place = (child, x, w) => {
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(x, 0);
            childBox.set_size(w, height);
            child.allocate(childBox);
        };
        // A button without room keeps its own width but sits just past the strip's edge, where
        // the strip's clip hides it: squeezed to nothing, its padding would leave the label a
        // negative width ("StLabel tried to allocate -10x0")
        const away = w => (rtl ? -w : width);
        menus.forEach((child, i) => {
            if (i < fit.shown)
                place(child, fit.xs[i], widths[i]);
            else
                place(child, away(widths[i]), widths[i]);
        });
        if (this.more)
            place(this.more, fit.more ? fit.moreX : away(moreWidth), moreWidth);
        const key = `${fit.shown}/${menus.length}`;
        if (key !== this._fit) {
            this._fit = key;
            this.onFit?.(fit.shown, menus.length);
        }
    }
});

const TopMenu = GObject.registerClass(
class GuavaTopMenu extends PanelMenu.Button {
    _init(title, fill) {
        super._init(0.0, title, true);
        this.setMenu(new LazyMenu(this, () => fill(this)));
        this.add_style_class_name('guava-menubar-item');
        this._label = new St.Label({ text: title, y_align: Clutter.ActorAlign.CENTER, style_class: 'guava-menubar-title' });
        this.add_child(this._label);
        this.menu.actor.add_style_class_name('guava-menubar-menu');
        this.def = null;
    }

    setTitle(title, bold) {
        this._label.text = title;
        this.accessible_name = title;
        if (bold)
            this.add_style_class_name('guava-menubar-app-name');
        else
            this.remove_style_class_name('guava-menubar-app-name');
    }
});

// The Help menu's search field
const HelpSearchItem = GObject.registerClass(
class GuavaHelpSearchItem extends PopupMenu.PopupBaseMenuItem {
    _init(hint) {
        super._init({ reactive: false, can_focus: false, style_class: 'guava-menubar-search-item' });
        this.entry = new St.Entry({
            hint_text: hint, accessible_name: hint, can_focus: true, x_expand: true,
            style_class: 'guava-menubar-search',
        });
        this.add_child(this.entry);
    }
});

export class AppMenuBar {
    /**
     * @param {object} ctx the feature ctx
     * @param {CleanupRegistry} cleanup this part's registry
     * @param {object} opts
     * @param {() => object} opts.keys shortcut label options
     * @param {{native: boolean, atspi: boolean, popovers: boolean}} [opts.providers] which
     *   menu bar providers to run
     */
    constructor(ctx, cleanup, { keys, providers = {} }) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._keys = keys;
        this._providerOpts = providers;
        this._buttons = [];
        this._more = null;       // the "»" button holding the menus that do not fit
        this._fit = { shown: 0, total: 0 };
        this._fitIdle = 0;
        this._target = null;
        this._menus = [];
    }

    /** Menu titles shown now (tests, the harness). */
    get titles() {
        return this._buttons.filter(b => b.container.visible).map(b => b.def?.title ?? '');
    }

    /** Titles of the menus the strip has no room for; they are in the "»" menu (tests, the harness). */
    get hiddenTitles() {
        return this._buttons.filter(b => b.container.visible).slice(this._fit.shown).map(b => b.def?.title ?? '');
    }

    /** The "»" button (tests, the harness). */
    get moreButton() {
        return this._more;
    }

    /** The menus of the focused app as built now (tests, the harness, Spotlight later). */
    get menus() {
        return this._menus;
    }

    get target() {
        return this._target;
    }

    start() {
        const ctx = this._ctx;
        const cleanup = this._cleanup;
        this._service = ctx.appMenus.acquire(cleanup);
        this._desktop = ctx.desktop.acquire(cleanup);
        const { native = true, atspi = false, popovers = false } = this._providerOpts;
        if (native) {
            this._service.registerProvider(cleanup, new GtkMenusProvider());
            this._service.registerProvider(cleanup, new DBusMenuProvider());
        }
        if (atspi)
            this._service.registerProvider(cleanup, new AtspiProvider({ popovers }));
        this._service.onChanged(cleanup, (windowId, how) => this._onProviderChanged(windowId, how));
        this._wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._mutter = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });

        this._glass = new MenuGlass(cleanup);
        const layout = new OverflowLayout();
        this._strip = new St.Widget({
            style_class: 'guava-menubar-apps', layout_manager: layout,
            y_expand: true, clip_to_allocation: true,
        });
        this._more = this._newButton(OVERFLOW_TITLE);
        this._more.accessible_name = this._ctx.gettext('More Menus');
        this._more.def = { id: OVERFLOW_ID, title: OVERFLOW_TITLE, items: [] };
        layout.more = this._more.container;
        layout.onFit = (shown, total) => this._queueFit(shown, total);
        cleanup.add(() => {
            for (const b of [...this._buttons, this._more])
                b.destroy();
            this._buttons = [];
            this._more = null;
            this._strip.destroy();
            this._strip = null;
        });
        PanelLayout.claim(cleanup, {
            id: APPS_CLAIM, actor: this._strip, box: 'left',
            anchor: { after: ['activities', 'guava-menubar-logo'], fallback: 'first' },
        });

        ctx.events.on('window-focused', () => this.sync(), cleanup);
        ctx.events.on('app-focused', () => this.sync(), cleanup);
        cleanup.connect(Main.overview, 'showing', () => this.sync());
        cleanup.connect(Main.overview, 'hidden', () => this.sync());
        cleanup.connect(Shell.AppSystem.get_default(), 'installed-changed', () => this.sync());
        this.sync();
    }

    /** Re-read the focused app and rebuild the titles. */
    sync() {
        if (!this._strip)
            return;
        const target = this._currentTarget();
        const same = target && this._target && target.windowId === this._target.windowId &&
            target.appId === this._target.appId;
        if (!same)
            this._closeMenus();
        this._target = target;
        this._strip.visible = !!target;
        if (!target) {
            this._setMenus([]);
            return;
        }
        const cached = this._service.peek(target);
        this._setMenus(this._build(target, cached));
        if (!cached) {
            this._service.results(target).then(results => {
                if (this._target === target && !this._openButton())
                    this._setMenus(this._build(target, results));
            });
        }
    }

    /** Open the app menu with its first item focused (Ctrl+F2); close it when a menu is open. */
    focus() {
        const open = this._openButton();
        if (open) {
            open.menu.close(BoxPointer.PopupAnimation.FULL);
            return false;
        }
        const first = this._buttons.find(b => b.container.visible);
        if (!first)
            return false;
        first.menu.open(BoxPointer.PopupAnimation.FULL);
        first.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        return true;
    }

    /**
     * The focused app's menu items, for Spotlight's menu-item search (macOS Help search, but
     * global). Reads the app's actions if they are not cached yet.
     *
     * @returns {Promise<{appName: string, entries: {path: string, label: string, run: Function}[]}|null>}
     */
    async menuItems() {
        const target = this._currentTarget();
        if (!target)
            return null;
        const results = this._service.peek(target) ?? (target.gtk ? await this._service.results(target) : null);
        const menus = this._service.build(target, results, {
            generic: this._generic(target), accels: this._accels(), _: this._ctx.gettext,
        });
        return {
            appName: target.appName,
            entries: menuEntries(menus).map(({ path, item }) => ({
                path, label: item.label, run: () => this._service.activate(target, item.command),
            })),
        };
    }

    /** Open one menu by id ('app', 'file', ...); tests and the harness. */
    openMenu(id) {
        const b = this._buttons.find(x => x.def?.id === id);
        b?.menu.open(BoxPointer.PopupAnimation.NONE);
        return b?.menu ?? null;
    }

    // ---- building ---------------------------------------------------------------------------

    _currentTarget() {
        if (Main.overview.visible)
            return null;
        const info = this._desktop.model.focusedWindow;
        const win = info ? this._desktop.metaWindow(info.id) : null;
        if (win)
            return this._service.targetFor(win);
        // The desktop: Files' menus, as Finder's on macOS
        const files = Shell.AppSystem.get_default().lookup_app(DESKTOP_APP);
        return files ? this._service.targetFor(null, files) : null;
    }

    _build(target, results) {
        this._menus = this._service.build(target, results, {
            generic: this._generic(target), accels: this._accels(), _: this._ctx.gettext,
        });
        return this._menus;
    }

    _generic(target) {
        const appSystem = Shell.AppSystem.get_default();
        const app = appSystem.lookup_app(target.appId);
        const win = target.windowId !== null ? this._desktop.metaWindow(target.windowId) : null;
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        const windows = (app?.get_windows() ?? [])
            .filter(w => !skipsTaskbar(w))
            .map(w => ({ id: w.get_stable_sequence(), title: w.get_title() ?? '', focused: w === win }));
        return {
            hasWindow: !!win,
            canNewWindow: !!app?.can_open_new_window(),
            hasAbout: !!appSystem.lookup_app(SOFTWARE_APP),
            maximized: !!win && win.maximized_horizontally && win.maximized_vertically,
            fullscreen: !!win?.is_fullscreen(),
            above: !!win?.is_above(),
            workspaces: {
                count: wm.get_n_workspaces(), active,
                current: win?.is_on_all_workspaces() ? -1 : win?.get_workspace()?.index() ?? active,
            },
            windows,
        };
    }

    _accels() {
        const out = {};
        for (const [slot, [schema, key]] of Object.entries(WM_ACCEL_SLOTS)) {
            const settings = schema === 'wm' ? this._wm : this._mutter;
            out[slot] = settings.get_strv(key)[0] ?? null;
        }
        return out;
    }

    _setMenus(menus) {
        while (this._buttons.length < menus.length) {
            const b = this._newButton('');
            // _newButton added it last; move it before the "»" button, which stays last
            this._strip.set_child_below_sibling(b.container, this._more.container);
            this._buttons.push(b);
        }
        this._buttons.forEach((b, i) => {
            const def = menus[i] ?? null;
            b.def = def;
            b.container.visible = !!def;
            if (def)
                b.setTitle(def.title, def.id === 'app');
        });
    }

    // A title button with its menu registered with the panel's menu manager
    _newButton(title) {
        const b = new TopMenu(title, button => this._onOpen(button));
        Main.panel.menuManager.addMenu(b.menu);
        this._glass.add(b.menu);
        this._cleanup.connect(b.menu, 'open-state-changed', (_m, open) => {
            // Connected after the menu manager's handler, so it runs once the grab took
            // the key focus: macOS puts the cursor in Help's search field
            if (open)
                b.searchEntry?.grab_key_focus();
            else if (!this._openButton())
                this._refreshTitles();
        });
        // A PanelMenu.Button lives in its own container (St.Bin), like in the panel boxes; the
        // strip leaves the ones that do not fit empty, so they must not paint outside it
        b.container.clip_to_allocation = true;
        this._strip.add_child(b.container);
        return b;
    }

    // The layout split the row (inside an allocation): apply it once the allocation is over
    _queueFit(shown, total) {
        this._fit = { shown, total };
        if (this._fitIdle)
            return;
        this._fitIdle = this._cleanup.idle(() => {
            this._fitIdle = 0;
            this._applyFit();
        }, { name: 'menu bar overflow' });
    }

    // Menus without room are out of keyboard navigation (an empty button must not take focus);
    // the "»" button shows when there are any
    _applyFit() {
        if (!this._strip)
            return;
        const { shown, total } = this._fit;
        this._buttons.forEach((b, i) => {
            b.reactive = b.can_focus = i < shown;
        });
        const needed = shown < total;
        this._more.reactive = this._more.can_focus = needed;
        if (!needed && this._more.menu.isOpen)
            this._more.menu.close(BoxPointer.PopupAnimation.NONE);
        this._more.def = this._overflowDef(this._menus);
    }

    // The menus that did not fit, as submenus of the "»" menu
    _overflowDef(menus) {
        const hidden = menus.slice(this._fit.shown);
        return {
            id: OVERFLOW_ID, title: OVERFLOW_TITLE,
            items: hidden.map(m => ({ kind: 'submenu', label: m.title, items: m.items })),
        };
    }

    _openButton() {
        return [...this._buttons, this._more].find(b => b?.menu.isOpen) ?? null;
    }

    _closeMenus() {
        this._openButton()?.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    // A menu opens: build it from what is known now (window titles, workspaces and states
    // change while menus are closed), and re-read the app's actions in the background if stale
    _onOpen(button) {
        const target = this._target;
        const id = button.def?.id;
        const fill = results => {
            const menus = this._build(target, results);
            button.def = id === OVERFLOW_ID ? this._overflowDef(menus) : menus.find(m => m.id === id) ?? button.def;
            this._fill(button);
        };
        fill(target ? this._service.peek(target) : null);
        if (!target || !this._service.isStale(target))
            return;
        this._service.results(target).then(results => {
            if (this._target === target && button.menu.isOpen)
                fill(results);
        });
    }

    // A provider saw the app's menus change. Menus that came or went (org.gtk.Menus Changed,
    // DBusMenu LayoutUpdated, a window registering its menu) are re-read at once for the titles;
    // a state change (org.gtk.Actions Changed: Undo became possible) only matters to an open
    // menu, which is refilled. Closed menus re-read their stale result when they open.
    _onProviderChanged(windowId, { structure }) {
        const target = this._target;
        if (!target || target.windowId !== windowId)
            return;
        if (!structure && !this._openButton())
            return;
        this._service.results(target).then(results => {
            if (this._target !== target)
                return;
            const open = this._openButton();
            if (!open) {
                this._setMenus(this._build(target, results));
                return;
            }
            const menus = this._build(target, results);
            open.def = menus.find(m => m.id === open.def?.id) ?? open.def;
            this._fill(open);
        });
    }

    // After the last menu closed: titles may have changed (Edit or View appeared)
    _refreshTitles() {
        if (this._target)
            this._setMenus(this._build(this._target, this._service.peek(this._target)));
    }

    _fill(button) {
        const menu = button.menu;
        menu.removeAll();
        button.searchEntry = null;
        const def = button.def;
        if (!def)
            return;
        this._addItems(menu, def.items, button);
    }

    _addItems(menu, items, button) {
        const target = this._target;
        // A menu with a checkmark reserves the check column for every item (macOS alignment)
        const checks = items.some(i => i.checked === true || i.checked === false);
        for (const it of items) {
            switch (it.kind) {
            case 'separator':
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                break;
            case 'submenu': {
                const sub = new PopupMenu.PopupSubMenuMenuItem(it.label);
                sub.add_style_class_name('guava-menubar-menu-item');
                if (checks)
                    sub.setOrnament(PopupMenu.Ornament.NONE);
                this._addItems(sub.menu, it.items, button);
                menu.addMenuItem(sub);
                break;
            }
            case 'search':
                button.searchEntry = this._addSearch(menu);
                break;
            case 'heading':
                menu.addMenuItem(menuHeading(it.label));
                break;
            default:
                menu.addMenuItem(menuItem(it.label, {
                    accel: it.accel, keys: this._keys(), enabled: it.enabled,
                    checked: checks ? !!it.checked : null, radio: !!it.radio,
                    onActivate: () => this._service.activate(target, it.command),
                }));
            }
        }
    }

    _addSearch(menu) {
        const _ = this._ctx.gettext;
        const search = new HelpSearchItem(_('Search'));
        const results = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(search);
        menu.addMenuItem(results);
        const target = this._target;
        const run = hit => {
            menu.close(BoxPointer.PopupAnimation.FULL);
            this._service.activate(target, hit.item.command);
        };
        let hits = [];
        search.entry.clutter_text.connect('text-changed', () => {
            results.removeAll();
            hits = searchMenus(this._menus, search.entry.get_text(), HELP_RESULTS);
            for (const hit of hits) {
                const item = menuItem(hit.item.label, { onActivate: () => run(hit) });
                item.add_child(new St.Label({
                    text: hit.path, style_class: 'guava-menubar-accel',
                    x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
                }));
                results.addMenuItem(item);
            }
        });
        search.entry.clutter_text.connect('activate', () => {
            if (hits.length)
                run(hits[0]);
        });
        if (menu.isOpen)
            search.entry.grab_key_focus();
        return search.entry;
    }
}
