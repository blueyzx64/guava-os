// SPDX-License-Identifier: GPL-3.0-or-later
// Accessibility helpers shared by every Guava surface: one place to name an actor, give it a role,
// and make it keyboard-reachable, so the same three lines are not repeated in each feature.
//
//   A11y.name(actor, _('Search'));                       // accessible name only
//   A11y.name(actor, _('Dock'), Atk.Role.TOOL_BAR);      // name + role
//   A11y.control(button, _('Pin'));                      // name + focusable + reactive
//   A11y.toggle(button, _('Recording'));                 // name + TOGGLE_BUTTON role
//   A11y.dialog(overlay, _('Spotlight'));                // modal surface: DIALOG role + name
//   A11y.focusGroup(cleanup, actor, _('Dock'));          // Ctrl+Alt+Tab lists it; Tab and arrows move inside
//   A11y.setEnabled(button, false);                      // reactive, focusable and sensitive together

import Atk from 'gi://Atk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const Role = Atk.Role;

/** Set the accessible name (and optionally the role) of an actor. Returns the actor. */
export function name(actor, text, role = null) {
    actor.accessible_name = text ?? '';
    if (role !== null)
        actor.accessible_role = role;
    return actor;
}

/** A pointer-and-keyboard control: named, focusable, reactive. */
export function control(actor, text, role = null) {
    actor.reactive = true;
    actor.can_focus = true;
    return name(actor, text, role);
}

/** A two-state button: TOGGLE_BUTTON role so the checked state is announced. */
export function toggle(button, text) {
    button.toggle_mode = true;
    return control(button, text, Atk.Role.TOGGLE_BUTTON);
}

/** A modal surface or popup panel. */
export function dialog(actor, text) {
    return name(actor, text, Atk.Role.DIALOG);
}

/** Keep reactivity, keyboard focus and the sensitive state in step, so a disabled control
 *  is neither clickable nor a dead tab stop. */
export function setEnabled(actor, enabled) {
    actor.reactive = enabled;
    actor.can_focus = enabled;
    if ('sensitive' in actor)
        actor.sensitive = enabled;
}

/** Make a chrome surface keyboard-reachable the way the Shell does for its own panels: it is
 *  listed in the Ctrl+Alt+Tab switcher while mapped, and Tab and the arrow keys move focus
 *  between its controls. Undone with `cleanup`.
 *  @param {object} cleanup CleanupRegistry
 *  @param {St.Widget} root the surface; a hidden one is skipped by the switcher
 *  @param {string} label what the switcher shows
 *  @param {string} [icon] symbolic icon name for the switcher entry
 *  @param {{proxy?: Clutter.Actor, focus?: Function}} [opts] `proxy`: the actor whose mapped state
 *    decides whether the switcher lists it (default root); `focus`: moves the focus in, for a
 *    surface that must be revealed first */
export function focusGroup(cleanup, root, label, icon = 'view-app-grid-symbolic', opts = {}) {
    const manager = Main.ctrlAltTabManager;
    manager.addGroup(root, label, icon, { proxy: opts.proxy ?? root, focusCallback: opts.focus ?? null });
    // The manager drops the group itself when the actor is destroyed; a second removal would
    // touch a disposed object
    let alive = true;
    root.connect('destroy', () => (alive = false));
    cleanup.add(() => alive && manager.removeGroup(root));
}

/** Tab and arrow-key movement inside a surface that is not a Ctrl+Alt+Tab target (a modal,
 *  a popup): the focus manager only walks groups it knows. Undone with `cleanup`. */
export function keyNavGroup(cleanup, root) {
    global.focus_manager.add_group(root);
    let alive = true;
    root.connect('destroy', () => (alive = false));
    cleanup.add(() => alive && global.focus_manager.remove_group(root));
}

/** Describe the highlighted result of a list whose keyboard focus stays in a search field (the
 *  list-box pattern): a screen reader reads it as the field's description. */
export function describeSelection(field, text) {
    field.get_accessible()?.set_description(text ?? '');
}

/** Is the keyboard focus on `root` or inside it? (False when nothing has the focus.) */
export function focusWithin(root) {
    const focus = global.stage.key_focus;
    return !!focus && root.contains(focus);
}
