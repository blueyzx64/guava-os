// SPDX-License-Identifier: GPL-3.0-or-later
// The tiles of the dock: app icons, minimized-window tiles and separators. The Downloads stack
// (stack.js) and the Trash (trash.js) build on DockItem too.
//
// Every item talks to its `host` (the Dock in index.js) instead of the Shell for anything that
// is not its own actor: clicks, menus, hover labels and drops are decisions the dock makes.
//
// Shell API: St.Button, ui/dnd.js makeDraggable (the delegate's getDragActor and
// getDragActorSource, handleDragOver and acceptDrop on targets), Shell.App icons.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { IconStyle } from '../../lib/iconStyle.js';
import { badgeProgress, badgeText } from './model.js';

/** Base of every clickable dock tile: a square St.Button with a centred content box. */
export class DockItem {
    /**
     * @param {object} host the Dock (index.js)
     * @param {object} spec the item from model.dockItems()
     * @param {string} name accessible name, also the hover label
     */
    constructor(host, spec, name) {
        this._host = host;
        this.id = spec.id;
        this.spec = spec;
        this.cleanup = new CleanupRegistry();
        const m = host.metrics;
        // Registered first, so destroyed last; a registry skips an actor already destroyed
        this.actor = this.cleanup.actor(new St.Button({
            style_class: 'guava-dock-item',
            accessible_name: name,
            reactive: true, can_focus: true, track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            width: m.tile, height: m.tile,
        }));
        this.actor.set_style(`border-radius: ${m.tileRadius}px;`);
        this.content = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });
        this.actor.set_child(this.content);
        this.actor._delegate = this;
        this.name = name;

        this.cleanup.connect(this.actor, 'notify::hover', () => host.itemHovered(this, this.actor.hover));
        this.cleanup.connect(this.actor, 'clicked', (_b, button) => this.activate(button));
        this.cleanup.connect(this.actor, 'button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.openMenu();
            return Clutter.EVENT_STOP;
        });
        this.cleanup.connect(this.actor, 'popup-menu', () => this.openMenu());
        // macOS darkens an icon while it is pressed
        this.cleanup.connect(this.actor, 'notify::pressed', () =>
            host.motion.ease(this.content, { opacity: this.actor.pressed ? 160 : 255 },
                { duration: 'micro', curve: 'standard' }, this.cleanup));
    }

    /** Rename (accessible name and hover label). */
    setName(name) {
        if (name === this.name)
            return;
        this.name = name;
        this.actor.accessible_name = name;
        this._host.itemRenamed(this);
    }

    /** The St.Icon or texture whose rect the dock reports (iconRect, minimize target). */
    get iconActor() {
        return this.content;
    }

    /** Grows under the pointer (magnification). */
    get magnifies() {
        return true;
    }

    /** @param {number} _button 1 primary, 2 middle */
    activate(_button) {}

    openMenu() {}

    /** A new spec for the same id (running state, ...). */
    update(spec) {
        this.spec = spec;
    }

    destroy() {
        this.cleanup.dispose();
    }
}

/** A thin line between the dock's sections. */
export class SeparatorItem {
    constructor(host, spec) {
        this.id = spec.id;
        this.spec = spec;
        const m = host.metrics;
        const horizontal = host.horizontal;
        const length = Math.round(m.tile * 0.62);
        this._cleanup = new CleanupRegistry();
        this.actor = this._cleanup.actor(new St.Widget({
            style_class: 'guava-dock-separator',
            width: horizontal ? 1 : length,
            height: horizontal ? length : 1,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const margin = Math.max(3, Math.round(m.padding * 0.75));
        this.actor.set_style(horizontal ? `margin: 0 ${margin}px;` : `margin: ${margin}px 0;`);
    }

    get iconActor() {
        return this.actor;
    }

    get magnifies() {
        return false;
    }

    update(spec) {
        this.spec = spec;
    }

    destroy() {
        this._cleanup.dispose();
    }
}

/** An app: icon, running dot, click, menu, drag to reorder or remove, file drops. */
export class AppItem extends DockItem {
    /**
     * @param {object} host
     * @param {object} spec {kind: 'app', id, section, running}
     * @param {Shell.App} app
     */
    constructor(host, spec, app) {
        super(host, spec, app.get_name() ?? spec.id);
        this.app = app;
        const m = host.metrics;
        this._icon = app.create_icon_texture(m.icon);
        this._icon.x_align = Clutter.ActorAlign.CENTER;
        this._icon.y_align = Clutter.ActorAlign.CENTER;
        this.content.add_child(this._icon);
        // Default, Dark, Clear or Tinted (Appearance); the handle goes with the tile
        const style = IconStyle.apply(this._icon);
        this.cleanup.add(() => style.destroy());

        const side = host.position;
        this._dot = new St.Widget({
            style_class: 'guava-dock-dot',
            width: m.dot, height: m.dot,
            // BinLayout aligns a child within the tile only when it expands
            x_expand: true, y_expand: true,
            x_align: side === 'left' ? Clutter.ActorAlign.START : side === 'right' ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER,
            y_align: side === 'bottom' ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER,
        });
        this._dot.set_style(`border-radius: ${Math.ceil(m.dot / 2)}px;`);
        this.content.add_child(this._dot);

        // Window-backed apps (no .desktop file) cannot be pinned, so they do not drag
        if (host.canPin(app)) {
            this._draggable = DND.makeDraggable(this.actor);
            this.cleanup.connect(this._draggable, 'drag-begin', () => host.dragBegin(this));
            this.cleanup.connect(this._draggable, 'drag-end', () => host.dragEnd(this));
        }
        this.update(spec);
    }

    get iconActor() {
        return this._icon;
    }

    /** The running dot (magnification keeps it at its size). */
    get indicator() {
        return this._dot;
    }

    update(spec) {
        super.update(spec);
        this._dot.visible = spec.running && this._host.config.runningDots;
        // macOS 27: an app that only runs in the background gets a grey indicator
        if (spec.background)
            this._dot.add_style_class_name('guava-dock-dot-background');
        else
            this._dot.remove_style_class_name('guava-dock-dot-background');
    }

    /**
     * The red count and the progress bar an app publishes (LauncherEntry), or none.
     *
     * @param {?object} entry lib/launcherEntryModel.js entry
     */
    setBadge(entry) {
        const text = badgeText(entry);
        if (text && !this._badge) {
            this._badge = new St.Label({
                style_class: 'guava-dock-badge',
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
            });
            this.content.add_child(this._badge);
        }
        if (this._badge) {
            this._badge.visible = !!text;
            if (text)
                this._badge.text = text;
        }
        const progress = badgeProgress(entry);
        const m = this._host.metrics;
        const length = Math.round(m.icon * 0.78);
        if (progress !== null && !this._progress) {
            this._progress = new St.Widget({
                style_class: 'guava-dock-progress',
                layout_manager: new Clutter.BinLayout(),
                width: length,
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END,
            });
            this._progressFill = new St.Widget({
                style_class: 'guava-dock-progress-fill',
                x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL,
            });
            this._progress.add_child(this._progressFill);
            this._progress.set_style(`margin-bottom: ${Math.round(m.icon * 0.14)}px;`);
            this.content.add_child(this._progress);
        }
        if (this._progress) {
            this._progress.visible = progress !== null;
            if (progress !== null)
                this._progressFill.width = Math.round((length - 2) * progress);
        }
        this.badgeEntry = entry;
    }

    /**
     * "Minimize windows into application icon": a small live thumbnail of the newest
     * minimized window on the icon, or none.
     *
     * @param {?Meta.Window} metaWindow
     */
    setMinimizedThumb(metaWindow) {
        if (metaWindow === (this._thumbWindow ?? null))
            return;
        this._thumbWindow = metaWindow;
        this._thumb?.destroy();
        this._thumb = null;
        const source = metaWindow?.get_compositor_private();
        if (!source)
            return;
        const m = this._host.metrics;
        const frame = metaWindow.get_frame_rect();
        const scale = (m.icon * 0.5) / Math.max(1, frame.width, frame.height);
        this._thumb = new Clutter.Clone({
            source,
            width: Math.round(source.width * scale),
            height: Math.round(source.height * scale),
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END,
        });
        this.content.add_child(this._thumb);
    }

    activate(button) {
        this._host.clickApp(this, button);
    }

    openMenu() {
        this._host.openAppMenu(this);
    }

    // ---- drag and drop (ui/dnd.js delegate) ----

    getDragActor() {
        return this.app.create_icon_texture(this._host.metrics.icon);
    }

    getDragActorSource() {
        return this._icon;
    }

    handleDragOver(source) {
        return source?.guavaFile && this._host.opensFiles(this.app)
            ? DND.DragMotionResult.COPY_DROP : DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source) {
        if (!source?.guavaFile || !this._host.opensFiles(this.app))
            return false;
        this._host.openFileWith(this.app, source.guavaFile);
        return true;
    }
}

/** A minimized window ("Minimize windows into application icon" off): its live thumbnail. */
export class WindowItem extends DockItem {
    /**
     * @param {object} host
     * @param {object} spec {kind: 'window', id, windowId}
     * @param {Meta.Window} metaWindow
     * @param {?Shell.App} app for the badge
     */
    constructor(host, spec, metaWindow, app) {
        super(host, spec, metaWindow.get_title() || app?.get_name() || '');
        this.metaWindow = metaWindow;
        const m = host.metrics;
        const source = metaWindow.get_compositor_private();
        if (source) {
            const frame = metaWindow.get_frame_rect();
            const scale = m.icon / Math.max(1, frame.width, frame.height);
            this._clone = new Clutter.Clone({
                source,
                width: Math.round(source.width * scale),
                height: Math.round(source.height * scale),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.content.add_child(this._clone);
        }
        if (app) {
            const badge = app.create_icon_texture(Math.round(m.icon * 0.42));
            badge.x_expand = badge.y_expand = true;
            badge.x_align = Clutter.ActorAlign.END;
            badge.y_align = Clutter.ActorAlign.END;
            this.content.add_child(badge);
        }
        this.cleanup.connect(metaWindow, 'notify::title', () => this.setName(metaWindow.get_title() || ''));
    }

    activate() {
        this._host.activateWindow(this.metaWindow);
    }
}
