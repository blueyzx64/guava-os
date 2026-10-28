// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight view: the search field and the grouped result list inside a ModalSurface frame.
// It holds no search policy. The feature (index.js) feeds it sections and handles activation.
// Keys are read on the entry's own clutter_text, so they work whatever the Shell does with
// the modal's event stream. Selection changes are instant (no animation to reduce).
//
// Tahoe layout: the field with the four browse-view buttons on its right while it is empty
// (a filter chip there while a "/" filter applies), then the results grouped under headers,
// lists or grids (the Apps view). The selected row takes the accent colour.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import * as A11y from '../../lib/a11y.js';
import { IconStyle } from '../../lib/iconStyle.js';
import { SuperTapTracker, flatten, jumpGroup, locate, reselect } from './model.js';
import { VIEWS, moveIn, viewForDigit } from './queryModel.js';

const ROW_ICON = 28;
const TOP_ICON = 40;
const TILE_ICON = 56;
const GRID_COLS = 6;
const ENTRY_ICON = 22;
const VIEW_ICON = 16;
const MAX_LIST_HEIGHT = 440;
const DIGITS = [Clutter.KEY_1, Clutter.KEY_2, Clutter.KEY_3, Clutter.KEY_4];

const SECTION_TITLES = {
    apps: N_('Applications'),
    settings: N_('Settings'),
    documents: N_('Documents'),
    clipboard: N_('Clipboard'),
    calculator: N_('Calculator'),
    other: N_('Other Results'),
    web: N_('Web'),
    suggestions: N_('Suggestions'),
    actions: N_('Actions'),
    menu: N_('Menu Items'),
    filters: N_('Filters'),
    recent: N_('Recents'),
    history: N_('Recent Searches'),
    'all-apps': N_('All Apps'),
    'recent-files': N_('Recent Files'),
    'guava-actions': N_('Guava'),
    'app-actions': N_('App Actions'),
};

function N_(s) {
    return s;
}

// What makes a row look the same: a row with the same key is reused as it is
function rowKey(item, isTop) {
    return [isTop, item.id, item.kind, item.title, item.subtitle, item.quickKey, item.iconName,
        item.gicon?.to_string?.()].join('\u0002');
}

function makeIcon(item, size) {
    const props = { icon_size: size, style_class: 'guava-spotlight-icon' };
    const icon = item.gicon
        ? new St.Icon({ ...props, gicon: item.gicon })
        : new St.Icon({ ...props, icon_name: item.iconName ?? 'application-x-executable' });
    // App icons follow the icon style (Appearance); it untracks itself when the row goes
    if (item.kind === 'app')
        IconStyle.apply(icon);
    return icon;
}

export class SpotlightView {
    /**
     * @param {object} p
     * @param {Function} p.gettext
     * @param {(text:string)=>void} p.onQuery text changed
     * @param {(item:object, opts:{reveal:boolean})=>void} p.onActivate
     * @param {(item:object)=>void} p.onCopy
     * @param {()=>void} p.onClose a Super tap while open
     * @param {(id:string)=>void} p.onView a browse-view button or Super+1..4
     * @param {(direction:number)=>boolean} p.onHistory Up (-1) / Down (+1) in the field; true when used
     * @param {()=>boolean} p.onTab Tab; true when it scoped the search (else Tab jumps groups)
     * @param {(item:object)=>boolean} p.onPreview Space on a selected row; true when it previewed
     * @param {object} p.motion ctx.motion: the list's height eases to its new size
     */
    constructor({ motion, gettext, onQuery, onActivate, onCopy, onClose, onView, onHistory, onTab, onPreview }) {
        this._ = gettext;
        this._motion = motion;
        this._onQuery = onQuery;
        this._onActivate = onActivate;
        this._onCopy = onCopy;
        this._onClose = onClose;
        this._onView = onView;
        this._onHistory = onHistory;
        this._onTab = onTab;
        this._onPreview = onPreview;
        this._sections = [];
        this._index = -1;
        this._moved = false;
        this._rows = [];
        this._cache = new Map();   // key -> list row or section label that survived the last render
        this._lines = [];          // grid lines of the last render (their tiles are not cached)
        this._heightAnim = null;
        this._superTap = new SuperTapTracker();
        this._signals = [];
        this._ui = null;
    }

    /** Build into the modal frame. @returns {Clutter.Actor} the key-focus actor */
    build(frame) {
        const _ = this._;
        const bar = new St.BoxLayout({ style_class: 'guava-spotlight-bar', y_align: Clutter.ActorAlign.CENTER });
        const glyph = new St.Icon({
            icon_name: 'system-search-symbolic', icon_size: ENTRY_ICON, style_class: 'guava-spotlight-glass-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const entry = new St.Entry({
            style_class: 'guava-spotlight-entry', hint_text: _('Search'), can_focus: true, x_expand: true,
            accessible_name: _('Search'),
        });
        bar.add_child(glyph);
        bar.add_child(entry);
        const chip = new St.Label({
            style_class: 'guava-spotlight-chip', visible: false, y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(chip);
        const views = new St.BoxLayout({ style_class: 'guava-spotlight-views', y_align: Clutter.ActorAlign.CENTER });
        const viewButtons = new Map();
        VIEWS.forEach((v, i) => {
            const button = new St.Button({
                style_class: 'guava-spotlight-view-button', can_focus: false, toggle_mode: false,
                accessible_role: A11y.Role.TOGGLE_BUTTON,
                accessible_name: `${_(v.title)} (Super+${i + 1})`,
                child: new St.Icon({ icon_name: v.icon, icon_size: VIEW_ICON }),
            });
            button.connect('clicked', () => this._onView(v.id));
            views.add_child(button);
            viewButtons.set(v.id, button);
        });
        bar.add_child(views);

        const list = new St.BoxLayout({
            style_class: 'guava-spotlight-list', orientation: Clutter.Orientation.VERTICAL,
            accessible_name: _('Results'), accessible_role: A11y.Role.LIST,
        });
        const scroll = new St.ScrollView({
            style_class: 'guava-spotlight-scroll', overlay_scrollbars: true, visible: false,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style: `max-height: ${MAX_LIST_HEIGHT}px;`,
        });
        scroll.set_child(list);
        frame.add_child(bar);
        frame.add_child(scroll);

        const text = entry.clutter_text;
        text.connect('text-changed', () => {
            this._moved = false;
            this._onQuery(entry.get_text());
        });
        text.connect('key-press-event', (_a, event) => this._keyPress(event));

        // Super tap detection sees every key on the modal (capture phase, before the entry), and
        // any accelerator mutter or the Shell runs in between (Super+Space never reaches the
        // stage as a press). The overlay is the grab actor, so the stage itself gets nothing.
        const overlay = frame.get_parent();
        if (overlay) {
            const entry = [overlay, overlay.connect('captured-event', (_a, event) => this._captured(event))];
            this._signals.push(entry);
            // The modal destroys the overlay before onClosed runs; its handlers die with it, so
            // drop the entry rather than disconnect a disposed actor later
            overlay.connect('destroy', () => {
                this._signals = this._signals.filter(e => e !== entry);
            });
        }
        this._signals.push([global.display, global.display.connect('accelerator-activated', () => this._superTap.other())]);
        this._superTap.reset();
        this._ui = { entry, text, list, scroll, chip, views, viewButtons };
        return text;
    }

    get text() {
        return this._ui?.entry.get_text() ?? '';
    }

    /** Replace the field's text (filters, history); the caret goes to the end. */
    setText(text) {
        if (!this._ui)
            return;
        this._ui.entry.set_text(text);
        this._ui.text.set_cursor_position(-1);
    }

    /**
     * The bar's right side: the browse-view buttons (empty field) or the active filter's chip.
     * @param {{views:boolean, activeView:?string, chip:?string}} chrome
     */
    setChrome({ views, activeView, chip }) {
        if (!this._ui)
            return;
        const ui = this._ui;
        ui.views.visible = views;
        for (const [id, button] of ui.viewButtons) {
            button.checked = id === activeView;
        }
        ui.chip.visible = !!chip;
        ui.chip.text = chip ?? '';
    }

    /**
     * Replace the sections. Keeps the selection on the same item once the user moved.
     * @param {object[]} sections
     * @param {{empty?: boolean, waiting?: boolean}} [opts] empty: no hits and none to come, so
     *   say so; waiting: more results are on their way, so the list does not shrink meanwhile
     */
    setSections(sections, { empty = false, waiting = false } = {}) {
        if (!this._ui)
            return;
        this._index = reselect(this._sections, this._index, sections, this._moved);
        this._sections = sections;
        this._render(empty && sections.length === 0, waiting);
    }

    get selected() {
        return locate(this._sections, this._index)?.item ?? null;
    }

    destroy() {
        // Only live objects are left here (global.display, and the overlay if it still exists)
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._superTap.reset();
        this._heightAnim?.cancel();
        this._heightAnim = null;
        this._ui = null;
        this._rows = [];
        this._cache.clear();
        this._lines = [];
        this._sections = [];
    }

    // ---- rendering

    _render(empty, waiting) {
        const { list, scroll } = this._ui;
        const _ = this._;
        const from = scroll.visible ? scroll.height : 0;
        this._heightAnim?.cancel();
        scroll.set_height(-1);

        // Rows and headers that did not change are kept (and reordered), not rebuilt
        const kept = new Map();
        const seen = new Map();
        const take = (key, make) => {
            const n = seen.get(key) ?? 0;
            seen.set(key, n + 1);
            const slot = `${key}\u0001${n}`;
            const actor = this._cache.get(slot) ?? make();
            kept.set(slot, actor);
            return actor;
        };
        const children = [];
        const lines = [];
        this._rows = [];
        let flatIndex = 0;
        if (empty) {
            children.push(take('empty', () => new St.Label({
                text: _('No Results'), style_class: 'guava-spotlight-empty',
            })));
        }
        for (const section of this._sections) {
            const isTop = section.id === 'top';
            const label = isTop
                ? `${_('Top hit')} · ${section.items[0].title}`
                : _(SECTION_TITLES[section.id] ?? '');
            if (label)
                children.push(take(`section:${label}`, () => new St.Label({ text: label, style_class: 'guava-spotlight-section' })));
            if (section.layout === 'grid') {
                for (let i = 0; i < section.items.length; i += GRID_COLS) {
                    const line = new St.BoxLayout({ style_class: 'guava-spotlight-grid-row' });
                    for (const item of section.items.slice(i, i + GRID_COLS)) {
                        const tile = this._makeTile(item);
                        tile._guavaIndex = flatIndex++;
                        this._rows.push(tile);
                        line.add_child(tile);
                    }
                    children.push(line);
                    lines.push(line);
                }
                continue;
            }
            for (const item of section.items) {
                const row = take(rowKey(item, isTop), () => this._makeRow(item, isTop));
                row._guavaItem = item;
                row._guavaIndex = flatIndex++;
                this._rows.push(row);
                children.push(row);
            }
        }
        for (const [slot, actor] of this._cache) {
            if (!kept.has(slot))
                actor.destroy();
        }
        this._lines.forEach(line => line.destroy());
        this._cache = kept;
        this._lines = lines;
        children.forEach((child, i) => {
            if (list.get_child_at_index(i) === child)
                return;
            if (child.get_parent() === list)
                list.set_child_at_index(child, i);
            else
                list.insert_child_at_index(child, i);
        });
        scroll.visible = children.length > 0;
        this._paintSelection(false);
        this._easeHeight(from, waiting);
    }

    /** The list grows or shrinks to its new height instead of snapping (it only grows while waiting). */
    _easeHeight(from, waiting) {
        const { scroll } = this._ui;
        if (!scroll.visible)
            return;
        const [, to] = scroll.get_preferred_height(-1);
        if (Math.abs(to - from) < 1)
            return;
        if (waiting && to < from) {
            scroll.set_height(from);
            return;
        }
        scroll.set_height(from);
        this._heightAnim = this._motion.ease(scroll, { height: to }, {
            duration: 'short', curve: 'standard',
            onDone: finished => {
                if (finished && this._ui)
                    this._ui.scroll.set_height(-1);
            },
        });
    }

    _makeTile(item) {
        const tile = new St.BoxLayout({
            style_class: 'guava-spotlight-row guava-spotlight-tile', orientation: Clutter.Orientation.VERTICAL,
            reactive: true, track_hover: true, accessible_name: item.title,
            accessible_role: A11y.Role.LIST_ITEM,
        });
        const icon = makeIcon(item, TILE_ICON);
        icon.x_align = Clutter.ActorAlign.CENTER;
        tile.add_child(icon);
        const title = new St.Label({ text: item.title, style_class: 'guava-spotlight-tile-title', x_align: Clutter.ActorAlign.CENTER });
        title.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        tile.add_child(title);
        tile._guavaItem = item;
        this._wireRow(tile);
        return tile;
    }

    _makeRow(item, isTop) {
        const extra = [
            isTop ? ' guava-spotlight-top' : '',
            item.kind === 'calc' ? ' guava-spotlight-calc' : '',
            item.kind === 'note' ? ' guava-spotlight-note' : '',
        ].join('');
        const row = new St.BoxLayout({
            style_class: `guava-spotlight-row${extra}`,
            reactive: true, track_hover: true, x_expand: true,
            accessible_name: item.subtitle ? `${item.title}, ${item.subtitle}` : item.title,
            accessible_role: A11y.Role.LIST_ITEM,
        });
        row.add_child(makeIcon(item, isTop ? TOP_ICON : ROW_ICON));
        const texts = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'guava-spotlight-texts',
        });
        const title = new St.Label({ text: item.title, style_class: 'guava-spotlight-title' });
        title.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        texts.add_child(title);
        if (item.subtitle) {
            const sub = new St.Label({ text: item.subtitle, style_class: 'guava-spotlight-subtitle' });
            sub.clutter_text.ellipsize = 3;
            texts.add_child(sub);
        }
        row.add_child(texts);
        if (item.quickKey) {
            row.add_child(new St.Label({
                text: item.quickKey, style_class: 'guava-spotlight-key', y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (item.kind !== 'note') {
            row.add_child(new St.Label({
                text: '↵', style_class: 'guava-spotlight-return', y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row._guavaItem = item;
        this._wireRow(row);
        return row;
    }

    // Rows outlive renders, so the index and item are read from the row when the event comes
    _wireRow(row) {
        row.connect('enter-event', () => {
            const index = row._guavaIndex;
            // Pointer movement only: a list that re-renders under a still pointer must not steal the selection
            if (this._index !== index && this._pointerMoved(row)) {
                this._index = index;
                this._moved = true;
                this._paintSelection(false);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        row.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            this._index = row._guavaIndex;
            this._onActivate(row._guavaItem, { reveal: false });
            return Clutter.EVENT_STOP;
        });
    }

    _pointerMoved(row) {
        // A row that just appeared under the pointer fires enter-event without a move; ignore
        // the first enter after a render.
        if (row._guavaSeen)
            return true;
        row._guavaSeen = true;
        return false;
    }

    _paintSelection(scroll = true) {
        this._rows.forEach((row, i) => {
            if (i === this._index)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        const row = this._rows[this._index];
        A11y.describeSelection(this._ui.entry, row?.accessible_name);
        if (row && scroll)
            ensureActorVisibleInScrollView(this._ui.scroll, row);
    }

    // ---- keys

    _keyPress(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const superKey = (state & (Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK)) !== 0;
        // The signal runs before ClutterText's own handler, which is where the input method
        // filters keys. While there is preedit text (IBus composing), Return commits it and the
        // arrows move in the candidate list, so leave those keys alone.
        if (this._ui.text.has_preedit?.())
            return Clutter.EVENT_PROPAGATE;

        // Super+1..4: the browse views (macOS ⌘1..⌘4)
        const digit = DIGITS.indexOf(sym);
        if (superKey && digit >= 0) {
            this._superTap.other();
            this._onView(viewForDigit(digit + 1));
            return Clutter.EVENT_STOP;
        }

        switch (sym) {
        case Clutter.KEY_Down:
            if (!this._moved && this._onHistory(1))
                return Clutter.EVENT_STOP;
            return this._move('down');
        case Clutter.KEY_Up:
            if (!this._moved && this._onHistory(-1))
                return Clutter.EVENT_STOP;
            return this._move('up');
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
            // Only a grid takes the arrows; in a list they move the caret
            if (!this._inGrid())
                return Clutter.EVENT_PROPAGATE;
            return this._move(sym === Clutter.KEY_Left ? 'left' : 'right');
        case Clutter.KEY_Tab:
            if (this._onTab())
                return Clutter.EVENT_STOP;
            return this._jump(false);
        case Clutter.KEY_ISO_Left_Tab:
            return this._jump(true);
        case Clutter.KEY_space: {
            // Quick Look once a row was chosen with the keys, or in an empty field (a view)
            const item = this.selected;
            if (item && (this._moved || !this.text) && this._onPreview(item))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: {
            const item = this.selected;
            if (item)
                this._onActivate(item, { reveal: ctrl });
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_c:
        case Clutter.KEY_C: {
            // Ctrl+C copies the result unless the user selected text in the field
            if (!ctrl || this._ui.text.get_selection())
                return Clutter.EVENT_PROPAGATE;
            const item = this.selected;
            if (!item)
                return Clutter.EVENT_PROPAGATE;
            this._onCopy(item);
            return Clutter.EVENT_STOP;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _inGrid() {
        let i = this._index;
        for (const s of this._sections) {
            if (i >= 0 && i < s.items.length)
                return s.layout === 'grid';
            i -= s.items.length;
        }
        return this._index < 0 && this._sections[0]?.layout === 'grid';
    }

    _captured(event) {
        const type = event.type();
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();
        const isSuper = sym === Clutter.KEY_Super_L || sym === Clutter.KEY_Super_R;
        if (!isSuper) {
            this._superTap.other();
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.KEY_PRESS) {
            this._superTap.press(event.get_time());
            return Clutter.EVENT_PROPAGATE;
        }
        if (this._superTap.release(event.get_time())) {
            // A Super tap closes Spotlight (overlay-key is not delivered in a popup grab)
            this._onClose();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _move(key) {
        if (flatten(this._sections).length === 0)
            return Clutter.EVENT_PROPAGATE;
        this._index = moveIn(this._sections, this._index, key, GRID_COLS);
        this._moved = true;
        this._paintSelection();
        return Clutter.EVENT_STOP;
    }

    _jump(backwards) {
        if (this._sections.length === 0)
            return Clutter.EVENT_STOP;
        this._index = jumpGroup(this._sections, this._index, backwards);
        this._moved = true;
        this._paintSelection();
        return Clutter.EVENT_STOP;
    }
}
