// SPDX-License-Identifier: GPL-3.0-or-later
// The floating thumbnail (macOS Mojave): after a capture a small preview slides in at the
// bottom-right corner. Ignored, it saves after model.THUMBNAIL_MS (hovering pauses the clock);
// swiped right it saves at once; clicked it opens in the image viewer; right-clicked it offers
// Save to, Show in Files, Delete and Close.
//
// Dragging the thumbnail into an app, as on macOS, cannot be done: the Shell cannot start a
// drag-and-drop from one of its own actors into a Wayland client.
//
// This file is only the view: index.js decides what each gesture does to the file.
// Shell API: Main.layoutManager.addTopChrome, ui/popupMenu.js; checked on GNOME 50.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { Glass } from '../../lib/glass.js';
import {
    THUMBNAIL_BOX, ThumbnailLife, swipeOffset, swipeOutcome, thumbnailEntryOffset, thumbnailRest,
    thumbnailSize,
} from './model.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

const DRAG_SLOP = 6;
const now = () => GLib.get_monotonic_time() / 1000;

/** Decode the picture at twice the thumbnail size (sharp on HiDPI), off the main thread. */
async function loadContent(file, cancellable) {
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream, THUMBNAIL_BOX.width * 2, THUMBNAIL_BOX.height * 2, true, cancellable);
        const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
        const coglContext = global.stage.context.get_backend().get_cogl_context();
        content.set_bytes(coglContext, pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width, pixbuf.height, pixbuf.rowstride);
        return { content, width: pixbuf.width, height: pixbuf.height };
    } finally {
        stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }
}

class ThumbnailMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, St.Side.BOTTOM);
        this.actor.add_style_class_name('guava-screenshot-menu');
        Main.uiGroup.add_child(this.actor);
        this.actor.hide();
        this._glass = Glass.attachMenu(this);
    }

    destroy() {
        this._glass?.destroy();
        this._glass = null;
        super.destroy();
    }
}

export class FloatingThumbnail {
    /**
     * @param {object} p
     * @param {Gio.File} p.file
     * @param {object} p.area work area of the primary monitor
     * @param {object} p.motion ctx.motion
     * @param {(s: string) => string} p._
     * @param {Array<[string, string]>} p.destinations [value, label] for the Save to submenu
     * @param {{expire, swipe, open, saveTo, showInFiles, remove, close}} p.on
     */
    constructor({ file, area, motion, _, destinations, on }) {
        this._motion = motion;
        this._on = on;
        this._area = area;
        this._cleanup = new CleanupRegistry();
        this._cancellable = new Gio.Cancellable();
        this._cleanup.add(() => this._cancellable.cancel());
        this._life = new ThumbnailLife(now());
        this._timer = 0;
        this._drag = null;
        this._gone = false;

        this.actor = new St.Widget({
            name: 'guava-screenshot-thumbnail', style_class: 'guava-screenshot-thumbnail',
            reactive: true, track_hover: true, opacity: 0, accessible_name: _('Screenshot'),
            layout_manager: new Clutter.BinLayout(),
        });
        this._picture = new St.Widget({ style_class: 'guava-screenshot-thumbnail-picture', x_expand: true, y_expand: true });
        this.actor.add_child(this._picture);
        Main.layoutManager.addTopChrome(this.actor);
        this._cleanup.add(() => this.actor.destroy());

        this._menu = new ThumbnailMenu(this.actor);
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._menuManager.addMenu(this._menu);
        this._cleanup.add(() => this._menu.destroy());
        this._buildMenu(_, destinations);
        this._cleanup.connect(this._menu, 'open-state-changed', (_m, open) => this._hold(open || this.actor.hover));

        this._cleanup.connect(this.actor, 'notify::hover', () => this._hold(this.actor.hover || this._menu.isOpen));
        this._cleanup.connect(this.actor, 'button-press-event', (_a, ev) => this._press(ev));

        this._place(thumbnailSize(0, 0));
        loadContent(file, this._cancellable).then(({ content, width, height }) => {
            if (this._gone)
                return;
            this._picture.set_content(content);
            this._place(thumbnailSize(width, height));
            this._enter();
        }).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.warn(`[Guava] screenshot thumbnail: ${e.message}`);
                this._on.expire();
            }
        });
    }

    get shown() {
        return !this._gone;
    }

    /** Slide out to the right (saved) or fade (deleted), then go. */
    dismiss(how = 'slide') {
        if (this._gone)
            return;
        this._gone = true;
        this._stopTimer();
        this._menu.close(BoxPointer.PopupAnimation.NONE);
        this.actor.reactive = false;
        const props = how === 'slide'
            ? { translation_x: thumbnailEntryOffset(this._area, { x: this.actor.x }), opacity: 0 }
            : { opacity: 0, scale_x: 0.9, scale_y: 0.9 };
        this._motion.ease(this.actor, props, {
            duration: 'short', curve: 'exit',
            onDone: () => this.destroy(),
        }, this._cleanup);
    }

    destroy() {
        this._gone = true;
        this._stopTimer();
        this._endDrag();
        this._cleanup.dispose();
    }

    // ---- placement and the clock ----------------------------------------------------

    _place(size) {
        const rest = thumbnailRest(this._area, size);
        this.actor.set_position(rest.x, rest.y);
        this.actor.set_size(size.width, size.height);
        this.actor.set_pivot_point(0.5, 0.5);
    }

    _enter() {
        this.actor.translation_x = thumbnailEntryOffset(this._area, { x: this.actor.x });
        this.actor.opacity = 255;
        this._motion.spring(this.actor, 'translation_x', 0, { spring: 'snappy' }, this._cleanup);
        this._life = new ThumbnailLife(now());
        this._arm();
    }

    _arm() {
        this._stopTimer();
        this._timer = this._cleanup.timeout(Math.max(1, this._life.remaining(now())), () => {
            this._timer = 0;
            this._on.expire();
        }, { name: 'guava-screenshot-thumbnail' });
    }

    _stopTimer() {
        if (this._timer)
            this._cleanup.release(this._timer);
        this._timer = 0;
    }

    _hold(held) {
        if (this._gone)
            return;
        if (held) {
            this._life.pause(now());
            this._stopTimer();
        } else if (this._life.paused) {
            this._life.resume(now());
            this._arm();
        }
    }

    // ---- gestures --------------------------------------------------------------------

    _press(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY || this._gone)
            return Clutter.EVENT_PROPAGATE;
        const [x] = event.get_coords();
        this._drag = { x, moved: false, id: 0 };
        this._drag.id = global.stage.connect('captured-event', (_s, ev) => this._dragEvent(ev));
        return Clutter.EVENT_STOP;
    }

    _dragEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            const dx = event.get_coords()[0] - this._drag.x;
            if (Math.abs(dx) > DRAG_SLOP)
                this._drag.moved = true;
            if (this._drag.moved)
                this.actor.translation_x = swipeOffset(dx);
            return Clutter.EVENT_STOP;
        }
        if (type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const { moved, x } = this._drag;
        this._endDrag();
        if (!moved) {
            this._on.open();
        } else if (swipeOutcome(event.get_coords()[0] - x, this.actor.width) === 'dismiss') {
            this._on.swipe();
        } else {
            this._motion.spring(this.actor, 'translation_x', 0, { spring: 'snappy' }, this._cleanup);
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        if (this._drag?.id)
            global.stage.disconnect(this._drag.id);
        this._drag = null;
    }

    _buildMenu(_, destinations) {
        const sub = new PopupMenu.PopupSubMenuMenuItem(_('Save to'));
        for (const [value, label] of destinations)
            sub.menu.addAction(label, () => this._on.saveTo(value));
        this._menu.addMenuItem(sub);
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('Show in Files'), () => this._on.showInFiles());
        this._menu.addAction(_('Delete'), () => this._on.remove());
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('Close'), () => this._on.close());
    }
}
