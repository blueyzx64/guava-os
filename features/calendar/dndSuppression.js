// SPDX-License-Identifier: GPL-3.0-or-later
// Takes GNOME's own Do Not Disturb UI out of the way while dndButton.js shows Guava's: the
// Quick Settings toggle (GNOME 49+), its top-bar indicator, and the moon of the date menu.
// Each helper returns its undo, or null when there was nothing to take away. While the
// Control Center runs it owns Do Not Disturb and the registry keeps dndButton.js off.
//
// Private Shell API: quickSettings.menu._grid, ._indicators, dateMenu._indicator (48-51).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isDndActor } from './model.js';

/** Where each suppressed actor lives; looked up again on restore (the old one may be dead). */
const CONTAINERS = {
    toggle: () => Main.panel.statusArea.quickSettings?.menu?._grid ?? null,
    indicator: () => Main.panel.statusArea.quickSettings?._indicators ?? null,
};

// Read what isDndActor() looks at from an actor tree, at most a few levels deep.
function describe(actor, depth = 0) {
    return {
        accessibleName: actor.accessible_name ?? '',
        title: `${actor.title ?? actor.text ?? ''}`,
        styleClass: actor.style_class ?? '',
        typeName: actor.constructor?.name ?? '',
        iconName: actor.icon_name ?? null,
        children: depth < 4 ? actor.get_children().map(c => describe(c, depth + 1)) : [],
    };
}

// Remove `actor` from its parent and hide it; the undo puts it back at its index in the live
// container, with its old visibility when asked.
function take(kind, actor, keepState) {
    const parent = actor.get_parent();
    if (!parent)
        return null;
    const index = parent.get_children().indexOf(actor);
    const state = keepState ? { visible: actor.visible, reactive: actor.reactive, opacity: actor.opacity } : null;
    let destroyed = false;
    const destroyId = actor.connect('destroy', () => (destroyed = true));
    parent.remove_child(actor);
    actor.hide();
    return () => {
        if (destroyed)
            return;
        actor.disconnect(destroyId);
        const live = CONTAINERS[kind]();
        if (!live || actor.get_parent())
            return;
        live.insert_child_at_index(actor, Math.min(index, live.get_n_children()));
        if (state)
            Object.assign(actor, state);
        else
            actor.show();
    };
}

/** GNOME's Do Not Disturb toggle in the Quick Settings grid. */
export function suppressDndToggle() {
    const grid = CONTAINERS.toggle();
    const toggle = grid?.get_children().find(c => isDndActor(describe(c), { iconOnly: false }));
    return toggle ? take('toggle', toggle, false) : null;
}

/** The stock Do Not Disturb icon among the top-bar indicators (not Guava's). */
export function suppressDndIndicator() {
    const row = CONTAINERS.indicator();
    const icon = row?.get_children().find(c =>
        !(c.style_class ?? '').includes('guava-dnd-indicator') && isDndActor(describe(c), { iconOnly: true }));
    return icon ? take('indicator', icon, true) : null;
}

/** The date menu's own moon: kept hidden (it shows itself again on every sync). */
export function hideDateMenuIndicator() {
    const indicator = Main.panel.statusArea.dateMenu?._indicator;
    if (!indicator)
        return null;
    const state = { visible: indicator.visible, reactive: indicator.reactive, opacity: indicator.opacity };
    const enforce = () => {
        indicator.reactive = false;
        indicator.opacity = 0;
        indicator.hide();
    };
    enforce();
    const ids = ['notify::visible', 'notify::opacity', 'show'].map(s => indicator.connect(s, enforce));
    return () => {
        ids.forEach(id => indicator.disconnect(id));
        Object.assign(indicator, state);
    };
}
