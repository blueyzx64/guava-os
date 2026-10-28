// SPDX-License-Identifier: GPL-3.0-or-later
// The Spaces bar: GNOME's own workspace thumbnails (ThumbnailsBox) along the top of the
// overview, dressed as macOS Mission Control's bar. Guava adds, as children of the thumbnails (so
// they stack, slide and fade with them, under the windows the overview animates):
//   - a label under each Space ("Desktop 1", or the app of a full-screen Space);
//   - a × on the hovered Space that removes it (its windows go to the neighbour, Mutter's rule);
//   - a + after the last Space that adds one;
//   - dragging a label along the bar reorders the Spaces.
// The thumbnails themselves (live windows, dropping a window on a Space, the active frame)
// stay the stock ones. The bar always shows, also with one Space (macOS), and hides in App
// Exposé.
//
// Shell API (GNOME 50, js/ui/workspaceThumbnail.js): ThumbnailsBox._thumbnails, ._shouldShow,
// ._updateShouldShow(), addThumbnails/removeThumbnails, ._maxThumbnailScale, ThumbnailState;
// ThumbnailsBox.handleDragOver/acceptDrop, WorkspaceThumbnail.metaWorkspace, .state, ._viewport,
// .collapseFraction; js/ui/dnd.js makeDraggable;
// Meta.WorkspaceManager append_new_workspace / remove_workspace / reorder_workspace.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { ThumbnailsBox, ThumbnailState } from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { canRemoveSpace, centringShift, reorderIndex, spaceLabels } from './model.js';

// macOS's bar is about twice GNOME's 5 % thumbnails
const THUMBNAIL_SCALE = 0.15;
const LABEL_GAP = 6;
const LABEL_SPILL = 18;
const CLOSE_INSET = 8;
const PLUS_GAP = 16;

export class SpacesBar {
    /**
     * @param {object} host the MissionControl adapter: spacesBarWanted(), spaces(), _
     * @param {ThumbnailsBox} box the overview's thumbnails box
     * @param {CleanupRegistry} cleanup
     */
    constructor(host, box, cleanup) {
        this._host = host;
        this._box = box;
        this._cleanup = cleanup;
        this._decor = new Map(); // WorkspaceThumbnail -> {label, close, cleanup}
        this._plus = null;
        this._plusWanted = false;
        this._hovered = null;
        this._dragging = false;
    }

    enable() {
        const c = this._cleanup;
        const box = this._box;
        const self = this;

        // Bigger thumbnails (an own property over the stock constant)
        const hadScale = Object.prototype.hasOwnProperty.call(box, '_maxThumbnailScale');
        const oldScale = box._maxThumbnailScale;
        c.add(() => {
            if (hadScale)
                box._maxThumbnailScale = oldScale;
            else
                delete box._maxThumbnailScale;
            box.queue_relayout();
        });
        box._maxThumbnailScale = THUMBNAIL_SCALE;
        box.add_style_class_name('guava-mc-spaces-box');
        c.add(() => box.remove_style_class_name('guava-mc-spaces-box'));
        c.add(() => {
            box.translation_x = 0;
        });

        // Always shown in Mission Control, hidden in App Exposé. Registered before the
        // injection so the stock rule runs again after it is gone.
        c.add(() => box._updateShouldShow?.());
        c.inject(ThumbnailsBox.prototype, '_updateShouldShow', function (orig, ...args) {
            if (this !== box)
                return orig.apply(this, args);
            const want = self._host.spacesBarWanted();
            if (this._shouldShow === want)
                return undefined;
            this._shouldShow = want;
            this.notify('should-show');
            return undefined;
        });
        for (const name of ['addThumbnails', 'removeThumbnails']) {
            c.inject(ThumbnailsBox.prototype, name, function (orig, ...args) {
                const r = orig.apply(this, args);
                if (this === box)
                    self._refresh();
                return r;
            });
        }
        // A Space label dropped on the bar reorders the Spaces (the bar is the drop target
        // for windows already; any other source is left to the stock rules)
        c.inject(ThumbnailsBox.prototype, 'handleDragOver', function (orig, source, ...args) {
            if (this === box && source?.guavaSpace)
                return DND.DragMotionResult.MOVE_DROP;
            return orig.call(this, source, ...args);
        });
        c.inject(ThumbnailsBox.prototype, 'acceptDrop', function (orig, source, actor, x, ...args) {
            if (this === box && source?.guavaSpace)
                return self._dropSpace(source, x);
            return orig.call(this, source, actor, x, ...args);
        });
        box._updateShouldShow();

        c.connect(box, 'motion-event', (_a, event) => {
            this._setHovered(this._thumbnailAt(event.get_coords()[0]));
            return Clutter.EVENT_PROPAGATE;
        });
        c.connect(box, 'leave-event', (_a, event) => {
            // Moving onto a Space's × (or label) keeps that Space hovered
            const to = event.get_related?.();
            if (!to || !box.contains(to))
                this._setHovered(null);
            return Clutter.EVENT_PROPAGATE;
        });
        c.connect(global.workspace_manager, 'workspaces-reordered', () => this._refresh());
        c.connect(global.workspace_manager, 'notify::n-workspaces', () => this._refresh());
        c.connect(Main.overview, 'hidden', () => this._undecorateAll());
        c.add(() => this._undecorateAll());
        c.add(() => this._plus?.destroy());
        this._refresh();
    }

    /** The live thumbnails (not sliding out), in workspace order. */
    _thumbnails() {
        return (this._box._thumbnails ?? []).filter(t => t.state <= ThumbnailState.NORMAL);
    }

    /**
     * Dress the live Spaces: decorations for new ones, none for those gone, the labels, the
     * × and the +. The chrome are children of the thumbnails, so they slide, fade and scale
     * with them (the overview's own transition, a Space coming or going) and need no
     * per-frame follow-up; only positions that depend on a thumbnail's size are set, as that
     * thumbnail is allocated (see _place), so they are never a frame behind.
     */
    _refresh() {
        const thumbs = this._thumbnails();
        for (const t of [...this._decor.keys()]) {
            if (!thumbs.includes(t))
                this._undecorate(t);
        }
        if (!thumbs.length)
            return;
        const labels = spaceLabels(this._host.spaces(thumbs.map(t => t.metaWorkspace)),
            n => this._host._('Desktop %d').format(n));
        const removable = canRemoveSpace(thumbs.length) && this._host.staticSpaces();
        thumbs.forEach((t, i) => {
            const d = this._decor.get(t) ?? this._decorate(t);
            d.label.text = labels[i].label;
            d.label.accessible_name = labels[i].label;
            d.close.accessible_name = this._host._('Remove %s').replace('%s', labels[i].label);
            d.removable = removable;
            // Measured at its natural width: a width set earlier would be read back as that
            // width, and a label narrowed while its Space slid would stay narrow
            d.label.set_width(-1);
            [, d.labelWidth] = d.label.get_preferred_width(-1);
            this._place(t);
        });
        this._syncClose();
        this._attachPlus();
        this._centre();
    }

    /**
     * The stock box centres its thumbnails as if every Space, one still collapsing in or out
     * included, had its full width, and as if the box got the width it asks for: the group
     * jumps aside when a Space is added or removed and glides back as it expands, and with
     * many Spaces it sits off the screen's centre. The bar is shifted by the difference, on
     * every frame of that animation (a transform, so no relayout).
     */
    _centre() {
        const box = this._box;
        const first = box._thumbnails?.[0];
        box.translation_x = first?.has_allocation() ? Math.round(centringShift({
            maxWidth: box._maxThumbnailScale * box._porthole.width,
            thumbnailWidth: first.get_allocation_box().get_width(),
            spacing: box.get_theme_node().get_length('spacing'),
            available: box.get_parent().get_allocation_box().get_width(),
            collapse: box._thumbnails.map(t => t.collapseFraction),
        })) : 0;
    }

    /** The + lives in the first Space and sits after the last one's visible edge. */
    _attachPlus() {
        const thumbs = this._thumbnails();
        this._plusWanted = thumbs.length > 0;
        if (!this._plusWanted) {
            if (this._plus)
                this._plus.visible = false;
            return;
        }
        if (!this._plus) {
            this._plus = new St.Button({
                style_class: 'guava-mc-space-add',
                accessible_name: this._host._('Add Desktop'),
                child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 16 }),
                can_focus: true,
                visible: false,
            });
            this._plus.connect('clicked', () => this._addSpace());
            this._plus.connect('destroy', () => {
                this._plus = null;
            });
        }
        const host = thumbs.find(t => t.state === ThumbnailState.NORMAL) ?? thumbs[0];
        if (this._plus.get_parent() !== host) {
            this._plus.get_parent()?.remove_child(this._plus);
            host.add_child(this._plus);
        }
        this._placePlus();
    }

    /**
     * Position what depends on a thumbnail's size. Translations only (no relayout), set
     * while the box allocates the thumbnail, so the chrome is on the frame that paints it.
     */
    _place(t) {
        const d = this._decor.get(t);
        if (d && t.has_allocation()) {
            // The allocation, not width and height: those read the preferred size while the
            // thumbnail waits for a layout, which this very pass is
            const [w, h] = [t.get_allocation_box().get_width(), t.get_allocation_box().get_height()];
            const width = Math.min(d.labelWidth, w + LABEL_SPILL);
            if (d.label.width !== width)
                d.label.set_width(width);
            d.label.translation_x = Math.round((w - width) / 2);
            d.label.translation_y = Math.round(h + LABEL_GAP);
        }
        this._placePlus();
    }

    _placePlus() {
        const plus = this._plus;
        const host = plus?.get_parent();
        const last = this._box._thumbnails?.at(-1);
        // A Space added this frame has no allocation yet: the plus waits for it
        if (!host?.has_allocation() || !last?.has_allocation() || !this._plusWanted)
            return;
        // The last Space's edge as the box lays it out: a Space still collapsed (coming) or
        // collapsing (going) takes only the part of its width that is left
        const [lastBox, hostBox] = [last.get_allocation_box(), host.get_allocation_box()];
        const edge = lastBox.x1 + lastBox.get_width() * (1 - last.collapseFraction);
        const [, ph] = plus.get_preferred_height(-1);
        plus.visible = true;
        plus.translation_x = Math.round(edge - hostBox.x1 + PLUS_GAP);
        plus.translation_y = Math.round((hostBox.get_height() - ph) / 2);
    }

    _decorate(t) {
        const cleanup = new CleanupRegistry();
        const label = cleanup.actor(new St.Label({ style_class: 'guava-mc-space-label', reactive: true, track_hover: true, can_focus: true }));
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const close = cleanup.actor(new St.Button({
            style_class: 'guava-mc-space-close',
            accessible_name: this._host._('Remove Desktop'),
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 10 }),
            track_hover: true,
            visible: false,
        }));
        // Children of the thumbnail, outside its edge: it no longer clips (its viewport does)
        t.clip_to_allocation = false;
        t._viewport.clip_to_allocation = true;
        cleanup.add(() => {
            t._viewport.clip_to_allocation = false;
            t.clip_to_allocation = true;
        });
        close.set_position(-CLOSE_INSET, -CLOSE_INSET);
        t.add_child(label);
        t.add_child(close);
        // The wallpaper behind the windows, as in macOS (the stock thumbnail is a grey plate)
        const wallpaper = new Background.BackgroundManager({
            container: t._contents, monitorIndex: t.monitorIndex, vignette: false,
        });
        wallpaper.backgroundActor.content.brightness = 1;
        cleanup.add(() => wallpaper.destroy());
        const d = { label, close, cleanup, removable: false, labelWidth: 0 };
        cleanup.connect(close, 'clicked', () => this._removeSpace(t.metaWorkspace));
        cleanup.connect(close, 'notify::hover', () => this._syncClose());
        cleanup.connect(label, 'notify::hover', () => this._setHovered(label.hover ? t : this._hovered));
        // Keyboard: a focused label stands for its Space (the pointer's hover), and Delete removes it
        cleanup.connect(label, 'key-focus-in', () => this._setHovered(t));
        cleanup.connect(label, 'key-focus-out', () => this._setHovered(null));
        cleanup.connect(label, 'key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            if ((sym !== Clutter.KEY_Delete && sym !== Clutter.KEY_BackSpace) || !d.removable)
                return Clutter.EVENT_PROPAGATE;
            this._removeSpace(t.metaWorkspace);
            return Clutter.EVENT_STOP;
        });
        // The box allocates a thumbnail as it slides, collapses and rescales
        cleanup.connect(t, 'notify::allocation', () => this._place(t));
        cleanup.connect(t, 'notify::collapse-fraction', () => this._centre());
        cleanup.connect(t, 'destroy', () => this._undecorate(t));

        // Drag the label along the bar to reorder
        label._delegate = {
            guavaSpace: t.metaWorkspace,
            getDragActor: () => new Clutter.Clone({
                source: t._viewport, width: t._viewport.width, height: t._viewport.height,
                scale_x: t._viewport.scale_x, scale_y: t._viewport.scale_y, opacity: 220,
            }),
            getDragActorSource: () => t,
        };
        const draggable = DND.makeDraggable(label, { restoreOnSuccess: false });
        cleanup.connect(draggable, 'drag-begin', () => this._setDragging(true));
        cleanup.connect(draggable, 'drag-end', () => this._setDragging(false));
        cleanup.connect(draggable, 'drag-cancelled', () => this._setDragging(false));
        this._decor.set(t, d);
        return d;
    }

    _undecorate(t) {
        const d = this._decor.get(t);
        if (!d)
            return;
        this._decor.delete(t);
        if (this._hovered === t)
            this._hovered = null;
        d.cleanup.dispose();
    }

    _undecorateAll() {
        for (const t of [...this._decor.keys()])
            this._undecorate(t);
        this._setDragging(false);
    }

    _thumbnailAt(stageX) {
        return this._thumbnails().find(t => {
            const [x] = t.get_transformed_position();
            const [w] = t.get_transformed_size();
            return stageX >= x && stageX <= x + w;
        }) ?? null;
    }

    _setHovered(t) {
        if (this._hovered === t)
            return;
        this._hovered = t;
        this._syncClose();
    }

    _syncClose() {
        for (const [t, d] of this._decor)
            d.close.visible = d.removable && !this._dragging && (t === this._hovered || d.close.hover);
    }

    _setDragging(on) {
        this._dragging = on;
        this._syncClose();
    }

    _addSpace() {
        this._host.holdStaticSpaces();
        global.workspace_manager.append_new_workspace(false, global.get_current_time());
    }

    _removeSpace(ws) {
        const wm = global.workspace_manager;
        if (!ws || !canRemoveSpace(wm.n_workspaces) || ws.index() < 0)
            return;
        this._hovered = null;
        wm.remove_workspace(ws, global.get_current_time());
    }

    _dropSpace(source, x) {
        const ws = source?.guavaSpace;
        if (!ws || ws.index() < 0)
            return false;
        // x is in the bar's own coordinates, as are the thumbnails' allocations
        const centres = this._thumbnails().map(t => {
            const b = t.get_allocation_box();
            return (b.x1 + b.x2) / 2;
        });
        const target = reorderIndex(centres, x);
        if (target !== ws.index())
            global.workspace_manager.reorder_workspace(ws, target);
        return true;
    }
}
