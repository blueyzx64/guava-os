// SPDX-License-Identifier: GPL-3.0-or-later
// Edit Controls (macOS Tahoe): the Control Center's edit mode.
//
// While editing, the live grid gives way to this view inside the same glass menu:
//   - a preview of the layout in the grid's 4 columns, each control a tile with a remove
//     button, a size button (small / medium / large, as the control allows), move-left and
//     move-right buttons, and a pin button for controls that can live in the menu bar
//     (lib/menuBarPins.js: Always / Never; "When Active" is in the prefs);
//   - the gallery: every available control by section, with a search field; a click adds a
//     control at the end (or removes it, when it is already in);
//   - Reset (Guava's default arrangement) and Done.
// The view only edits values (customModel.js) and hands the new layout to `setLayout`;
// the Control Center persists it and re-lays the live grid out.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as A11y from '../../lib/a11y.js';
import { pinMode, setPin } from '../../lib/menuBarPins.js';
import {
    addControl, control, gallery, moveControl, nextSize, packRows, pinOf, removeControl, setSize,
} from './customModel.js';
import { guavaGicon } from './tiles.js';

const ICON_SIZE = 16;
const SMALL_ICON = 12;

function iconButton(iconName, name, onClick, { checked = null, sensitive = true } = {}) {
    const button = new St.Button({
        style_class: 'guava-cc-edit-button',
        accessible_name: name,
        can_focus: true,
        track_hover: true,
        reactive: sensitive,
        toggle_mode: checked !== null,
        child: new St.Icon({ icon_name: iconName, icon_size: SMALL_ICON }),
    });
    if (checked !== null) {
        button.checked = checked;
        button.accessible_role = A11y.Role.TOGGLE_BUTTON;
    }
    if (!sensitive) {
        // Neither clickable nor a dead tab stop
        A11y.setEnabled(button, false);
        button.add_style_pseudo_class('insensitive');
    }
    button.connect('clicked', () => onClick());
    return button;
}

export class ControlsEditor {
    /**
     * @param {object} opts
     * @param {object} opts.ctx the feature ctx (settings, gettext, extension)
     * @param {() => {id: string, size: string}[]} opts.getLayout
     * @param {(layout: {id: string, size: string}[]) => void} opts.setLayout
     * @param {(id: string) => boolean} opts.available
     * @param {() => void} opts.onDone
     * @param {() => void} opts.onReset
     */
    constructor({ ctx, getLayout, setLayout, available, onDone, onReset }) {
        this._ctx = ctx;
        this._ = ctx.gettext;
        this._getLayout = getLayout;
        this._setLayout = setLayout;
        this._available = available;
        const _ = this._;

        this.actor = new St.BoxLayout({
            style_class: 'guava-cc-editor',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const head = new St.BoxLayout({ style_class: 'guava-cc-editor-head' });
        head.add_child(new St.Label({
            text: _('Edit Controls'), style_class: 'guava-cc-editor-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        const reset = new St.Button({ style_class: 'guava-cc-editor-text-button', label: _('Reset'), can_focus: true });
        reset.connect('clicked', () => onReset());
        const done = new St.Button({ style_class: 'guava-cc-editor-text-button guava-cc-editor-done', label: _('Done'), can_focus: true });
        done.connect('clicked', () => onDone());
        head.add_child(reset);
        head.add_child(done);
        this.actor.add_child(head);

        this._previewLayout = new Clutter.GridLayout({ column_homogeneous: true, column_spacing: 8, row_spacing: 8 });
        this._preview = new St.Widget({ style_class: 'guava-cc-editor-preview', layout_manager: this._previewLayout, x_expand: true });
        // The preview and the gallery scroll on their own, so the menu stays on screen (a
        // ScrollView child must be scrollable: a BoxLayout)
        const previewBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        previewBox.add_child(this._preview);
        this.actor.add_child(new St.ScrollView({
            style_class: 'guava-cc-editor-preview-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: previewBox,
        }));

        this._search = new St.Entry({
            style_class: 'guava-cc-editor-search',
            hint_text: _('Search Controls'),
            accessible_name: _('Search Controls'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic', icon_size: SMALL_ICON }),
        });
        this._search.clutter_text.connect('text-changed', () => this._fillGallery());
        this.actor.add_child(this._search);

        this._galleryBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'guava-cc-gallery' });
        this._scroll = new St.ScrollView({
            style_class: 'guava-cc-gallery-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._galleryBox,
        });
        this.actor.add_child(this._scroll);
        this.refresh();
    }

    /** The preview tiles of the layout (tests, harness): [{id, actor}] */
    get tiles() {
        return this._preview.get_children().map(actor => ({ id: actor._guavaControl, actor }));
    }

    /** The gallery rows (tests, harness): [{id, actor, added}] */
    get rows() {
        const out = [];
        for (const section of this._galleryBox.get_children()) {
            for (const actor of section.get_children()) {
                if (actor._guavaControl)
                    out.push({ id: actor._guavaControl, actor, added: actor.checked });
            }
        }
        return out;
    }

    get search() {
        return this._search;
    }

    refresh() {
        this._fillPreview();
        this._fillGallery();
    }

    destroy() {
        this.actor.destroy();
    }

    _edit(fn) {
        this._setLayout(fn(this._getLayout()));
        this.refresh();
    }

    _title(id) {
        return this._(control(id)?.title ?? id);
    }

    _icon(id, size = ICON_SIZE) {
        return new St.Icon({
            gicon: guavaGicon(control(id)?.icon ?? 'emblem-system-symbolic', this._ctx.extension?.dir),
            fallback_icon_name: 'emblem-system-symbolic',
            icon_size: size,
        });
    }

    // ---- preview -------------------------------------------------------------------------

    _fillPreview() {
        const _ = this._;
        this._preview.destroy_all_children();
        const layout = this._getLayout();
        const settings = this._ctx.settings;
        const pins = settings.get_strv('menubar-pinned');
        for (const cell of packRows(layout)) {
            const { id } = cell;
            const size = layout.find(e => e.id === id).size;
            const title = this._title(id);
            const tile = new St.BoxLayout({
                style_class: `guava-cc-edit-tile guava-cc-edit-${size}`,
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                reactive: true,
                accessible_name: title,
            });
            tile._guavaControl = id;

            const top = new St.BoxLayout({ x_expand: true });
            top.add_child(iconButton('list-remove-symbolic', _('Remove %s').replace('%s', title),
                () => this._edit(l => removeControl(l, id))));
            top.add_child(new St.Widget({ x_expand: true }));
            const pin = pinOf(id);
            if (pin) {
                const pinned = pinMode(pins, pin) !== 'never';
                top.add_child(iconButton('view-pin-symbolic', _('Show %s in the Menu Bar').replace('%s', title), () => {
                    settings.set_strv('menubar-pinned', setPin(settings.get_strv('menubar-pinned'), pin, pinned ? 'never' : 'always'));
                    this._fillPreview();
                }, { checked: pinned }));
            }
            tile.add_child(top);

            const body = new St.BoxLayout({ style_class: 'guava-cc-edit-body', x_expand: true, x_align: Clutter.ActorAlign.CENTER });
            body.add_child(this._icon(id));
            if (size !== 'small') {
                const label = new St.Label({ text: title, style_class: 'guava-cc-edit-label', y_align: Clutter.ActorAlign.CENTER });
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                body.add_child(label);
            }
            tile.add_child(body);

            const bottom = new St.BoxLayout({ x_expand: true });
            bottom.add_child(iconButton('go-previous-symbolic', _('Move %s Earlier').replace('%s', title),
                () => this._edit(l => moveControl(l, id, -1)), { sensitive: layout[0]?.id !== id }));
            bottom.add_child(new St.Widget({ x_expand: true }));
            const next = nextSize(id, size);
            bottom.add_child(iconButton(size === 'large' ? 'view-restore-symbolic' : 'view-fullscreen-symbolic',
                _('Change the Size of %s').replace('%s', title),
                () => this._edit(l => setSize(l, id, next)), { sensitive: next !== size }));
            bottom.add_child(new St.Widget({ x_expand: true }));
            bottom.add_child(iconButton('go-next-symbolic', _('Move %s Later').replace('%s', title),
                () => this._edit(l => moveControl(l, id, 1)), { sensitive: layout[layout.length - 1]?.id !== id }));
            tile.add_child(bottom);

            this._previewLayout.attach(tile, cell.column, cell.row, cell.span, 1);
        }
        if (!layout.length) {
            this._previewLayout.attach(new St.Label({
                text: _('Add controls from the list below.'), style_class: 'guava-cc-edit-empty',
            }), 0, 0, 4, 1);
        }
    }

    // ---- gallery -------------------------------------------------------------------------

    _fillGallery() {
        const _ = this._;
        this._galleryBox.destroy_all_children();
        const groups = gallery(this._getLayout(), {
            query: this._search.text ?? '',
            titleOf: c => _(c.title),
            available: this._available,
        });
        for (const group of groups) {
            const section = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'guava-cc-gallery-section' });
            section.add_child(new St.Label({ text: _(group.title), style_class: 'guava-cc-gallery-title' }));
            for (const c of group.controls) {
                const row = new St.BoxLayout({ x_expand: true });
                row.add_child(this._icon(c.id));
                const label = new St.Label({ text: c.title, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'guava-cc-gallery-label' });
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                row.add_child(label);
                row.add_child(new St.Icon({
                    icon_name: c.added ? 'object-select-symbolic' : 'list-add-symbolic',
                    icon_size: SMALL_ICON,
                    style_class: c.added ? 'guava-cc-gallery-added' : 'guava-cc-gallery-add',
                }));
                const button = new St.Button({
                    style_class: 'guava-cc-gallery-item',
                    accessible_name: (c.added ? _('Remove %s') : _('Add %s')).replace('%s', c.title),
                    can_focus: true,
                    track_hover: true,
                    toggle_mode: false,
                    x_expand: true,
                    child: row,
                });
                button.checked = c.added;
                button._guavaControl = c.id;
                button.connect('clicked', () => this._edit(l => (c.added ? removeControl(l, c.id) : addControl(l, c.id))));
                section.add_child(button);
            }
            this._galleryBox.add_child(section);
        }
        if (!groups.length)
            this._galleryBox.add_child(new St.Label({ text: _('No controls match.'), style_class: 'guava-cc-edit-empty' }));
    }
}
