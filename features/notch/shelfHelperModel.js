// SPDX-License-Identifier: GPL-3.0-or-later
// The shelf drag-out helper (helpers/guava-shelf-helper): the pure parts of talking to it.
// No gi:// imports. Tested by tests/shelfHelperModel.test.js.

export const HELPER = Object.freeze({
    command: 'guava-shelf-helper',
    appId: 'org.guava.ShelfHelper',
    title: 'Guava Shelf',
});

/** True for the helper's own window (matched by class and title, never by title alone). */
export function isHelperWindow(wmClass, title) {
    return wmClass === HELPER.appId && title === HELPER.title;
}

const whole = n => Math.round(n);

/**
 * The layout message: the helper window's box and each item's box inside it.
 * @param {{x: number, y: number, w: number, h: number}} box where the window goes (stage px)
 * @param {Array<{uri: string, icon: string, x: number, y: number, w: number, h: number}>} tiles stage px
 * @returns {{box: object, line: string}} the window's frame and the JSON line to send
 */
export function layoutOf(box, tiles) {
    const frame = { x: whole(box.x), y: whole(box.y), w: Math.max(1, whole(box.w)), h: Math.max(1, whole(box.h)) };
    const items = tiles.map(t => ({
        uri: t.uri,
        icon: t.icon ?? '',
        x: whole(t.x - frame.x),
        y: whole(t.y - frame.y),
        w: Math.max(1, whole(t.w)),
        h: Math.max(1, whole(t.h)),
    }));
    return { box: frame, line: JSON.stringify({ type: 'layout', w: frame.w, h: frame.h, items }) };
}

/** The line that closes the window. */
export const CLEAR_LINE = JSON.stringify({ type: 'layout', w: 1, h: 1, items: [] });

/**
 * One line from the helper, or null when it is not a known event.
 * @returns {{event: 'click', uri: string}|{event: 'drag', state: 'begin'|'end', uri: string, ok: boolean}|
 *   {event: 'hover', value: boolean}|{event: 'ready'}|null}
 */
export function parseEvent(line) {
    let m;
    try {
        m = JSON.parse(line);
    } catch (_e) {
        return null;
    }
    if (!m || typeof m !== 'object')
        return null;
    switch (m.event) {
    case 'ready':
        return { event: 'ready' };
    case 'hover':
        return typeof m.value === 'boolean' ? { event: 'hover', value: m.value } : null;
    case 'click':
        return typeof m.uri === 'string' ? { event: 'click', uri: m.uri } : null;
    case 'drag':
        return (m.state === 'begin' || m.state === 'end') && typeof m.uri === 'string'
            ? { event: 'drag', state: m.state, uri: m.uri, ok: m.ok !== false } : null;
    default:
        return null;
    }
}

/**
 * Whether the pointer counts as being on the notch through the helper: over its window, or while
 * a drag from the shelf is running (the pointer is then far away and the dashboard must stay).
 */
export function pointerOnNotch({ helper, dragging }) {
    return !!(helper || dragging);
}

/** The icon name the helper puts on the drag (a themed icon's first name), or ''. */
export function dragIconName(gicon) {
    if (!gicon)
        return '';
    const names = typeof gicon.get_names === 'function' ? gicon.get_names() : null;
    return names?.length ? names[0] : '';
}
