// SPDX-License-Identifier: GPL-3.0-or-later
// Top-bar popover, minimal like the macOS clipboard managers: a compact search field, small
// filter chips, one-line rows (type icon, preview, time) with the first row selected, a
// centred empty state, and a quiet footer (Recording switch, Clear). Up/Down move the
// selection from the search field and Enter copies it; Quick Paste stays the full keyboard
// surface.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { ModalSurface } from '../../lib/modalSurface.js';
import { addRow, sectionLabel } from './view.js';

const WIDTH = 340;
const MAX_ROWS = 80;
const ROW_TILE = 24;

export class ClipboardPopover {
    /**
     * @param {PopupMenu.PopupMenu} menu the indicator's menu
     * @param {object} ctl controller (index.js)
     * @param {object} cleanup CleanupRegistry
     * @param {Function} _ gettext
     */
    constructor(menu, ctl, cleanup, _) {
        this._menu = menu;
        this._ctl = ctl;
        this._ = _;
        this._filter = 'all';
        this._query = '';
        this._glass = null;
        this._entries = [];
        this._selected = -1;

        this._build();
        cleanup.connect(menu, 'open-state-changed', (_m, open) => this._onOpen(open));
        cleanup.add(ctl.connectChanged(() => this._menu.isOpen && this._refresh()));
        cleanup.add(() => this._detachGlass());
        this._attachGlass();
        // Secondary text needs its own shade per style to stay readable
        Glass.watch(cleanup, ({ env }) => {
            if (env.dark)
                this._root.remove_style_class_name('guava-clip-light');
            else
                this._root.add_style_class_name('guava-clip-light');
        });
    }

    _build() {
        const _ = this._;
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false, activate: false });
        item.add_style_class_name('guava-clip-popover-item');
        const root = new St.BoxLayout({
            style_class: 'guava-clip-popover', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, width: WIDTH,
        });
        item.add_child(root);
        this._root = root;

        this._entry = new St.Entry({
            style_class: 'guava-clip-search', hint_text: _('Search'), accessible_name: _('Search Clipboard'), can_focus: true, x_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic', style_class: 'guava-clip-search-icon' }),
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._query = this._entry.get_text();
            this._refresh();
        });
        this._entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        root.add_child(this._entry);

        const filters = new St.BoxLayout({ style_class: 'guava-clip-filters' });
        this._filterButtons = new Map();
        for (const [id, label] of [['all', _('All')], ['text', _('Text')], ['links', _('Links')], ['images', _('Images')]]) {
            const b = new St.Button({ label, style_class: 'guava-clip-filter', can_focus: true, toggle_mode: true,
                accessible_name: label, accessible_role: A11y.Role.TOGGLE_BUTTON });
            b.connect('clicked', () => {
                this._filter = id;
                this._syncFilters();
                this._refresh();
            });
            this._filterButtons.set(id, b);
            filters.add_child(b);
        }
        root.add_child(filters);
        this._filters = filters;

        // Natural height up to a cap (stylesheet max-height): three rows make a short list
        this._scroll = new St.ScrollView({
            style_class: 'guava-clip-scroll', overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._list = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        this._scroll.set_child(this._list);
        root.add_child(this._scroll);

        const foot = new St.BoxLayout({ style_class: 'guava-clip-foot' });
        this._switch = new PopupMenu.Switch(this._ctl.recording);
        const toggle = this._recToggle = new St.Button({
            style_class: 'guava-clip-recording', can_focus: true, reactive: true, child: this._switch,
            accessible_name: _('Recording'), accessible_role: A11y.Role.TOGGLE_BUTTON, toggle_mode: true,
            checked: this._ctl.recording, y_align: Clutter.ActorAlign.CENTER,
        });
        toggle.connect('clicked', () => this._ctl.setRecording(!this._ctl.recording));
        this._recLabel = new St.Label({
            style_class: 'guava-clip-recording-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        foot.add_child(toggle);
        foot.add_child(this._recLabel);
        const clear = new St.Button({
            label: _('Clear'), accessible_name: _('Clear Clipboard History'), style_class: 'guava-clip-clear', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
        });
        clear.connect('clicked', () => this._ctl.clear());
        foot.add_child(clear);
        root.add_child(foot);

        this._menu.addMenuItem(item);
        this._syncFilters();
    }

    _syncFilters() {
        for (const [id, b] of this._filterButtons)
            b.checked = id === this._filter;
    }

    _onOpen(open) {
        if (!open)
            return;
        // One Guava modal at a time
        ModalSurface.closeAll();
        this._refresh();
        this._entry.clutter_text.grab_key_focus();
    }

    // ---- selection: Up/Down from the search field, Enter copies ----

    _rows() {
        return this._list.get_children().filter(child => child.entryId !== undefined);
    }

    _select(index) {
        const rows = this._rows();
        this._selected = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
        rows.forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        const row = rows[this._selected];
        A11y.describeSelection(this._entry, row?.accessible_name);
        if (row) {
            const adj = this._scroll.vadjustment;
            const [top, bottom] = [row.y, row.y + row.height];
            if (top < adj.value)
                adj.value = top;
            else if (bottom > adj.value + adj.page_size)
                adj.value = bottom - adj.page_size;
        }
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            this._select(this._selected + (key === Clutter.KEY_Down ? 1 : -1));
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            const row = this._rows()[this._selected];
            const entry = row && this._entries.find(e => e.id === row.entryId);
            if (entry)
                this._ctl.copy(entry, { close: true });
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _refresh() {
        const _ = this._;
        const ctl = this._ctl;
        // Header and footer first: they must be right even if a row fails
        this._switch.state = ctl.recording;
        this._recToggle.checked = ctl.recording;
        this._recLabel.text = ctl.recording ? _('Recording') : _('Paused');
        this._entry.hint_text = ctl.count
            ? _('Search %d items').replace('%d', ctl.count)
            : _('Search');

        const { pinned, recent } = ctl.view({ filter: this._filter, query: this._query });
        this._entries = [...pinned, ...recent];
        this._list.destroy_all_children();
        const now = Date.now();
        let shown = 0;
        const add = rows => {
            for (const e of rows) {
                if (shown++ >= MAX_ROWS)
                    return;
                addRow(this._list, e, ctl, _, {
                    onActivate: en => ctl.copy(en, { close: true }), now, compact: true, tile: ROW_TILE,
                });
            }
        };
        if (pinned.length) {
            this._list.add_child(sectionLabel(_('Pinned')));
            add(pinned);
        }
        if (pinned.length && recent.length)
            this._list.add_child(sectionLabel(_('Recent')));
        add(recent);
        if (!pinned.length && !recent.length)
            this._list.add_child(this._emptyState(ctl.count > 0));
        // Nothing to filter yet: the chips would only be clutter around the empty state
        this._filters.visible = ctl.count > 0;
        this._select(0);
    }

    /** A centred, gentle message: nothing copied yet, or no match for the search. */
    _emptyState(searching) {
        const _ = this._;
        const box = new St.BoxLayout({
            style_class: 'guava-clip-empty', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({
            icon_name: searching ? 'edit-find-symbolic' : 'edit-paste-symbolic',
            style_class: 'guava-clip-empty-icon', x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: searching ? _('No matches') : _('Nothing copied yet'),
            style_class: 'guava-clip-empty-title', x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: searching ? _('Try another word or filter.') : _('Text, links and images you copy appear here.'),
            style_class: 'guava-clip-empty-hint', x_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    // ---- glass: the rounded menu box, its BoxPointer bin carries the shadow (lib/glass.js) ----

    _attachGlass() {
        if (!this._menu.box)
            return;
        try {
            this._glass = Glass.attachMenu(this._menu, { surface: 'overlays' });
        } catch (e) {
            console.warn(`[Guava] clipboard popover glass failed: ${e.message}`);
        }
    }

    _detachGlass() {
        this._glass?.destroy();
        this._glass = null;
    }
}
