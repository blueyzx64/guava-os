// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets shared by the panel popover and Quick Paste: type tile, row, metadata text.
// `ctl` is the controller from index.js; `_` is the extension's gettext.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { ageOf, tileIconProps } from './model.js';

const PREVIEW_CHARS = 2000;

/** '<Super><Shift>v' -> 'Super+Shift+V' for hints. */
export function accelLabel(accel) {
    if (!accel)
        return '';
    const mods = [...accel.matchAll(/<([A-Za-z0-9_]+)>/g)].map(m => {
        const k = m[1].toLowerCase();
        return k === 'primary' || k === 'control' ? 'Ctrl' : k[0].toUpperCase() + k.slice(1);
    });
    const key = accel.replace(/<[^>]*>/g, '');
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

export function ageText(entry, now, _) {
    const [unit, n] = ageOf(entry.time, now);
    switch (unit) {
    case 'now': return _('Just now');
    case 'minutes': return _('%d min ago').replace('%d', n);
    case 'hours': return _('%d h ago').replace('%d', n);
    default: return _('%d d ago').replace('%d', n);
    }
}

export function sizeText(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

/** "Firefox · 2 min ago" */
export function subtitleOf(entry, now, _) {
    const age = ageText(entry, now, _);
    return entry.app ? `${entry.app} · ${age}` : age;
}

export function titleOf(entry, _) {
    return entry.kind === 'image' ? _('Image') : entry.preview;
}

/** Type tile: image thumbnail (made lazily when the tile is built), colour swatch or glyph. */
export function buildTile(entry, ctl, size) {
    const tile = new St.Bin({
        style_class: `guava-clip-tile guava-clip-tile-${entry.type}`,
        width: size, height: size,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    if (entry.type === 'color') {
        tile.set_style(`background-color: ${entry.text.trim()};`);
        return tile;
    }
    const gicon = entry.kind === 'image' ? ctl.iconFor(entry) : null;
    tile.set_child(new St.Icon(tileIconProps(entry.type, size, gicon)));
    return tile;
}

function iconButton(iconName, label, onClick) {
    const b = new St.Button({
        style_class: 'guava-clip-action', can_focus: true, reactive: true,
        accessible_name: label,
        child: new St.Icon({ icon_name: iconName, icon_size: 14 }),
    });
    b.connect('clicked', () => {
        onClick();
        return Clutter.EVENT_STOP;
    });
    return b;
}

/**
 * One list row.
 *
 * @param {object} entry
 * @param {object} ctl controller
 * @param {Function} _ gettext
 * @param {{onActivate: Function, tile?: number, now?: number, compact?: boolean}} o
 *   compact: one line (type icon, preview, time on the right), for the panel popover
 * @returns {St.Button} with `.entryId`; add pseudo class 'selected' to mark it
 */
export function buildRow(entry, ctl, _, { onActivate, tile = 34, now = Date.now(), compact = false }) {
    if (compact)
        return buildCompactRow(entry, ctl, _, { onActivate, tile, now });
    const row = new St.Button({
        style_class: 'guava-clip-row', can_focus: true, reactive: true, track_hover: true,
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
    });
    row.entryId = entry.id;
    row.accessible_name = titleOf(entry, _);
    const box = new St.BoxLayout({ style_class: 'guava-clip-row-box', x_expand: true });
    row.set_child(box);
    box.add_child(buildTile(entry, ctl, tile));

    const text = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        y_align: Clutter.ActorAlign.CENTER, style_class: 'guava-clip-text',
    });
    const title = new St.Label({ text: titleOf(entry, _), style_class: 'guava-clip-title' });
    title.clutter_text.set_ellipsize(3);          // Pango.EllipsizeMode.END
    text.add_child(title);
    text.add_child(new St.Label({ text: subtitleOf(entry, now, _), style_class: 'guava-clip-sub' }));
    box.add_child(text);

    const actions = new St.BoxLayout({ style_class: 'guava-clip-actions', y_align: Clutter.ActorAlign.CENTER });
    actions.add_child(iconButton(
        'view-pin-symbolic', entry.pinned ? _('Unpin') : _('Pin'), () => ctl.togglePin(entry.id)));
    actions.add_child(iconButton('edit-delete-symbolic', _('Remove'), () => ctl.remove(entry.id)));
    actions.opacity = 0;
    box.add_child(actions);
    if (entry.pinned) {
        row.add_style_pseudo_class('pinned');
        actions.opacity = 255;
    }
    // Pin and Remove show on hover or while the row holds the keyboard selection
    const sync = () => {
        actions.opacity = row.hover || entry.pinned || row.has_style_pseudo_class('selected') ? 255 : 0;
    };
    row.connect('notify::hover', sync);
    row.connect('style-changed', sync);
    row.connect('clicked', () => onActivate(entry));
    return row;
}

/** One-line preview: line breaks and runs of blanks read as a single space. */
export function oneLine(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The one-line row of the panel popover: type icon, preview, and a quiet time on the
 * right. Pin and Remove take the time's place on hover.
 */
function buildCompactRow(entry, ctl, _, { onActivate, tile, now }) {
    const row = new St.Button({
        style_class: 'guava-clip-row guava-clip-row-compact', can_focus: true, reactive: true,
        track_hover: true, x_expand: true, x_align: Clutter.ActorAlign.FILL,
    });
    row.entryId = entry.id;
    row.accessible_name = titleOf(entry, _);
    const box = new St.BoxLayout({ style_class: 'guava-clip-row-box', x_expand: true });
    row.set_child(box);
    box.add_child(buildTile(entry, ctl, tile));

    const title = new St.Label({
        text: oneLine(titleOf(entry, _)), style_class: 'guava-clip-title',
        x_expand: true, y_align: Clutter.ActorAlign.CENTER,
    });
    title.clutter_text.set_ellipsize(3);          // Pango.EllipsizeMode.END
    box.add_child(title);

    const time = new St.Label({
        text: ageText(entry, now, _), style_class: 'guava-clip-time', y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(time);

    const actions = new St.BoxLayout({ style_class: 'guava-clip-actions', y_align: Clutter.ActorAlign.CENTER });
    actions.add_child(iconButton(
        'view-pin-symbolic', entry.pinned ? _('Unpin') : _('Pin'), () => ctl.togglePin(entry.id)));
    actions.add_child(iconButton('edit-delete-symbolic', _('Remove'), () => ctl.remove(entry.id)));
    box.add_child(actions);
    if (entry.pinned)
        row.add_style_pseudo_class('pinned');
    const sync = () => {
        // Hover only: the keyboard selection keeps its time, so the list stays calm
        const active = row.hover;
        actions.visible = active;
        time.visible = !active;
    };
    sync();
    row.connect('notify::hover', sync);
    row.connect('style-changed', sync);
    row.connect('clicked', () => onActivate(entry));
    return row;
}

/**
 * Add a row for `entry` to `list`. A row that fails to build is logged and skipped, so one
 * bad entry never blanks the rest of the list (or leaves the count stale).
 */
export function addRow(list, entry, ctl, _, opts) {
    try {
        list.add_child(buildRow(entry, ctl, _, opts));
    } catch (e) {
        console.warn(`[Guava] clipboard row failed: ${e.message}`);
    }
}

/** "Pinned" / "Recent" caption. */
export function sectionLabel(text) {
    return new St.Label({ text, style_class: 'guava-clip-section' });
}

/** Cap the characters a preview pane has to lay out. */
export function longPreview(entry) {
    return entry.text.length > PREVIEW_CHARS ? `${entry.text.slice(0, PREVIEW_CHARS)}…` : entry.text;
}
