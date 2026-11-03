// SPDX-License-Identifier: GPL-3.0-or-later
// Control Center shell adapter: the only file that reads Quick Settings private fields.
//
// Checked against gnome-shell 48.0, 49.0, 50.0 and main (51):
//   js/ui/panel.js       QuickSettings: _network _bluetooth _system _volumeOutput _volumeInput
//                        _brightness _backlight _nightLight _darkMode _powerProfiles
//                        _rfkill _autoRotate _location _camera _remoteAccess _thunderbolt
//                        _unsafeMode _backgroundApps, all set together after the async
//                        imports; _doNotDisturb exists from 49 on.
//   js/ui/status/network.js  Indicator: _wirelessToggle _wiredToggle _modemToggle _btToggle _vpnToggle
//   js/ui/quickSettings.js   QuickSettingsMenu._grid; its layout manager has `nColumns`, a
//                        per-child `column-span`, and `_overlay` (a placeholder child that the
//                        layout skips and that must stay in the grid).
//   js/ui/quickSettings.js   QuickToggle: child `_box` (St.BoxLayout: `_icon`, then a box
//                        holding `_title` and `_subtitle`). The title box's visibility is
//                        not bound to anything, so hiding it is safe and reversible.
//   js/ui/status/system.js   SystemItem.child (St.BoxLayout), powerToggle._proxy (UPower.Device).

import Clutter from 'gi://Clutter';
import { QuickMenuToggle, QuickToggle } from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { COLUMNS, restoreOrder } from './model.js';

/**
 * True while the grid can still be laid out. During its destruction (Shell shutdown, or a
 * rebuilt Quick Settings menu) Clutter has already dropped the layout manager.
 */
export function gridAlive(grid) {
    return !!grid?.layout_manager;
}

/** The grid's placeholder child: the layout skips it, so it is never planned or moved. */
function placeholder(grid) {
    return grid.layout_manager?._overlay ?? null;
}

export function columnSpan(grid, actor) {
    try {
        return grid.layout_manager.get_child_meta(grid, actor).columnSpan;
    } catch (_e) {
        return 1;
    }
}

function setSpan(grid, actor, span) {
    grid.layout_manager?.child_set_property(grid, actor, 'column-span', span);
}

/** Children the plan manages: everything in the grid except the placeholder. */
export function managedChildren(grid) {
    if (!gridAlive(grid))
        return [];
    const skip = placeholder(grid);
    return grid.get_children().filter(child => child !== skip);
}

/**
 * Remember how the grid looked. Holds actors, not their parent: on restore the live grid is
 * used, so a grid that was rebuilt in between cannot receive stale parent/index pairs.
 */
export function snapshotGrid(grid) {
    const layout = grid.layout_manager;
    // Every child, the placeholder included, so restore also gives it back its z-order slot
    const actors = grid.get_children();
    return {
        columns: layout.nColumns,
        actors,
        spans: new Map(actors.map(actor => [actor, columnSpan(grid, actor)])),
    };
}

/**
 * Apply a plan.
 *
 * @param {St.Widget} grid
 * @param {{actor: Clutter.Actor, span: number}[]} placed in final order
 */
export function applyPlan(grid, placed) {
    if (!gridAlive(grid))
        return;
    const layout = grid.layout_manager;
    layout.nColumns = COLUMNS;
    for (const { actor, span } of placed) {
        if (actor.get_parent() !== grid)
            continue;
        if (columnSpan(grid, actor) !== span)
            setSpan(grid, actor, span);
        // Raising to the top in plan order leaves the placeholder first, in front of all
        grid.set_child_above_sibling(actor, null);
    }
    layout.layout_changed();
}

/**
 * Put the grid back as the snapshot saw it. Actors that have left the grid are skipped;
 * the order comes from restoreOrder(), so nothing is inserted into a foreign parent.
 * `stockSpans` (actor -> span it arrived with) covers actors the snapshot never saw.
 */
export function restoreGrid(grid, snapshot, stockSpans = new Map()) {
    if (!gridAlive(grid) || !snapshot)
        return;
    const layout = grid.layout_manager;
    for (const actor of restoreOrder(snapshot.actors, grid.get_children())) {
        // Actors that joined after the snapshot go back to the span they arrived with
        const span = snapshot.spans.get(actor) ?? stockSpans.get(actor) ?? 1;
        if (columnSpan(grid, actor) !== span)
            setSpan(grid, actor, span);
        grid.set_child_above_sibling(actor, null);
    }
    layout.nColumns = snapshot.columns;
    layout.layout_changed();
}

const COMPACT_CLASS = 'guava-cc-compact';

/** Layout classes the plan puts on grid items (stylesheet.css: margins and module joins). */
export const ITEM_CLASS = 'guava-cc-item';
export const JOIN_PREV_CLASS = 'guava-cc-join-prev';
export const JOIN_NEXT_CLASS = 'guava-cc-join-next';
const LAYOUT_CLASSES = [ITEM_CLASS, JOIN_PREV_CLASS, JOIN_NEXT_CLASS];

/**
 * Put exactly `wanted` (a subset of the layout classes) on `actor`. `saved` remembers every
 * actor that got one, so restoreLayoutClasses() can take them all off on teardown.
 *
 * @param {St.Widget} actor
 * @param {string[]} wanted
 * @param {Set<St.Widget>} saved
 */
export function setLayoutClasses(actor, wanted, saved) {
    if (!actor.add_style_class_name)
        return;
    for (const name of LAYOUT_CLASSES) {
        if (wanted.includes(name))
            actor.add_style_class_name(name);
        else
            actor.remove_style_class_name(name);
    }
    saved.add(actor);
}

/** Undo setLayoutClasses() for every actor in `saved` that still exists. */
export function restoreLayoutClasses(saved) {
    for (const actor of saved) {
        try {
            for (const name of LAYOUT_CLASSES)
                actor.remove_style_class_name(name);
        } catch (_e) {
            // Destroyed with its grid
        }
    }
    saved.clear();
}

/**
 * True for a plain QuickToggle (no menu arrow): it can become a 1x1 icon-only square.
 * QuickMenuToggle is a sibling class, so it is never compactable.
 */
export function compactable(actor) {
    return actor instanceof QuickToggle && !!actor._title?.get_parent() && !!actor._box;
}

/**
 * Turns the icon-only look of a plain QuickToggle on or off. `saved` (actor -> what the
 * stock code had) is filled on the first compaction and emptied on the way back, so the
 * caller can undo every actor it still holds in one pass on teardown.
 *
 * @param {QuickToggle} actor
 * @param {boolean} on
 * @param {Map<Clutter.Actor, object>} saved
 */
export function setCompact(actor, on, saved) {
    let was = saved.get(actor);
    if (on) {
        if (!was) {
            const titleBox = actor._title?.get_parent();
            const box = actor._box;
            if (!titleBox || !box)
                return;
            was = {
                titleBox, box, dead: false,
                titleVisible: titleBox.visible,
                xExpand: box.x_expand,
                xAlign: box.x_align,
            };
            // A toggle destroyed with its grid (Shell shutdown) is never touched again
            was.destroyId = titleBox.connect('destroy', () => {
                was.dead = true;
            });
            saved.set(actor, was);
        }
        if (was.dead)
            return;
        was.titleBox.visible = false;
        was.box.x_expand = false;
        was.box.x_align = Clutter.ActorAlign.CENTER;
        actor.add_style_class_name(COMPACT_CLASS);
        return;
    }
    if (!was)
        return;
    saved.delete(actor);
    if (was.dead)
        return;
    was.titleBox.disconnect(was.destroyId);
    was.titleBox.visible = was.titleVisible;
    was.box.x_expand = was.xExpand;
    was.box.x_align = was.xAlign;
    actor.remove_style_class_name(COMPACT_CLASS);
}

const ICON_CLASS = 'quick-toggle-icon';

function _toggleIcon(actor) {
    // QuickToggle has its icon as `_icon`; a QuickMenuToggle wraps a QuickToggle
    if (actor._icon?.has_style_class_name?.(ICON_CLASS))
        return actor._icon;
    const contents = actor._box?.get_first_child?.();
    return contents?._icon?.has_style_class_name?.(ICON_CLASS) ? contents._icon : null;
}

/**
 * Keeps the icon circle of a toggle round. The stock icon fills the height of its row, so
 * beside a two-line title (Wi-Fi with a network name) the circle the Control Center draws
 * behind it became an upright oval. Centring it keeps it a circle. `saved` (actor -> what
 * the stock code had) lets restoreToggleIcons() undo it.
 *
 * @param {Clutter.Actor} actor a grid item
 * @param {Map<Clutter.Actor, object>} saved
 */
export function centerToggleIcon(actor, saved) {
    if (saved.has(actor) || !(actor instanceof QuickToggle || actor instanceof QuickMenuToggle))
        return;
    const icon = _toggleIcon(actor);
    if (!icon)
        return;
    const was = { icon, yAlign: icon.y_align, dead: false };
    // An icon destroyed with its grid (Shell shutdown) is never touched again
    was.destroyId = icon.connect('destroy', () => {
        was.dead = true;
    });
    saved.set(actor, was);
    icon.y_align = Clutter.ActorAlign.CENTER;
}

/** Undo centerToggleIcon() for one actor, or for every actor when `actor` is omitted. */
export function restoreToggleIcons(saved, actor = null) {
    for (const key of actor ? [actor] : [...saved.keys()]) {
        const was = saved.get(key);
        if (!was)
            continue;
        saved.delete(key);
        if (was.dead)
            continue;
        was.icon.disconnect(was.destroyId);
        was.icon.y_align = was.yAlign;
    }
}

/** Undo setCompact() for every actor in `saved`. */
export function restoreCompact(saved) {
    for (const actor of [...saved.keys()]) {
        try {
            setCompact(actor, false, saved);
        } catch (_e) {
            // Destroyed with its grid
            saved.delete(actor);
        }
    }
}
