// SPDX-License-Identifier: GPL-3.0-or-later
// DockView: the dock's actors.
//
//   band     the edge claim's chrome actor (core/layout): exactly the claimed rect, touching
//            the edge, so the Shell makes a strut from it; not reactive. It clips only while the
//            frame is slid away (auto-hide); otherwise bounces and magnified icons draw above it
//   edge     a thin reactive line on the screen edge: the auto-hide reveal zone
//   frame    reactive, holds the pill plus the floating gap to the edge, so moving from the
//            edge to the icons never leaves the dock (auto-hide hover)
//   pill     the glass slab with the items (lib/glass.js 'dock' surface)
//
// Also the hover label, the drag placeholder, the "drag out to remove" catcher and the poof.
// Nothing here decides anything: index.js does.
//
// Shell API: Main.layoutManager.uiGroup (labels, catcher, poof), ui/dnd.js delegates.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import * as A11y from '../../lib/a11y.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { Glass } from '../../lib/glass.js';
import { dropIndex, isHorizontal } from './model.js';

const ALIGN = Clutter.ActorAlign;
const PUFFS = 5;          // circles in the poof cloud
// The reveal zone on the screen edge. The Shell's pick skips a 1 px child of a chrome actor
// (checked on GNOME 50), so the zone is two pixels deep.
const EDGE_ZONE = 2;

export class DockView {
    /**
     * @param {object} host the Dock (index.js): motion, metrics, config, callbacks
     * @param {CleanupRegistry} cleanup the feature's registry
     */
    constructor(host, cleanup) {
        this._host = host;
        this._cleanup = cleanup;
        this._items = new Map(); // id -> item
        this._shown = true;
        this._slide = null;
        this.band = cleanup.actor(new St.Widget({
            name: 'guava-dock', style_class: 'guava-dock-band',
            layout_manager: new Clutter.BinLayout(), reactive: false, clip_to_allocation: false,
        }));
        this._label = cleanup.actor(new St.Label({ style_class: 'guava-dock-label', opacity: 0, visible: false }));
        Main.layoutManager.uiGroup.add_child(this._label);
        this._buildCleanup = null;
        // The Shell destroys its chrome on shutdown without disabling extensions
        this.alive = true;
        cleanup.connect(this.band, 'destroy', () => {
            this.alive = false;
        });
        cleanup.add(() => this._clear());
    }

    // Items first (their menus, monitors and drags), then the frame they sit in
    _clear() {
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._buildCleanup?.dispose();
        this._buildCleanup = null;
    }

    /** (Re)build frame and pill for the current host config and metrics. Items are dropped. */
    build() {
        this._clear();
        const reg = this._buildCleanup = new CleanupRegistry();
        const { position } = this._host.config;
        const m = this._host.metrics;
        const horizontal = isHorizontal(position);

        this.edge = reg.actor(new St.Widget({
            style_class: 'guava-dock-edge', reactive: false, track_hover: true,
            x_expand: true, y_expand: true,
            x_align: horizontal ? ALIGN.FILL : position === 'left' ? ALIGN.START : ALIGN.END,
            y_align: horizontal ? ALIGN.END : ALIGN.FILL,
            width: horizontal ? -1 : EDGE_ZONE, height: horizontal ? EDGE_ZONE : -1,
        }));
        this.frame = reg.actor(new St.Widget({
            style_class: 'guava-dock-frame', reactive: true, track_hover: true,
            layout_manager: new Clutter.BinLayout(),
            x_align: horizontal ? ALIGN.CENTER : position === 'left' ? ALIGN.START : ALIGN.END,
            y_align: horizontal ? ALIGN.END : ALIGN.CENTER,
        }));
        // The frame can be destroyed on its own at shutdown (before the band's signal): a sync
        // queued for that moment must not touch it
        this.alive = true;
        const frame = this.frame;
        frame.connect('destroy', () => {
            if (this.frame === frame)
                this.alive = false;
        });
        // The gap between the pill and the edge belongs to the frame (hover). The same gap on the
        // other side is the frame's margin, so the band (the strut) is as deep as both gaps and the
        // pill; a margin is not hit-testable, so the gap on the windows' side stays theirs
        const pad = {
            bottom: `padding-bottom: ${m.gap}px; margin-top: ${m.gap}px;`,
            left: `padding-left: ${m.gap}px; margin-right: ${m.gap}px;`,
            right: `padding-right: ${m.gap}px; margin-left: ${m.gap}px;`,
        };
        this.frame.set_style(pad[position]);
        this.pill = new St.BoxLayout({
            style_class: 'guava-dock',
            orientation: horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            reactive: true,
            accessible_name: this._host.gettext('Dock'),
            accessible_role: A11y.Role.TOOL_BAR,
        });
        this.pill.set_style(`border-radius: ${m.radius}px; padding: ${m.padding}px; border-width: ${m.border}px;`);
        // The glass's drop shadow is drawn by a host right behind the pill, same rect
        const shadow = new St.Widget({ style_class: 'guava-dock-shadow' });
        shadow.set_style(`border-radius: ${m.radius}px;`);
        shadow.add_constraint(new Clutter.BindConstraint({ source: this.pill, coordinate: Clutter.BindCoordinate.ALL }));
        this.frame.add_child(shadow);
        this.frame.add_child(this.pill);
        // Magnification grows the slab at its ends (magnify.js); zero-sized at rest
        this._growBefore = new St.Widget({ width: 0, height: 0 });
        this._growAfter = new St.Widget({ width: 0, height: 0 });
        this.pill.add_child(this._growBefore);
        this.pill.add_child(this._growAfter);
        this.band.add_child(this.frame);
        this.band.add_child(this.edge);
        const glass = Glass.attach(this.pill, { surface: 'dock', role: 'bar', shadow });
        reg.add(() => glass.destroy());

        // Reorder drops land on the pill (app icons first get the chance to take a file drop)
        this.pill._delegate = {
            handleDragOver: (source, _actor, x, y) => this._host.dragOverDock(source, horizontal ? x : y),
            acceptDrop: (source, _actor, x, y) => this._host.dropOnDock(source, horizontal ? x : y),
        };
        // Keyboard: Ctrl+Alt+Tab lists the dock, Tab and the arrows walk the icons, and keyboard
        // focus inside keeps an auto-hidden dock up like the pointer does
        A11y.focusGroup(reg, this.frame, this._host.gettext('Dock'), 'user-desktop-symbolic');
        const dockUp = () => this.frame.hover || A11y.focusWithin(this.frame);
        reg.connect(this.frame, 'notify::hover', () => this._host.dockHovered(dockUp()));
        reg.connect(global.stage, 'notify::key-focus', () => this._host.dockHovered(dockUp()));
        reg.connect(this.edge, 'notify::hover', () => this._host.edgeHovered(this.edge.hover));
        // A relayout moves icons: the minimize targets follow (not per frame: allocation only)
        reg.connect(this.pill, 'notify::allocation', () => this._host.dockRelayout());
        reg.add(() => {
            this._removePlaceholder();
            this._slide?.cancel();
            this._slide = null;
        });
        this._shown = true;
        this.frame.translation_x = this.frame.translation_y = 0;
    }

    /** The registry of the current build (frame, pill and what hangs on them). */
    get buildCleanup() {
        return this._buildCleanup;
    }

    /** Place the band on the claimed rect. */
    setRect(rect) {
        // The Shell destroys its chrome on shutdown before any work-area event stops
        if (!rect || !this.alive)
            return;
        this.band.set_position(rect.x, rect.y);
        this.band.set_size(rect.width, rect.height);
    }

    // ---- items ---------------------------------------------------------------------------

    /**
     * Show `specs` in order, reusing the items of ids already shown.
     *
     * @param {object[]} specs model.dockItems()
     * @param {(spec) => ?object} create builds an item for a new id (null to skip it)
     */
    setItems(specs, create) {
        if (!this.alive)
            return;
        const next = new Map();
        for (const spec of specs) {
            let item = this._items.get(spec.id);
            if (item && item.spec.kind === spec.kind) {
                item.update(spec);
            } else {
                item?.destroy();
                item = create(spec);
            }
            if (item)
                next.set(spec.id, item);
        }
        for (const [id, item] of this._items) {
            if (!next.has(id))
                item.destroy();
        }
        this._items = next;
        // Items sit between the two growth spacers
        let index = 1;
        for (const item of next.values()) {
            if (item.actor.get_parent() !== this.pill)
                this.pill.insert_child_at_index(item.actor, index);
            else
                this.pill.set_child_at_index(item.actor, index);
            index++;
        }
    }

    /** @returns {IterableIterator<object>} */
    items() {
        return this._items.values();
    }

    item(id) {
        return this._items.get(id) ?? null;
    }

    /**
     * Rect of an item's icon on screen, as it is when the dock shows (an auto-hidden dock's
     * slide is left out), in stage coordinates.
     */
    rectOf(item) {
        const actor = item?.iconActor;
        if (!this.alive || !actor?.mapped)
            return null;
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        return {
            x: Math.round(x - this.frame.translation_x), y: Math.round(y - this.frame.translation_y),
            width: Math.round(width), height: Math.round(height),
        };
    }

    /** Extra length at the start and end of the slab (magnification), px. */
    setGrowth(before, after) {
        const horizontal = isHorizontal(this._host.config.position);
        const prop = horizontal ? 'width' : 'height';
        if (this._growBefore[prop] !== before)
            this._growBefore[prop] = before;
        if (this._growAfter[prop] !== after)
            this._growAfter[prop] = after;
    }

    // ---- auto-hide -----------------------------------------------------------------------

    /** The edge reveal zone takes the pointer only while the dock auto-hides. */
    setEdgeActive(on) {
        this.edge.reactive = on;
    }

    /** Slide the frame in or out. */
    setShown(shown) {
        if (!this.alive || shown === this._shown)
            return;
        this._shown = shown;
        const { position } = this._host.config;
        const off = this._host.metrics.size;
        const to = {
            translation_x: shown || position === 'bottom' ? 0 : position === 'left' ? -off : off,
            translation_y: shown || position !== 'bottom' ? 0 : off,
        };
        this._slide?.cancel();
        // What slides out of the band stays hidden; what is drawn above a resting dock is not cut
        this.band.clip_to_allocation = true;
        this._slide = this._host.motion.ease(this.frame, to, {
            duration: 'medium', curve: shown ? 'emphasized' : 'exit',
            onDone: ok => {
                if (ok && shown && this.alive)
                    this.band.clip_to_allocation = false;
            },
        }, this._buildCleanup);
    }

    get shown() {
        return this._shown;
    }

    // ---- hover label ---------------------------------------------------------------------

    /** The name bubble beside an item (above it on a bottom dock). */
    showLabel(item) {
        const label = this._label;
        label.text = item.name;
        label.visible = true;
        Main.layoutManager.uiGroup.set_child_above_sibling(label, null);
        const [x, y] = item.actor.get_transformed_position();
        const [w, h] = item.actor.get_transformed_size();
        const [, , lw, lh] = label.get_preferred_size();
        const gap = Math.round(this._host.metrics.padding * 1.5);
        const { position } = this._host.config;
        const pos = {
            bottom: [x + w / 2 - lw / 2, y - this._host.metrics.padding - gap - lh],
            left: [x + w + this._host.metrics.padding + gap, y + h / 2 - lh / 2],
            right: [x - this._host.metrics.padding - gap - lw, y + h / 2 - lh / 2],
        }[position];
        const monitor = Main.layoutManager.primaryMonitor;
        label.set_position(
            Math.round(Math.max(monitor.x, Math.min(pos[0], monitor.x + monitor.width - lw))),
            Math.round(pos[1]));
        const lift = position === 'bottom' ? { translation_y: 4 } : { translation_x: position === 'left' ? -4 : 4 };
        if (label.opacity === 0)
            label.set(lift);
        this._host.motion.ease(label, { opacity: 255, translation_x: 0, translation_y: 0 },
            { duration: 'micro', curve: 'enter' }, this._cleanup);
    }

    hideLabel() {
        const label = this._label;
        this._host.motion.ease(label, { opacity: 0 }, {
            duration: 'micro', curve: 'exit',
            onDone: finished => {
                if (finished)
                    label.visible = false;
            },
        }, this._cleanup);
    }

    // ---- drag and drop ---------------------------------------------------------------------

    /**
     * Where a drop at `coord` (pill coordinates along the dock) lands among `items`.
     *
     * @returns {number} index into items
     */
    dropIndexAmong(items, coord) {
        const horizontal = isHorizontal(this._host.config.position);
        const centres = items.map(i => (horizontal ? i.actor.x + i.actor.width / 2 : i.actor.y + i.actor.height / 2));
        return dropIndex(centres, coord);
    }

    /** Show the drop gap before `beforeItem` (null: after `afterItem`). */
    showPlaceholder(beforeItem, afterItem) {
        if (!this._placeholder) {
            const m = this._host.metrics;
            this._placeholder = new St.Widget({ style_class: 'guava-dock-placeholder', width: m.tile, height: m.tile });
            this.pill.add_child(this._placeholder);
        }
        const children = this.pill.get_children()
            .filter(c => c !== this._placeholder && c !== this._growBefore && c !== this._growAfter);
        let index = beforeItem ? children.indexOf(beforeItem.actor) : children.indexOf(afterItem?.actor) + 1;
        if (index < 0)
            index = 0;
        this.pill.set_child_at_index(this._placeholder, index + 1);
    }

    hidePlaceholder() {
        this._removePlaceholder();
    }

    _removePlaceholder() {
        this._placeholder?.destroy();
        this._placeholder = null;
    }

    /**
     * While an item that can leave the dock is dragged: a screen-wide drop target under the
     * dock. Dropping on it removes the item ("Remove" shows near the pointer meanwhile).
     *
     * @param {(x: number, y: number) => void} onDrop stage coordinates
     */
    showRemoveCatcher(onDrop) {
        this.hideRemoveCatcher();
        const monitor = Main.layoutManager.primaryMonitor;
        const catcher = new St.Widget({
            reactive: true, x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
        const label = new St.Label({ style_class: 'guava-dock-label guava-dock-remove', text: this._host.gettext('Remove'), visible: false });
        catcher.add_child(label);
        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this._cleanup.actor(catcher));
        uiGroup.set_child_below_sibling(catcher, this.band);
        catcher._delegate = {
            handleDragOver: (_source, _actor, x, y) => {
                label.visible = true;
                label.set_position(Math.round(x - label.width / 2), Math.round(y - this._host.metrics.icon));
                this.hidePlaceholder();
                return DND.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: (_source, _actor, x, y) => {
                onDrop(monitor.x + x, monitor.y + y);
                return true;
            },
        };
        // The pointer back over the dock: no "Remove"
        catcher.connect('leave-event', () => {
            label.visible = false;
        });
        this._catcher = catcher;
    }

    hideRemoveCatcher() {
        this._catcher?.destroy();
        this._catcher = null;
    }

    /** The puff of smoke where an item left the dock. */
    poof(x, y) {
        const m = this._host.metrics;
        const size = Math.round(m.icon * 0.9);
        const cloud = new St.Widget({ x: Math.round(x - size / 2), y: Math.round(y - size / 2), width: size, height: size });
        Main.layoutManager.uiGroup.add_child(cloud);
        this._cleanup.actor(cloud);
        let left = PUFFS;
        for (let i = 0; i < PUFFS; i++) {
            const angle = (i / PUFFS) * 2 * Math.PI;
            const r = Math.round(size * 0.42);
            const puff = new St.Widget({
                style_class: 'guava-dock-poof',
                width: r, height: r,
                x: Math.round(size / 2 - r / 2 + Math.cos(angle) * r * 0.35),
                y: Math.round(size / 2 - r / 2 + Math.sin(angle) * r * 0.35),
                scale_x: 0.5, scale_y: 0.5,
                pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            });
            puff.set_style(`border-radius: ${Math.ceil(r / 2)}px;`);
            cloud.add_child(puff);
            this._host.motion.ease(puff, {
                opacity: 0, scale_x: 1.6, scale_y: 1.6,
                translation_x: Math.round(Math.cos(angle) * r * 0.8),
                translation_y: Math.round(Math.sin(angle) * r * 0.8),
            }, {
                duration: 'medium', curve: 'standard',
                onDone: () => {
                    if (--left === 0)
                        cloud.destroy();
                },
            }, this._cleanup);
        }
    }
}
