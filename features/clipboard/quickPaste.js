// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Paste: a centred glass window (ModalSurface). List on the left, large preview on the
// right, Paste and Pin under the preview, keyboard hints in the footer. Enter pastes into
// the window that had focus before it opened.
//   Up/Down  move      Enter  paste      Ctrl+P  pin      Ctrl+D  remove      Esc  close
//   typing   searches (the entry keeps key focus)

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as A11y from '../../lib/a11y.js';
import { ModalSurface } from '../../lib/modalSurface.js';
import { addRow, ageText, longPreview, sectionLabel, sizeText } from './view.js';

const WIDTH = 780;
const HEIGHT = 460;
const LIST_WIDTH = 300;
const MAX_ROWS = 100;
const PREVIEW_ICON = 280;

export class QuickPaste {
    constructor(cleanup, ctl, _) {
        this._ctl = ctl;
        this._ = _;
        this._query = '';
        this._order = [];       // entry ids in list order
        this._selected = null;
        this._ui = null;
        cleanup.add(ctl.connectChanged(() => this._modal.isOpen && this._refresh()));
        this._modal = new ModalSurface(cleanup, {
            id: 'quick-paste',
            accessibleName: _('Clipboard History'),
            width: WIDTH,
            height: HEIGHT,
            position: 'center',
            radius: 26,
            styleClass: 'guava-quick-paste',
            build: frame => this._build(frame),
            onCapturedKey: event => this._onKey(event),
            onClosed: () => {
                this._ui = null;
                this._order = [];
                this._query = '';
            },
        });
    }

    get isOpen() {
        return this._modal.isOpen;
    }

    toggle() {
        this._modal.toggle();
    }

    close() {
        this._modal.close();
    }

    _build(frame) {
        const _ = this._;
        this._query = '';
        const entry = new St.Entry({
            style_class: 'guava-qp-search', hint_text: _('Search Clipboard'), accessible_name: _('Search Clipboard'), can_focus: true, x_expand: true,
        });
        entry.clutter_text.connect('text-changed', () => {
            this._query = entry.get_text();
            this._selected = null;
            this._refresh();
        });
        entry.clutter_text.connect('activate', () => this._paste());
        frame.add_child(entry);

        const body = new St.BoxLayout({ style_class: 'guava-qp-body', x_expand: true, y_expand: true });
        frame.add_child(body);

        const scroll = new St.ScrollView({
            style_class: 'guava-qp-list', width: LIST_WIDTH, y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const list = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        scroll.set_child(list);
        body.add_child(scroll);

        const side = new St.BoxLayout({
            style_class: 'guava-qp-side', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
        });
        body.add_child(side);
        const previewBox = new St.BoxLayout({
            style_class: 'guava-qp-preview', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
        });
        side.add_child(previewBox);
        const meta = new St.Label({ style_class: 'guava-qp-meta' });
        side.add_child(meta);

        const buttons = new St.BoxLayout({ style_class: 'guava-qp-buttons' });
        const paste = new St.Button({ label: _('Paste'), style_class: 'guava-qp-button guava-qp-primary', can_focus: true });
        paste.connect('clicked', () => this._paste());
        const pin = new St.Button({ label: _('Pin'), style_class: 'guava-qp-button', can_focus: true });
        pin.connect('clicked', () => this._pin());
        buttons.add_child(paste);
        buttons.add_child(pin);
        side.add_child(buttons);

        frame.add_child(new St.Label({
            style_class: 'guava-qp-hints',
            text: _('↑↓ Select    ↵ Paste    Ctrl+P Pin    Ctrl+D Remove    Esc Close'),
        }));

        this._ui = { entry, list, scroll, previewBox, meta, pin };
        this._refresh();
        return entry.clutter_text;
    }

    _refresh() {
        const ui = this._ui;
        if (!ui)
            return;
        const _ = this._;
        const ctl = this._ctl;
        const { pinned, recent } = ctl.view({ query: this._query });
        const all = [...pinned, ...recent].slice(0, MAX_ROWS);
        this._order = all.map(e => e.id);
        if (!this._order.includes(this._selected))
            this._selected = this._order[0] ?? null;

        ui.list.destroy_all_children();
        const now = Date.now();
        const shownPinned = all.filter(e => e.pinned);
        const shownRecent = all.filter(e => !e.pinned);
        const add = rows => rows.forEach(e => addRow(ui.list, e, ctl, _, {
            tile: 30, now, onActivate: en => {
                this._selected = en.id;
                this._paste();
            },
        }));
        if (shownPinned.length) {
            ui.list.add_child(sectionLabel(_('Pinned')));
            add(shownPinned);
        }
        if (shownRecent.length) {
            ui.list.add_child(sectionLabel(_('Recent')));
            add(shownRecent);
        }
        if (!all.length) {
            ui.list.add_child(new St.Label({
                text: ctl.count ? _('No matches') : _('Nothing copied yet'), style_class: 'guava-clip-empty',
            }));
        }
        this._syncSelection();
    }

    _syncSelection() {
        const ui = this._ui;
        if (!ui)
            return;
        const _ = this._;
        for (const row of ui.list.get_children()) {
            if (row.entryId === undefined)
                continue;
            if (row.entryId === this._selected) {
                row.add_style_pseudo_class('selected');
                this._scrollTo(row);
            } else {
                row.remove_style_pseudo_class('selected');
            }
        }
        const entry = this._selected ? this._ctl.get(this._selected) : null;
        A11y.describeSelection(ui.entry, ui.list.get_children().find(r => r.entryId === this._selected)?.accessible_name);
        ui.previewBox.destroy_all_children();
        if (!entry) {
            ui.meta.text = '';
            ui.pin.label = _('Pin');
            return;
        }
        ui.pin.label = entry.pinned ? _('Unpin') : _('Pin');
        if (entry.kind === 'image') {
            const gicon = this._ctl.iconFor(entry);
            if (gicon) {
                ui.previewBox.add_child(new St.Icon({
                    gicon, icon_size: PREVIEW_ICON, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true, y_expand: true,
                }));
            }
        } else if (entry.type === 'color') {
            ui.previewBox.add_child(new St.Widget({
                style_class: 'guava-qp-swatch', style: `background-color: ${entry.text.trim()};`,
                x_expand: true, y_expand: true,
            }));
            ui.previewBox.add_child(new St.Label({ text: entry.text.trim(), style_class: 'guava-qp-color-text' }));
        } else {
            const sv = new St.ScrollView({
                x_expand: true, y_expand: true, overlay_scrollbars: true,
                hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });
            const label = new St.Label({ text: longPreview(entry), style_class: 'guava-qp-text' });
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_ellipsize(0);          // Pango.EllipsizeMode.NONE
            // A ScrollView child must be StScrollable (GNOME 46+): wrap the label in a box
            const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
            box.add_child(label);
            sv.set_child(box);
            ui.previewBox.add_child(sv);
        }
        const kind = { text: _('Text'), link: _('Link'), color: _('Colour'), image: _('Image') }[entry.type];
        ui.meta.text = [kind, entry.app, ageText(entry, Date.now(), _), sizeText(entry.size)]
            .filter(Boolean).join(' · ');
    }

    _scrollTo(row) {
        const adj = this._ui.scroll.vadjustment ?? this._ui.scroll.get_vadjustment?.();
        if (!adj)
            return;
        const top = row.get_y();
        const bottom = top + row.get_height();
        if (top < adj.value)
            adj.value = top;
        else if (bottom > adj.value + adj.page_size)
            adj.value = bottom - adj.page_size;
    }

    _move(delta) {
        if (!this._order.length)
            return;
        const at = this._order.indexOf(this._selected);
        const next = Math.min(this._order.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta));
        this._selected = this._order[next];
        this._syncSelection();
    }

    _paste() {
        const entry = this._selected ? this._ctl.get(this._selected) : null;
        if (entry)
            this._ctl.paste(entry);
    }

    _pin() {
        if (this._selected)
            this._ctl.togglePin(this._selected);
    }

    _onKey(event) {
        // While an input method is composing (preedit), its keys belong to the entry
        const text = this._ui?.entry.clutter_text;
        if (text?.has_preedit?.())
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        switch (sym) {
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._move(-5);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._move(5);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (!ctrl)
                return Clutter.EVENT_PROPAGATE;
            this._pin();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_d:
        case Clutter.KEY_D: {
            if (!ctrl)
                return Clutter.EVENT_PROPAGATE;
            if (!this._selected)
                return Clutter.EVENT_STOP;
            const at = this._order.indexOf(this._selected);
            const id = this._selected;
            this._selected = this._order[at + 1] ?? this._order[at - 1] ?? null;
            this._ctl.remove(id);
            return Clutter.EVENT_STOP;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
