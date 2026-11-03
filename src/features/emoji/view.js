// SPDX-License-Identifier: GPL-3.0-or-later
// The Emoji & Symbols popover content (inside a ModalSurface frame): a search field and the
// skin-tone button on top, the emoji grid, the name of the selected emoji, and the category
// tabs at the bottom, like the compact macOS Character Viewer.
//
//   typing  searches          arrows  move          Enter  types the emoji
//   Tab / Shift+Tab  next / previous category       Esc    closes (ModalSurface)

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {
    CATEGORIES, COLUMNS, TONE_SWATCHES, categoryCells, moveInGrid, nextCategory, search, withTone,
} from './model.js';
import * as A11y from '../../lib/a11y.js';

const MOVES = new Map([
    [Clutter.KEY_Left, 'left'], [Clutter.KEY_Right, 'right'],
    [Clutter.KEY_Up, 'up'], [Clutter.KEY_Down, 'down'],
]);

export class EmojiView {
    /**
     * @param {object} p
     * @param {Function} p.gettext
     * @param {() => ?object} p.catalog the catalogue, null while loading or when missing
     * @param {() => string} p.status 'loading' | 'missing' | 'ready'
     * @param {() => string[]} p.recents
     * @param {() => number} p.tone
     * @param {(tone: number) => void} p.setTone
     * @param {(char: string) => void} p.onPick
     */
    constructor(p) {
        this._p = p;
        this._ui = null;
        this._cells = [];       // [{char, item, button}]
        this._selected = -1;
        this._query = '';
        this._category = 'smileys';
    }

    /** Build into the frame. @returns {Clutter.Actor} the key focus (the search text) */
    build(frame, category) {
        const _ = this._p.gettext;
        this._query = '';
        this._category = category;
        const header = new St.BoxLayout({ style_class: 'guava-emoji-header', x_expand: true });
        const entry = new St.Entry({
            style_class: 'guava-emoji-search', hint_text: _('Search'), accessible_name: _('Search Emoji'), can_focus: true, x_expand: true,
            primary_icon: new St.Icon({ icon_name: 'system-search-symbolic', style_class: 'guava-emoji-search-icon' }),
        });
        entry.clutter_text.connect('text-changed', () => {
            this._query = entry.get_text();
            this._render();
        });
        entry.clutter_text.connect('activate', () => this._pickSelected());
        header.add_child(entry);
        const tone = new St.Button({
            style_class: 'guava-emoji-tone', can_focus: true, accessible_name: _('Skin tone'),
            label: TONE_SWATCHES[this._p.tone()],
        });
        tone.connect('clicked', () => {
            const next = (this._p.tone() + 1) % TONE_SWATCHES.length;
            this._p.setTone(next);
            tone.label = TONE_SWATCHES[next];
            this._render();
        });
        header.add_child(tone);
        frame.add_child(header);

        const title = new St.Label({ style_class: 'guava-emoji-section', x_expand: true });
        frame.add_child(title);
        const scroll = new St.ScrollView({
            style_class: 'guava-emoji-scroll', x_expand: true, y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const grid = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'guava-emoji-grid' });
        scroll.set_child(grid);
        frame.add_child(scroll);
        const name = new St.Label({ style_class: 'guava-emoji-name', x_expand: true });
        frame.add_child(name);

        const tabs = new St.BoxLayout({ style_class: 'guava-emoji-tabs', x_expand: true });
        const tabButtons = new Map();
        for (const c of CATEGORIES) {
            const b = new St.Button({
                style_class: 'guava-emoji-tab', can_focus: true, toggle_mode: false, x_expand: true,
                accessible_role: A11y.Role.TOGGLE_BUTTON,
                accessible_name: _(c.label),
                child: new St.Icon({ icon_name: c.icon, style_class: 'guava-emoji-tab-icon' }),
            });
            b.connect('clicked', () => this.showCategory(c.id));
            tabs.add_child(b);
            tabButtons.set(c.id, b);
        }
        frame.add_child(tabs);

        this._ui = { entry, tone, title, scroll, grid, name, tabButtons };
        this._render();
        return entry.clutter_text;
    }

    destroy() {
        this._ui = null;
        this._cells = [];
        this._selected = -1;
    }

    /** The catalogue arrived (or failed) while open. */
    refresh() {
        this._render();
    }

    showCategory(id) {
        this._category = id;
        if (this._ui && this._query) {
            this._ui.entry.set_text('');    // text-changed renders
            return;
        }
        this._render();
    }

    get category() {
        return this._category;
    }

    /** For the harness: the cells on screen and the selection. */
    get state() {
        return {
            category: this._category, query: this._query, count: this._cells.length,
            selected: this._cells[this._selected]?.char ?? null,
            first: this._cells.slice(0, 5).map(c => c.char),
        };
    }

    _render() {
        const ui = this._ui;
        if (!ui)
            return;
        const _ = this._p.gettext;
        for (const [id, b] of ui.tabButtons) {
            b.checked = id === this._category && !this._query;
        }
        ui.grid.destroy_all_children();
        this._cells = [];
        this._selected = -1;
        const catalog = this._p.catalog();
        const status = this._p.status();
        if (!catalog) {
            ui.title.text = '';
            ui.name.text = status === 'loading' ? _('Loading…')
                : _('No emoji data found. Install IBus (the ibus package) to use Emoji & Symbols.');
            return;
        }
        let cells;
        if (this._query) {
            const tone = this._p.tone();
            cells = search(catalog, this._query).map(item => ({ char: withTone(item, tone), item }));
            ui.title.text = _('Search Results');
        } else {
            cells = categoryCells(catalog, this._category, this._p.tone(), this._p.recents());
            ui.title.text = _(CATEGORIES.find(c => c.id === this._category)?.label ?? '');
        }
        let row = null;
        cells.forEach((cell, i) => {
            if (i % COLUMNS === 0) {
                row = new St.BoxLayout({ style_class: 'guava-emoji-row' });
                ui.grid.add_child(row);
            }
            const button = new St.Button({
                style_class: 'guava-emoji-cell', label: cell.char, can_focus: false, accessible_name: cell.item.name,
            });
            button.connect('clicked', () => this._p.onPick(cell.char));
            button.connect('notify::hover', () => {
                if (button.hover)
                    ui.name.text = cell.item.name;
            });
            row.add_child(button);
            this._cells.push({ ...cell, button });
        });
        if (!cells.length) {
            ui.name.text = this._query ? _('No Results') : this._category === 'recent'
                ? _('Emoji you use show up here') : '';
            return;
        }
        this._select(0);
    }

    _select(index) {
        const prev = this._cells[this._selected];
        prev?.button.remove_style_pseudo_class('selected');
        this._selected = index;
        const cell = this._cells[index];
        if (!cell)
            return;
        cell.button.add_style_pseudo_class('selected');
        this._ui.name.text = cell.item.name;
        A11y.describeSelection(this._ui.entry, cell.item.name);
        this._scrollTo(cell.button.get_parent());
    }

    _scrollTo(row) {
        const adj = this._ui.scroll.vadjustment ?? this._ui.scroll.get_vadjustment?.();
        if (!adj || !row)
            return;
        const top = row.get_y();
        const bottom = top + row.get_height();
        if (top < adj.value)
            adj.value = top;
        else if (bottom > adj.value + adj.page_size)
            adj.value = bottom - adj.page_size;
    }

    _pickSelected() {
        const cell = this._cells[this._selected] ?? this._cells[0];
        if (cell)
            this._p.onPick(cell.char);
    }

    /** ModalSurface capture phase: arrows and Tab before the entry sees them. */
    onCapturedKey(event) {
        if (this._ui?.entry.clutter_text.has_preedit?.())
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();
        const move = MOVES.get(sym);
        if (move) {
            // Left/Right edit the search text while there is some
            if (this._query && (move === 'left' || move === 'right'))
                return Clutter.EVENT_PROPAGATE;
            this._select(moveInGrid(this._selected, move, this._cells.length));
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            this.showCategory(nextCategory(this._category, shift || sym === Clutter.KEY_ISO_Left_Tab ? -1 : 1));
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            this._pickSelected();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}
