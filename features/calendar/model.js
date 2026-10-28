// SPDX-License-Identifier: GPL-3.0-or-later
// Pure decisions of the calendar feature. No gi imports.

/** Narrowest calendar menu, px (the stock month grid needs about this). */
export const MIN_MENU_WIDTH = 300;
/** Room around the month grid inside the menu, px. */
const MENU_PADDING = 20;

/** Width of the date menu once the notification column is gone. */
export function menuWidth(naturalCalendarWidth) {
    return Math.max(MIN_MENU_WIDTH, Math.round(naturalCalendarWidth) + MENU_PADDING);
}

/**
 * Inline style of the notification dot.
 *
 * @param {'default'|'accent'|'symbolic'|string} style notification-indicator-style
 * @param {boolean} besideClock the dot is the last item of the right box (keep-notification-
 *   panel): it gets room from the screen edge
 * @returns {?string} null leaves the panel colour to cascade
 */
export function indicatorStyle(style, besideClock) {
    const margin = besideClock ? ' margin-right: 12px;' : '';
    switch (style) {
    case 'accent':
        return `color: -st-accent-color;${margin}`;
    case 'symbolic':
        return margin ? margin.trim() : null;
    default:
        return `color: red;${margin}`;
    }
}

const DND_ICON_NAMES = new Set([
    'weather-clear-night-symbolic', 'weather-clear-night',
    'notifications-disabled-symbolic', 'notifications-disabled',
    'notifications-none-symbolic', 'notifications-none',
]);

function hasDndIcon(node) {
    if (node.iconName && DND_ICON_NAMES.has(node.iconName.toLowerCase()))
        return true;
    return (node.children ?? []).some(hasDndIcon);
}

/**
 * Is this (described) actor GNOME's Do Not Disturb toggle or indicator?
 *
 * @param {{accessibleName: string, title: string, styleClass: string, typeName: string,
 *   iconName: ?string, children: object[]}} node a plain description of the actor tree
 * @param {{iconOnly: boolean}} opts iconOnly: only the icon and the style class count (the
 *   top-bar indicator has no title)
 * @returns {boolean}
 */
export function isDndActor(node, { iconOnly }) {
    const style = node.styleClass.toLowerCase();
    if (iconOnly)
        return hasDndIcon(node) || style.includes('dnd');
    const text = `${node.accessibleName} ${node.title}`.toLowerCase();
    return text.includes('do not disturb') || hasDndIcon(node) ||
        style.includes('dnd') || style.includes('do-not-disturb') ||
        node.typeName.toLowerCase().includes('disturb');
}
