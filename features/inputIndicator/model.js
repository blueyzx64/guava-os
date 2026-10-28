// SPDX-License-Identifier: GPL-3.0-or-later
// Text-cursor indicators (macOS Sonoma): what the badge says and where it goes. Pure.
//
//   Caps Lock on   an accent ⇪ right under the caret
//   Caps Lock off  a muted ⇪ (macOS gives no feedback; Guava confirms the key took)
//   Input source   the new source's short name ("EN", "DE", "あ") under the caret
//
// The caret comes from lib/caret.js (the IBus panel service); without one the badge goes next
// to the pointer.

export const BADGE_MS = 1500;      // how long the badge stays (macOS hides it after a pause)
export const CARET_GAP = 3;        // px between the caret's bottom and the badge
export const POINTER_OFFSET = Object.freeze({ x: 14, y: 20 });
export const SCREEN_MARGIN = 4;
export const CAPS_GLYPH = '⇪';

/** Settings in, plain config out. `get` is a GuavaSettings-like reader. */
export function readConfig(get) {
    return {
        enabled: get.bool('input-indicator'),
        capsLock: get.bool('input-indicator-caps-lock'),
        source: get.bool('input-indicator-source'),
    };
}

/**
 * The short label of an input source: its short name in capitals for Latin layouts, as is
 * for scripts without case; the display name's first letters when it has no short name.
 *
 * @param {{shortName?: string, displayName?: string}} source
 */
export function sourceLabel(source) {
    const raw = (source?.shortName || source?.displayName || '').trim();
    if (!raw)
        return '';
    return [...raw.toUpperCase()].slice(0, 3).join('');
}

/**
 * The badge for an event.
 *
 * @param {{type: 'caps', on: boolean}|{type: 'source', source: object}} event
 * @param {object} config readConfig()
 * @returns {?{text: string, style: 'caps-on'|'caps-off'|'source', key: string}} null when the
 *   event is off in the settings or has nothing to show
 */
export function badgeFor(event, config) {
    if (!config?.enabled)
        return null;
    if (event.type === 'caps') {
        if (!config.capsLock)
            return null;
        return { text: CAPS_GLYPH, style: event.on ? 'caps-on' : 'caps-off', key: event.on ? 'caps-on' : 'caps-off' };
    }
    if (event.type === 'source') {
        if (!config.source)
            return null;
        const text = sourceLabel(event.source);
        return text ? { text, style: 'source', key: `source:${text}` } : null;
    }
    return null;
}

/** Whether a current-source-changed is a real switch (not the first source at startup). */
export function isSourceSwitch(oldId, newId) {
    return !!oldId && !!newId && oldId !== newId;
}

/** Caps Lock edges from a keymap that also reports other modifier changes. */
export class CapsWatch {
    constructor(initial) {
        this._on = !!initial;
    }

    /** @returns {?boolean} the new state when it changed, else null */
    update(on) {
        const now = !!on;
        if (now === this._on)
            return null;
        this._on = now;
        return now;
    }
}

/**
 * Where the badge goes: under the caret (above it at the bottom of the screen), else below
 * and right of the pointer; always inside the monitor's area.
 *
 * @param {{caret: ?object, pointer: {x, y}, size: {width, height}, area: {x, y, width, height}}} p
 * @returns {{x: number, y: number, anchor: 'caret'|'pointer'}}
 */
export function placeBadge({ caret, pointer, size, area }) {
    const clampX = x => Math.round(Math.max(area.x + SCREEN_MARGIN,
        Math.min(x, area.x + area.width - size.width - SCREEN_MARGIN)));
    const clampY = y => Math.round(Math.max(area.y + SCREEN_MARGIN,
        Math.min(y, area.y + area.height - size.height - SCREEN_MARGIN)));
    if (caret) {
        let y = caret.y + caret.height + CARET_GAP;
        if (y + size.height > area.y + area.height - SCREEN_MARGIN)
            y = caret.y - CARET_GAP - size.height;
        return { x: clampX(caret.x), y: clampY(y), anchor: 'caret' };
    }
    return {
        x: clampX(pointer.x + POINTER_OFFSET.x),
        y: clampY(pointer.y + POINTER_OFFSET.y),
        anchor: 'pointer',
    };
}

/** True when the point lies inside the rect (which monitor a caret or pointer is on). */
export function contains(rect, x, y) {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}
