// SPDX-License-Identifier: GPL-3.0-or-later
// One desktop icon: the picture (a preview for images and documents when GNOME has one, else
// the type's icon) with its name under it, wrapped to two lines. Selected, it gets the soft
// square behind the picture and the rounded highlight behind the name, as in Finder; the
// highlight is grey while a window has the focus and the accent colour while the desktop does.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { LABEL_LINES } from './model.js';

export class IconTile {
    /**
     * @param {object} entry model entry plus gicon / thumbnail (source.js)
     * @param {ReturnType<import('./model.js').metricsFor>} metrics sizes in stage px
     */
    constructor(entry, metrics) {
        this.key = entry.key;
        this._m = metrics;
        this.entry = entry;
        this.selected = false;
        this.active = false;
        this.focused = false;

        this.actor = new St.BoxLayout({
            style_class: 'guava-di-tile',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            width: metrics.cellW,
            height: metrics.cellH,
            accessible_role: Atk.Role.ICON,
        });
        const pad = Math.round(metrics.icon * 0.0625);
        this._picture = new St.Bin({
            style_class: 'guava-di-picture',
            x_align: Clutter.ActorAlign.CENTER,
            width: metrics.icon + 2 * pad,
            height: metrics.icon + 2 * pad,
        });
        this._icon = new St.Icon({ icon_size: metrics.icon, style_class: 'guava-di-icon' });
        this._picture.set_child(this._icon);
        this._label = new St.Label({ style_class: 'guava-di-label' });
        const text = this._label.clutter_text;
        text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            line_alignment: Pango.Alignment.CENTER,
        });
        this._labelBox = new St.Bin({
            style_class: 'guava-di-label-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            y_expand: true,
            child: this._label,
        });
        this._label.set_style(`max-width: ${metrics.labelWidth}px; max-height: ${LABEL_LINES * metrics.lineHeight}px;`);
        this.actor.add_child(this._picture);
        this.actor.add_child(this._labelBox);
        this.update(entry);
    }

    /** The label, for the rename editor to cover. */
    get label() {
        return this._label;
    }

    update(entry) {
        this.entry = entry;
        this._label.text = entry.name;
        this.actor.accessible_name = entry.name;
        this.actor.accessible_description = entry.kindLabel ?? '';
        // A preview keeps the picture's proportions (background-size: contain); other files show
        // the icon of their type
        const preview = entry.thumbnail && !/["\\]/.test(entry.thumbnail);
        this._picture.set_child(preview ? null : this._icon);
        this._picture.set_style(`border-radius: ${Math.round(this._m.icon * 0.2)}px;` + (preview
            ? ` background-image: url("file://${entry.thumbnail}"); background-size: contain; background-position: 50% 50%;` : ''));
        if (!preview)
            this._icon.gicon = entry.gicon;
        if (preview)
            this._picture.add_style_class_name('guava-di-preview');
        else
            this._picture.remove_style_class_name('guava-di-preview');
    }

    /** Selected, whether the desktop is in front (accent) or a window is (grey), and keyboard focus. */
    setState({ selected, active, focused }) {
        const toggle = (on, cls) => {
            if (on)
                this.actor.add_style_class_name(cls);
            else
                this.actor.remove_style_class_name(cls);
        };
        if (selected !== this.selected)
            toggle(selected, 'guava-di-selected');
        if (active !== this.active)
            toggle(active, 'guava-di-active');
        if (focused !== this.focused)
            toggle(focused, 'guava-di-focused');
        this.selected = selected;
        this.active = active;
        this.focused = focused;
    }

    /** Hide the name while the rename editor shows over it. */
    setEditing(on) {
        this._label.opacity = on ? 0 : 255;
    }

    destroy() {
        this.actor.destroy();
    }
}
