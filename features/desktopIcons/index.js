// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop icons, as on the Finder desktop: the files and folders of ~/Desktop (and, optionally,
// the mounted drives) as large icons laid out from the TOP-RIGHT corner, down the right-most
// column and then to the left.
//
// - source.js reads the folder (async, one debounced Gio.FileMonitor) and the drives, with
//   GNOME's cached previews; layer.js draws one monitor's icons below the widgets and every
//   window (core/desktopLayers.js), and turns the pointer into calls here; model.js is the
//   pure grid, flow, collisions, selection and keyboard logic.
// - Click selects, double-click opens with the default app, a rubber band selects, a drag
//   rearranges (the places are remembered in desktop-icons-layout), the right-click menu has
//   Open, Show in Files, Rename, Move to Trash (Gio trash, never a delete), Eject and, on
//   the wallpaper, New Folder and Sort By. Keys: arrows, Enter, F2, Delete, Ctrl+A, Ctrl+Shift+N,
//   typing a name. Ctrl+Alt+Tab reaches the desktop.
// - The icons flow around the widgets' cards (core/desktopLayers.js reserved rectangles).
// - Desktop Icons NG (DING) and its forks draw their own icons: while one is enabled this
//   feature stays idle (it only watches the extension list) and the preferences say so.
// - Guava only ever changes the user's files through the explicit actions in ops.js.
//
// Shell API (private, checked on 50.6): the wallpaper menu (lib/backgroundMenu.js); the layer's
// Meta.BackgroundActor check; Main.pushModal for the rename field.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import * as A11y from '../../lib/a11y.js';
import { addBackgroundMenuItems } from '../../lib/backgroundMenu.js';
import { openContextMenu } from '../../lib/contextMenu.js';
import { GuavaSettings } from '../../lib/settings.js';
import { DesktopLayers } from '../../core/desktopLayers.js';
import { IconLayer } from './layer.js';
import { DesktopOps } from './ops.js';
import { RenameEditor } from './rename.js';
import { DesktopSource } from './source.js';
import {
    SORTS, Selection, TYPE_AHEAD_MS, blockedCells, desktopInFront, dingEnabled, flowOrder, gridFor, isSort,
    layoutCells, menuActions, metricsFor, moveCells, neighbour, parseArrangement, pruneArrangement,
    serializeArrangement, typeAhead, uniqueName, validateName,
} from './model.js';

const KEY_LAYOUT = 'desktop-icons-layout';
const KEY_SORT = 'desktop-icons-sort';
const KEY_SIZE = 'desktop-icons-size';
const KEY_DRIVES = 'desktop-icons-show-drives';
const SHELL_SCHEMA = 'org.gnome.shell';
const ARROWS = {
    [Clutter.KEY_Left]: 'left', [Clutter.KEY_Right]: 'right', [Clutter.KEY_Up]: 'up', [Clutter.KEY_Down]: 'down',
    [Clutter.KEY_KP_Left]: 'left', [Clutter.KEY_KP_Right]: 'right', [Clutter.KEY_KP_Up]: 'up', [Clutter.KEY_KP_Down]: 'down',
};

export class DesktopIcons {
    constructor(ctx, cleanup) {
        this.ctx = ctx;
        this._cleanup = cleanup;
        this._ = s => ctx.gettext(s);
        this.selection = new Selection();
        this.keyboardFocus = null;
        this.keyboardNav = false;      // the focus ring shows only after a key was used
        this.desktopActive = true;
        this.entries = [];
        this.cells = new Map();
        this.sort = 'none';
        this.pausedByDing = false;
        this._run = null;              // the registry of the running part, null while idle
        this._stored = new Map();
        this._written = null;
        this._loaded = false;
        this._pendingRename = null;
        this._rename = null;
        this._menu = null;
        this._typed = { text: '', time: 0 };
    }

    enable() {
        const cleanup = this._cleanup;
        this._ks = new GuavaSettings(this.ctx.settings);
        this._ks.attach(cleanup);
        cleanup.add(() => this._stop());
        this._ks.watch([KEY_LAYOUT], () => this._loadArrangement());
        this._ks.watch([KEY_SORT], () => this._onSort());
        this._ks.watch([KEY_SIZE], () => this._relayout(false));
        this._ks.watch([KEY_DRIVES], () => this._source?.setShowDrives(this._ks.bool(KEY_DRIVES)));
        const shell = Gio.SettingsSchemaSource.get_default()?.lookup(SHELL_SCHEMA, true)
            ? new Gio.Settings({ schema_id: SHELL_SCHEMA }) : null;
        if (shell) {
            this._shell = shell;
            for (const key of ['enabled-extensions', 'disable-user-extensions'])
                cleanup.connect(shell, `changed::${key}`, () => this._sync());
        }
        this._sync();
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** Run, or stay idle while another extension draws the desktop icons. */
    _sync() {
        const ding = !!this._shell && dingEnabled(this._shell.get_strv('enabled-extensions'),
            this._shell.get_boolean('disable-user-extensions'));
        this.pausedByDing = ding;
        if (ding && this._run)
            this._stop();
        else if (!ding && !this._run)
            this._start();
    }

    // ---- the running part -------------------------------------------------------------------------

    _start() {
        const run = this._run = new CleanupRegistry();
        const ctx = this.ctx;
        this._desktop = ctx.desktop.acquire(run);
        this._layout = ctx.layout.acquire(run);
        this.desktopLayers = DesktopLayers.acquire(run);
        this._cancellable = new Gio.Cancellable();
        run.add(() => this._cancellable.cancel());
        this._ops = new DesktopOps(this._, this._cancellable);
        this.sort = isSort(this._ks.string(KEY_SORT)) ? this._ks.string(KEY_SORT) : 'none';
        this._stored = parseArrangement(this._ks.string(KEY_LAYOUT));
        this._written = this._ks.string(KEY_LAYOUT);
        this._loaded = false;
        this.entries = [];
        this.cells = new Map();

        this._source = new DesktopSource(run, entries => this._onEntries(entries), entry => this._onThumbnail(entry));
        this._source.setShowDrives(this._ks.bool(KEY_DRIVES));
        this._buildLayer();
        run.add(() => this._destroyLayer());
        run.add(() => this._closeMenu());
        run.add(() => this._closeRename());

        ctx.events.on('monitors-changed', () => this._buildLayer(), run);
        ctx.events.on('work-area-changed', () => this._relayout(false), run);
        for (const e of ['window-focused', 'window-changed', 'window-removed'])
            ctx.events.on(e, () => this._syncFocus(), run);
        this.desktopLayers.onReserved(run, owner => {
            if (owner !== 'icons')
                this._relayout(true);
        });
        addBackgroundMenuItems(run, (menu, at) => this._wallpaperItems(menu, at));
        this._syncFocus();
        this._source.start();
    }

    _stop() {
        const run = this._run;
        if (!run)
            return;
        this._run = null;
        this._source = null;
        run.dispose();
        this.layer = null;
        this.entries = [];
        this.cells = new Map();
        this.selection.clear();
        this.keyboardFocus = null;
    }

    _buildLayer() {
        this._destroyLayer();
        const m = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        this._layerRun = new CleanupRegistry();
        this.layer = new IconLayer(this, { x: m.x, y: m.y, width: m.width, height: m.height });
        A11y.focusGroup(this._layerRun, this.layer.actor, this._('Desktop'), 'user-desktop-symbolic', {
            focus: () => this._focusDesktop(),
        });
        this._relayout(false);
    }

    _destroyLayer() {
        this._layerRun?.dispose();
        this._layerRun = null;
        this.layer?.destroy();
        this.layer = null;
    }

    // ---- data in: entries, arrangement, previews -------------------------------------------------------

    _onEntries(entries) {
        this.entries = entries;
        this._loaded = true;
        this.selection.retain(entries.map(e => e.key));
        if (this.keyboardFocus && !entries.some(e => e.key === this.keyboardFocus))
            this.keyboardFocus = null;
        if (this._rename && !entries.some(e => e.key === this._rename.key))
            this._closeRename();
        // Forget the places of files that are gone (drives keep theirs)
        const pruned = pruneArrangement(this._stored, entries);
        if (pruned.size !== this._stored.size) {
            this._stored = pruned;
            this._persist();
        }
        this._relayout(true);
        const pending = this._pendingRename;
        if (pending && entries.some(e => e.key === pending)) {
            this._pendingRename = null;
            this.selection.set([pending]);
            this.keyboardFocus = pending;
            this.layer?.refresh();
            this.rename(pending);
        }
    }

    _onThumbnail(entry) {
        this.layer?.tiles.get(entry.key)?.update(entry);
    }

    _loadArrangement() {
        const text = this._ks.string(KEY_LAYOUT);
        if (text === this._written)
            return;
        this._written = text;
        this._stored = parseArrangement(text);
        this._relayout(false);
    }

    _persist() {
        this._written = serializeArrangement(this._stored);
        this._ks.setString(KEY_LAYOUT, this._written);
    }

    // The sort changed (the menu, the preferences): a sort back to None keeps every icon where
    // the sort had put it
    _onSort() {
        const next = isSort(this._ks.string(KEY_SORT)) ? this._ks.string(KEY_SORT) : 'none';
        if (next === this.sort)
            return;
        if (next === 'none')
            this._adoptCells();
        this.sort = next;
        this._relayout(true);
    }

    _adoptCells() {
        for (const [key, c] of this.cells)
            this._stored.set(key, { col: c.col, row: c.row, user: false });
        this._persist();
    }

    // ---- layout ---------------------------------------------------------------------------------------

    _relayout(animate) {
        if (!this.layer || !this._run)
            return;
        const index = Main.layoutManager.primaryIndex;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const metrics = metricsFor(this._ks.int(KEY_SIZE), scale);
        const grid = gridFor(this._layout.workArea(index), metrics);
        this.grid = grid;
        const blocked = blockedCells(this.desktopLayers.reserved('icons'), grid);
        const { cells, assigned } = layoutCells({ entries: this.entries, stored: this._stored, grid, sort: this.sort, blocked });
        this.cells = cells;
        // New files and icons that made room for a widget keep their new place
        if (this.sort === 'none' && this._loaded && assigned.size) {
            for (const [key, c] of assigned)
                this._stored.set(key, { col: c.col, row: c.row, user: false });
            this._persist();
        }
        this.layer.sync(this.entries, cells, grid, metrics, animate);
        this._announceSelection();
    }

    /** Icons in flow order (for ranges and the keyboard). */
    _order() {
        return flowOrder(this.cells, this.grid);
    }

    _entry(key) {
        return this.entries.find(e => e.key === key) ?? null;
    }

    _selected() {
        return this.entries.filter(e => this.selection.has(e.key));
    }

    // ---- focus ---------------------------------------------------------------------------------------

    _syncFocus() {
        const active = desktopInFront(this._desktop?.model.focusedWindow ?? null);
        if (active === this.desktopActive)
            return;
        this.desktopActive = active;
        this.layer?.refresh();
    }

    // Ctrl+Alt+Tab: the desktop takes the keyboard, the first icon is selected when none is
    _focusDesktop() {
        this.layer.takeFocus();
        if (!this.selection.size) {
            const first = neighbour(null, 'down', this.cells);
            if (first)
                this.selection.click(first, {}, this._order());
        }
        this.keyboardFocus = this.keyboardFocus ?? [...this.selection.keys][0] ?? null;
        this.keyboardNav = true;
        this.layer.refresh();
        this._announceSelection();
    }

    /** True while the rename field or a menu owns the pointer: icons ignore new presses. */
    get busy() {
        return !!this._rename;
    }

    // ---- selection (called by the layer and the keys) ------------------------------------------------

    press(key, mods) {
        const joined = this.selection.press(key, mods, this._order());
        this.keyboardFocus = key;
        this.keyboardNav = false;
        this.layer.refresh();
        this._announceSelection();
        return joined;
    }

    collapse(key) {
        this.selection.collapseTo(key);
        this.layer.refresh();
        this._announceSelection();
    }

    setSelection(keys) {
        this.selection.set(keys);
        this.keyboardFocus = this.selection.focus;
        this.layer?.refresh();
        this._announceSelection();
    }

    // Tell whoever puts a drag helper over the icons (core/events.js 'desktop-icons-selection')
    _announceSelection() {
        const selected = this._selected();
        this.ctx.events.emit('desktop-icons-selection', {
            uris: selected.map(e => e.uri),
            rects: selected.map(e => this.layer?.rectOf(e.key)).filter(Boolean),
        });
    }

    // ---- actions ------------------------------------------------------------------------------------

    /** Open the selection (the double-click), or `key` alone when it is not part of it. */
    openSelection(key) {
        const entries = this.selection.has(key) ? this._selected() : [this._entry(key)].filter(Boolean);
        for (const e of entries)
            this._ops.open(e);
    }

    drop(delta) {
        const moved = moveCells(this.cells, this.selection.keys, delta, this.grid);
        if (this.sort !== 'none') {
            // Dragging in a sorted desktop keeps the others where the sort put them
            this._adoptCells();
            this._ks.setString(KEY_SORT, 'none');
            this.sort = 'none';
        }
        for (const [key, c] of moved)
            this._stored.set(key, { col: c.col, row: c.row, user: true });
        this._persist();
        this._relayout(true);
    }

    async newFolder() {
        const folder = this._source?.folder;
        if (!folder)
            return;
        const name = uniqueName(this._('untitled folder'), this.entries.filter(e => e.kind !== 'drive').map(e => e.key));
        this._pendingRename = name;
        if (!await this._ops.newFolder(folder, name))
            this._pendingRename = null;
    }

    rename(key = this.keyboardFocus) {
        const tile = this.layer?.tiles.get(key);
        const entry = this._entry(key);
        if (!tile || !entry || entry.kind === 'drive' || this._rename)
            return;
        this._closeMenu();
        const [x, y] = tile.label.get_transformed_position();
        const w = this.grid.cellW - 8;
        const editor = new RenameEditor({
            tile,
            box: { x: x + (tile.label.width - w) / 2, y: y - 2, width: w },
            accessibleName: this._('Name'),
            validate: text => this._nameProblem(entry, text),
            commit: text => this._commitRename(entry, text),
            cancel: () => this._closeRename(),
        });
        if (editor.ok)
            this._rename = { key, editor };
    }

    _nameProblem(entry, text) {
        const siblings = this.entries.filter(e => e.kind !== 'drive').map(e => e.name);
        const r = validateName(text, entry.name, siblings);
        if (r.ok)
            return null;
        return {
            empty: this._('The name cannot be empty.'),
            slash: this._('The name cannot contain “/”.'),
            dots: this._('That name is not allowed.'),
            long: this._('That name is too long.'),
            exists: this._('A file with that name already exists.'),
        }[r.error];
    }

    async _commitRename(entry, text) {
        this._rename = null;
        const r = validateName(text, entry.name, []);
        if (!r.ok || !r.changed)
            return;
        // The icon keeps its place and its selection under the new name
        const cell = this.cells.get(entry.key);
        if (await this._ops.rename(entry, r.name) && cell) {
            this._stored.delete(entry.key);
            this._stored.set(r.name, { col: cell.col, row: cell.row, user: true });
            this._persist();
            this.selection.set([r.name]);
            this.keyboardFocus = r.name;
        }
    }

    _closeRename() {
        const rename = this._rename;
        this._rename = null;
        rename?.editor.close();
    }

    async trashSelection() {
        const entries = this._selected().filter(e => e.kind !== 'drive');
        if (!entries.length)
            return;
        // The selection moves on to the neighbour that stays, as Files does
        await this._ops.trash(entries);
    }

    // ---- menus ----------------------------------------------------------------------------------------

    /** The right-click menu: on an icon (key) or, from the keyboard, at the focused icon. */
    contextMenu(coords, key) {
        this._closeMenu();
        if (key && !this.selection.has(key)) {
            this.selection.click(key, {}, this._order());
            this.keyboardFocus = key;
            this.layer.refresh();
            this._announceSelection();
        }
        const selected = key ? this._selected() : [];
        const _ = this._;
        const actions = {
            'open': () => selected.forEach(e => this._ops.open(e)),
            'show-in-files': () => this._ops.showInFiles(selected),
            'rename': () => this.rename(selected[0].key),
            'trash': () => this.trashSelection(),
            'eject': () => selected.forEach(e => this._ops.eject(e)),
            'new-folder': () => this.newFolder(),
        };
        const labels = {
            'open': _('Open'), 'show-in-files': _('Show in Files'), 'rename': _('Rename'),
            'trash': _('Move to Trash'), 'eject': _('Eject'), 'new-folder': _('New Folder'),
        };
        this._menu = openContextMenu(this._run, {
            source: this.layer.actor,
            coords,
            styleClass: 'guava-di-menu',
            onClosed: reg => this._closeMenu(reg),
            build: menu => {
                for (const id of menuActions(selected)) {
                    if (id === '-')
                        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    else if (id === 'sort')
                        this._sortMenu(menu);
                    else
                        menu.addAction(labels[id], actions[id]);
                }
            },
        });
    }

    _closeMenu(reg = this._menu) {
        if (!reg || reg !== this._menu)
            return;
        this._menu = null;
        reg.dispose();
    }

    // "New Folder" and "Sort By" at the top of the wallpaper's menu, as on the Finder desktop
    _wallpaperItems(menu, at) {
        const newFolder = new PopupMenu.PopupMenuItem(this._('New Folder'));
        newFolder.connect('activate', () => this.newFolder());
        menu.addMenuItem(newFolder, at.front);
        const sort = this._sortMenu(menu, at.front + 1);
        const separator = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(separator, at.front + 2);
        return [newFolder, sort, separator];
    }

    _sortMenu(menu, position = undefined) {
        const _ = this._;
        const labels = {
            'none': _('None'), 'name': _('Name'), 'kind': _('Kind'), 'date-modified': _('Date Modified'),
            'date-created': _('Date Created'), 'size': _('Size'),
        };
        const item = new PopupMenu.PopupSubMenuMenuItem(_('Sort By'));
        for (const mode of SORTS) {
            const mi = item.menu.addAction(labels[mode], () => this._ks.setString(KEY_SORT, mode));
            mi.setOrnament(mode === this.sort ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        }
        menu.addMenuItem(item, position);
        return item;
    }

    // ---- keys -----------------------------------------------------------------------------------------

    keyPressed(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        if (ARROWS[sym]) {
            this._arrow(ARROWS[sym], shift);
            return Clutter.EVENT_STOP;
        }
        switch (sym) {
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._selected().forEach(e => this._ops.open(e));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_F2:
            if (this.selection.size === 1)
                this.rename([...this.selection.keys][0]);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            this.trashSelection();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            this.setSelection([]);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Menu:
            this._keyboardMenu();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_F10:
            if (shift) {
                this._keyboardMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        default:
        }
        if (ctrl && (sym === Clutter.KEY_a || sym === Clutter.KEY_A) && !shift) {
            this.setSelection(this._order());
            return Clutter.EVENT_STOP;
        }
        if (ctrl && shift && (sym === Clutter.KEY_n || sym === Clutter.KEY_N)) {
            this.newFolder();
            return Clutter.EVENT_STOP;
        }
        const char = Clutter.keysym_to_unicode(sym);
        if (char && !ctrl && !alt && char >= 32) {
            this._typeAhead(String.fromCodePoint(char), event.get_time());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _arrow(direction, extend) {
        const from = this.keyboardFocus ?? [...this.selection.keys][0] ?? null;
        const next = neighbour(from, direction, this.cells);
        if (!next)
            return;
        if (extend)
            this.selection.click(next, { ctrl: true }, this._order());
        else
            this.selection.click(next, {}, this._order());
        this.keyboardFocus = next;
        this.keyboardNav = true;
        this.layer.refresh();
        this._announceSelection();
    }

    _typeAhead(char, time) {
        const t = this._typed;
        t.text = time - t.time > TYPE_AHEAD_MS ? char : t.text + char;
        t.time = time;
        const ordered = this._order().map(k => this._entry(k)).filter(Boolean);
        const key = typeAhead(t.text, ordered, this.keyboardFocus);
        if (!key)
            return;
        this.selection.click(key, {}, this._order());
        this.keyboardFocus = key;
        this.keyboardNav = true;
        this.layer.refresh();
        this._announceSelection();
    }

    _keyboardMenu() {
        const key = this.keyboardFocus;
        const r = key ? this.layer.rectOf(key) : null;
        const coords = r ? [r.x + r.width / 2, r.y + r.height / 2] : [this.layer.monitor.x + 100, this.layer.monitor.y + 100];
        this.contextMenu(coords, key);
    }
}
