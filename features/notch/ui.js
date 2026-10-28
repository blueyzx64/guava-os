// SPDX-License-Identifier: GPL-3.0-or-later
// Small actor builders shared by the notch's pages (view.js, pills.js, tabs.js). No state.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { Role } from '../../lib/a11y.js';

export const label = (text, styleClass, opts = {}) => {
    const l = new St.Label({
        text: text ?? '',
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        ...opts,
    });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
};

export const themed = name => new Gio.ThemedIcon({ name });

export const icon = (gicon, size, styleClass = 'guava-notch-icon', fallback = null) =>
    new St.Icon({
        gicon, icon_size: size, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER,
        // Shown if gicon cannot load (a remote cover art URL without GVfs, a missing file)
        fallback_gicon: fallback,
    });

/** A round or pill button with an icon and/or a label. */
export function button({ styleClass, iconName = null, text = null, accessibleName, size = 16, onClick, toggle = null }) {
    const opts = {
        style_class: styleClass,
        can_focus: true,
        accessible_name: accessibleName ?? text ?? '',
        y_align: Clutter.ActorAlign.CENTER,
    };
    if (toggle !== null) {
        opts.toggle_mode = true;
        opts.checked = !!toggle;
        opts.accessible_role = Role.TOGGLE_BUTTON;
    }
    const b = new St.Button(opts);
    if (iconName && text) {
        const box = new St.BoxLayout({ style_class: 'guava-notch-button-box' });
        box.add_child(new St.Icon({ icon_name: iconName, icon_size: size }));
        box.add_child(new St.Label({ text, y_align: Clutter.ActorAlign.CENTER }));
        b.set_child(box);
    } else if (iconName) {
        b.set_child(new St.Icon({ icon_name: iconName, icon_size: size }));
    } else {
        b.label = text ?? '';
    }
    b.connect('clicked', () => onClick?.());
    return b;
}

// Cover art: local files and http(s) URLs. St loads a FileIcon asynchronously through GIO
// (GVfs handles http/https), so nothing is downloaded on the main loop here.
export function artIcon(url) {
    if (typeof url === 'string' && /^(file|https?):\/\//.test(url))
        return new Gio.FileIcon({ file: Gio.File.new_for_uri(url) });
    return null;
}

/**
 * Cover art with rounded corners. A local file is drawn as the background of a rounded box (St
 * clips a background image to its border radius); a remote URL loads through GIO as an icon;
 * without art the app icon sits on a soft tile.
 */
export function artwork(media, size, styleClass) {
    const url = media?.art;
    const bin = new St.Bin({
        style_class: `guava-notch-artwork ${styleClass}`,
        width: size, height: size,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (typeof url === 'string' && url.startsWith('file://') && !/["\\]/.test(url)) {
        bin.style = `background-image: url("${url}"); background-size: cover;`;
        return bin;
    }
    const plain = media?.appIcon ?? themed('audio-x-generic-symbolic');
    const remote = artIcon(url);
    if (remote) {
        bin.add_style_class_name('guava-notch-artwork-remote');
        bin.set_child(icon(remote, size, 'guava-notch-art', plain));
    } else {
        bin.add_style_class_name('guava-notch-artwork-empty');
        bin.set_child(icon(plain, Math.round(size * 0.5), 'guava-notch-icon'));
    }
    return bin;
}

// Lays its one child out from the left edge at `fraction` of the width. Sizing the fill here,
// inside the allocation, avoids a relayout queued from an allocation handler.
export const FractionLayout = GObject.registerClass(
class GuavaNotchFractionLayout extends Clutter.LayoutManager {
    constructor() {
        super();
        this.fraction = 0;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const f = Math.max(0, Math.min(1, this.fraction));
        const child = new Clutter.ActorBox();
        child.set_origin(box.x1, box.y1);
        child.set_size(Math.round(box.get_width() * f), box.get_height());
        for (const actor of container.get_children())
            actor.allocate(child);
    }
});

// Centres each child horizontally from its own size and puts it at the top. Done in the
// allocation, so a size change of the container needs no handler that moves children (a
// handler on notify::width runs inside the allocation pass and queued a relayout from there).
export const CenterLayout = GObject.registerClass(
class GuavaNotchCenterLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        for (const actor of container.get_children()) {
            const [, width] = actor.get_preferred_width(-1);
            const [, height] = actor.get_preferred_height(width);
            const child = new Clutter.ActorBox();
            child.set_origin(box.x1 + Math.round((box.get_width() - width) / 2), box.y1);
            child.set_size(width, height);
            actor.allocate(child);
        }
    }
});

/** Set a label's text only when it differs: the same text would still queue a relayout. */
export function setText(actor, text) {
    if (actor.text !== text)
        actor.text = text;
}

/** A bar with a fill. Returns the track; `track.guavaSetFraction(f)` moves the fill. */
export function track(trackClass, fillClass, height, fraction, opts = {}) {
    const layout = new FractionLayout();
    layout.fraction = fraction;
    const t = new St.Widget({
        style_class: trackClass, x_expand: true, y_align: Clutter.ActorAlign.CENTER, height,
        layout_manager: layout, ...opts,
    });
    t.add_child(new St.Widget({ style_class: fillClass }));
    t.guavaSetFraction = f => {
        if (layout.fraction === f)
            return;
        layout.fraction = f;
        layout.layout_changed();
    };
    return t;
}

export function column(styleClass, width) {
    return new St.BoxLayout({
        style_class: `guava-notch-col ${styleClass}`,
        orientation: Clutter.Orientation.VERTICAL,
        width,
    });
}
