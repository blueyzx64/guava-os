// SPDX-License-Identifier: GPL-3.0-or-later
// Notification Center: the pure rules (no gi imports, unit-tested).
//
// The column (macOS Big Sur and later) shows the notification history grouped by app, newest
// app first. A group is a stack showing its newest notification, with the others peeking out
// below it; a click expands it. Only a few groups show before a "N more" button. On top sits
// the date with a small month, the calendar card the column absorbs.
//
// Items are plain descriptions made by the adapter:
//   {key, appId, appName, title, body, time (ms), urgency}

export const COLLAPSED_GROUPS = 4;      // stacks shown before "Show N more"
export const STACK_PEEK = 2;            // cards drawn behind a collapsed stack

/**
 * @param {object[]} items
 * @returns {{key: string, appName: string, items: object[], newest: number}[]} newest group first;
 *   inside a group, newest item first
 */
export function groupByApp(items) {
    const groups = new Map();
    for (const item of items) {
        const key = item.appId || item.appName || '';
        let group = groups.get(key);
        if (!group) {
            group = { key, appName: item.appName || item.appId || '', items: [], newest: -Infinity };
            groups.set(key, group);
        }
        group.items.push(item);
        group.newest = Math.max(group.newest, item.time);
    }
    const list = [...groups.values()];
    for (const group of list)
        group.items.sort((a, b) => b.time - a.time);
    return list.sort((a, b) => b.newest - a.newest || a.appName.localeCompare(b.appName));
}

/**
 * What a group shows.
 *
 * @param {{items: object[]}} group
 * @param {boolean} expanded
 * @returns {{shown: object[], peek: number, stacked: boolean, count: number}}
 */
export function stackView(group, expanded) {
    const count = group.items.length;
    if (expanded || count === 1)
        return { shown: group.items, peek: 0, stacked: false, count };
    return { shown: group.items.slice(0, 1), peek: Math.min(STACK_PEEK, count - 1), stacked: true, count };
}

/**
 * Which groups show.
 *
 * @param {object[]} groups
 * @param {boolean} showAll
 * @returns {{shown: object[], more: number}} `more` counts the hidden notifications
 */
export function visibleGroups(groups, showAll) {
    if (showAll || groups.length <= COLLAPSED_GROUPS)
        return { shown: groups, more: 0 };
    const hidden = groups.slice(COLLAPSED_GROUPS);
    return { shown: groups.slice(0, COLLAPSED_GROUPS), more: hidden.reduce((n, g) => n + g.items.length, 0) };
}

/** Expanded group keys that still exist (a cleared app forgets its state). */
export function pruneExpanded(expanded, groups) {
    const keys = new Set(groups.map(g => g.key));
    return new Set([...expanded].filter(k => keys.has(k)));
}

/**
 * The age of a notification, as macOS shows it: "now", minutes, hours, then days.
 *
 * @returns {{unit: 'now'|'min'|'hour'|'day', n: number}}
 */
export function age(now, then) {
    const minutes = Math.floor(Math.max(0, now - then) / 60_000);
    if (minutes < 1)
        return { unit: 'now', n: 0 };
    if (minutes < 60)
        return { unit: 'min', n: minutes };
    if (minutes < 24 * 60)
        return { unit: 'hour', n: Math.floor(minutes / 60) };
    return { unit: 'day', n: Math.floor(minutes / (24 * 60)) };
}

/**
 * The small month of the date widget.
 *
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} weekStart 0 = Sunday, 1 = Monday
 * @param {{year: number, month: number, day: number}} today
 * @returns {{weekdays: number[], weeks: {day: number, inMonth: boolean, today: boolean}[][]}}
 */
export function monthGrid(year, month, weekStart, today) {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() - weekStart + 7) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < Math.ceil((lead + days) / 7) * 7; i++) {
        const date = new Date(year, month, 1 - lead + i);
        cells.push({
            day: date.getDate(),
            inMonth: date.getMonth() === ((month % 12) + 12) % 12,
            today: date.getFullYear() === today.year && date.getMonth() === today.month &&
                date.getDate() === today.day,
        });
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7)
        weeks.push(cells.slice(i, i + 7));
    return { weekdays: [0, 1, 2, 3, 4, 5, 6].map(i => (i + weekStart) % 7), weeks };
}

/** Year and month `delta` months away. */
export function shiftMonth(year, month, delta) {
    const index = year * 12 + month + delta;
    return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

/**
 * Widgets in the column's slot, in order (L11's widget model provides them).
 *
 * @param {{id: string, order?: number}[]} widgets
 */
export function orderWidgets(widgets) {
    return [...widgets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}
