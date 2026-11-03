// SPDX-License-Identifier: GPL-3.0-or-later
// Lock screen like macOS (D-022): the pure part. Options, the clock text, the layout of the lock
// dialog's parts, the two-step power buttons, the notification and hint rules, and the contrast
// tokens the stylesheet uses. No gi:// imports: tests/lockScreenModel.test.js runs it under gjs.

export const CLOCK_CHOICES = ['lock-screen', 'never'];
export const WALLPAPER_CHOICES = ['sharp', 'blurred'];
export const NOTIFICATION_CHOICES = ['count', 'never'];
export const MESSAGE_MAX = 140;

/** Failed attempts before the password hint shows (macOS: three). */
export const HINT_AFTER_FAILURES = 3;
/** The second press of Restart / Shut Down must come within this many ms of the first. */
export const CONFIRM_MS = 4000;

const pick = (value, choices, fallback) => (choices.includes(value) ? value : fallback);

/**
 * The options as the adapter uses them, from a plain object of setting values. Unknown choices
 * fall back to the macOS default.
 *
 * @param {object} raw
 * @returns {{enabled: boolean, clock: string, wallpaper: string, showUser: boolean,
 *   message: string, powerButtons: boolean, nowPlaying: boolean, notifications: string,
 *   hint: boolean}} `message` is '' when the message is off
 */
export function normalizeOptions(raw = {}) {
    const text = String(raw.message ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return {
        enabled: raw.enabled !== false,
        clock: pick(raw.clock, CLOCK_CHOICES, 'lock-screen'),
        wallpaper: pick(raw.wallpaper, WALLPAPER_CHOICES, 'sharp'),
        showUser: raw.showUser !== false,
        message: raw.messageOn === true ? Array.from(text).slice(0, MESSAGE_MAX).join('') : '',
        powerButtons: raw.powerButtons === true,
        nowPlaying: raw.nowPlaying !== false,
        notifications: pick(raw.notifications, NOTIFICATION_CHOICES, 'count'),
        hint: raw.hint === true,
    };
}

// ---- clock ------------------------------------------------------------------------------------

/**
 * The big time as macOS draws it: no AM / PM (the date line above carries the day, the menu bar
 * the rest). Handles "10:30 AM", "10:30 p.m." and 24-hour text; anything else is left alone.
 *
 * @param {string} clock the Shell's wall clock text
 * @returns {string}
 */
export function bigTime(clock) {
    const text = String(clock ?? '').trim();
    const stripped = text.replace(/\s*[ap]\.?\s?m\.?$/i, '').replace(/^[ap]\.?\s?m\.?\s*/i, '').trim();
    return stripped || text;
}

// ---- layout -----------------------------------------------------------------------------------

/**
 * Where each part of the lock dialog goes on the primary monitor. All sizes are in logical px
 * (the layout manager passes natural sizes; `scale` converts the fixed gaps). Boxes are
 * { x, y, w, h } and never overlap: the clock sits in the upper third, the user and password
 * capsule at the bottom centre, the power row under them, the message above them and the
 * notifications between the clock and the message, shrunk (or dropped) to fit.
 *
 * @param {{width: number, height: number, scale?: number, rtl?: boolean,
 *   clock?: ?{w: number, h: number}, stack: {w: number, h: number},
 *   notes?: ?{w: number, h: number}, message?: ?{w: number, h: number},
 *   power?: ?{w: number, h: number}, switchUser?: ?{w: number, h: number}}} input
 * @returns {{clock: ?object, stack: object, notes: ?object, message: ?object,
 *   power: ?object, switchUser: ?object}}
 */
export function layout(input) {
    const { width, height, rtl = false } = input;
    const s = input.scale || 1;
    const centre = w => Math.round((width - w) / 2);
    const out = { clock: null, stack: null, notes: null, message: null, power: null, switchUser: null };

    let floor;
    if (input.power) {
        const w = Math.min(input.power.w, width);
        const bottom = height - Math.max(Math.round(height * 0.05), 24 * s);
        out.power = { x: centre(w), y: bottom - input.power.h, w, h: input.power.h };
        floor = out.power.y - 20 * s;
    } else {
        floor = height - Math.max(Math.round(height * 0.08), 40 * s);
    }

    const stackW = Math.min(input.stack.w, width);
    out.stack = { x: centre(stackW), y: Math.max(0, floor - input.stack.h), w: stackW, h: input.stack.h };
    let ceiling = out.stack.y - 16 * s;

    if (input.message) {
        const w = Math.min(input.message.w, Math.round(width * 0.8));
        const h = input.message.h;
        out.message = { x: centre(w), y: Math.max(0, ceiling - h), w, h };
        ceiling = out.message.y - 16 * s;
    }

    let top = Math.max(Math.round(height * 0.1), 48 * s);
    if (input.clock) {
        // on a short screen the clock rises (never below 8 px from the top) rather than meet the message
        top = Math.max(Math.min(top, ceiling - input.clock.h - 16 * s), 8 * s);
        out.clock = { x: centre(input.clock.w), y: Math.round(top), w: input.clock.w, h: input.clock.h };
        top += input.clock.h + 32 * s;
    }

    if (input.notes) {
        const w = Math.min(input.notes.w, Math.round(width * 0.9), Math.round(440 * s));
        const h = Math.min(input.notes.h, ceiling - top);
        if (h >= 56 * s)
            out.notes = { x: centre(w), y: top, w, h: Math.round(h) };
    }

    if (input.switchUser) {
        const { w, h } = input.switchUser;
        out.switchUser = { x: rtl ? w : width - w * 2, y: height - h * 2, w, h };
    }
    return out;
}

// ---- power buttons ----------------------------------------------------------------------------

/**
 * The buttons macOS shows under the password capsule, in its order. Restart and Shut Down ask
 * for a second press (macOS asks in a dialog; on a lock screen two presses are the same
 * protection without a second surface to secure).
 *
 * @param {{suspend?: boolean, restart?: boolean, poweroff?: boolean}} can what logind allows
 * @returns {Array<{id: string, confirm: boolean}>}
 */
export function powerActions(can = {}) {
    return [
        { id: 'suspend', confirm: false, allowed: can.suspend },
        { id: 'restart', confirm: true, allowed: can.restart },
        { id: 'poweroff', confirm: true, allowed: can.poweroff },
    ].filter(a => a.allowed).map(({ id, confirm }) => ({ id, confirm }));
}

/**
 * One press of a power button.
 *
 * @param {?{id: string, until: number}} armed the button waiting for its second press
 * @param {{id: string, confirm: boolean}} action the pressed button
 * @param {number} now ms
 * @returns {{armed: ?{id: string, until: number}, run: ?string}} `run`: do it now
 */
export function pressPower(armed, action, now) {
    if (!action.confirm)
        return { armed: null, run: action.id };
    if (armed && armed.id === action.id && now <= armed.until)
        return { armed: null, run: action.id };
    return { armed: { id: action.id, until: now + CONFIRM_MS }, run: null };
}

// ---- notifications and hint -------------------------------------------------------------------

/**
 * What the lock screen's notification list may show. Names and counts only (never a title or
 * body: the Shell would show those for system sources and apps that opted in); `never` hides the
 * list. Media controls are separate (nowPlaying).
 *
 * @param {string} mode 'count' | 'never'
 * @returns {{sources: boolean, details: boolean}}
 */
export function notificationRule(mode) {
    return { sources: mode !== 'never', details: false };
}

/**
 * The password hint line, or '' while it should stay hidden.
 *
 * @param {boolean} enabled the option
 * @param {?string} hint the account's hint
 * @param {number} failures failed attempts since the screen locked
 * @returns {string}
 */
export function hintLine(enabled, hint, failures) {
    const text = String(hint ?? '').replace(/\s+/g, ' ').trim();
    return enabled && text && failures >= HINT_AFTER_FAILURES ? text : '';
}

// ---- contrast ---------------------------------------------------------------------------------

/** Colours the stylesheet uses (style.css repeats these as rgba(); a test checks that). */
export const TOKENS = {
    text: [255, 255, 255],
    scrim: { rgb: [0, 0, 0], alpha: 0.45 },        // over a sharp wallpaper
    capsule: { rgb: [20, 20, 24], alpha: 0.72 },   // the glass fill behind small text
    scrimBlurred: { rgb: [0, 0, 0], alpha: 0.18 }, // on top of the Shell's own blur
    blurBrightness: 0.65,                          // unlockDialog.js BLUR_BRIGHTNESS
};

const lin = c => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** @param {number[]} rgb @returns {number} WCAG relative luminance */
export function luminance([r, g, b]) {
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** @returns {number} WCAG contrast ratio of two colours */
export function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** Colour of `layer` laid over an opaque backdrop. */
export function over(layer, backdrop) {
    return backdrop.map((c, i) => layer.rgb[i] * layer.alpha + c * (1 - layer.alpha));
}

/**
 * Contrast of white text over the worst wallpaper (pure white) through the given layers, the
 * first being the lowest.
 *
 * @param {Array<{rgb: number[], alpha: number}>} layers
 * @returns {number}
 */
export function worstCaseContrast(layers, text = TOKENS.text, backdrop = [255, 255, 255]) {
    return contrast(text, layers.reduce((acc, layer) => over(layer, acc), backdrop));
}
