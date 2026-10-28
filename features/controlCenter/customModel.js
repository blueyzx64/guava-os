// SPDX-License-Identifier: GPL-3.0-or-later
// The customisable Control Center (macOS Tahoe "Edit Controls"). Pure: no
// gi imports, so it runs under `gjs -m`.
//
// - CONTROLS: the gallery, every control the Control Center can show: GNOME's own Quick
//   Settings items (by the model key of model.js), Guava feature switches, GNOME setting
//   switches (accessibility, text size) and Guava actions (screenshot, timer, ...).
// - A layout is the user's list of controls in order, each with a size, persisted as the
//   `control-center-layout` strv ("wifi:medium"). An empty list means "Guava's default
//   arrangement" (model.js planLayout); the first edit writes that arrangement down.
// - planCustom() turns a layout into the grid plan the adapter applies (order, spans,
//   icon-only squares, which stock items to hide).

import { COLUMNS, GUAVA_TOGGLES, MORE_HEADER_ID, place } from './model.js';

const N_ = s => s;

/** Size -> columns of the 4-column grid (macOS: 1x1, 2x1 and full-width modules). */
export const SPANS = Object.freeze({ small: 1, medium: 2, large: COLUMNS });
export const SIZES = Object.freeze(Object.keys(SPANS));

/** Gallery sections, in display order. */
export const GROUPS = Object.freeze([
    { id: 'connectivity', title: N_('Connectivity') },
    { id: 'display-sound', title: N_('Display and Sound') },
    { id: 'system', title: N_('System') },
    { id: 'accessibility', title: N_('Accessibility') },
    { id: 'actions', title: N_('Actions') },
    { id: 'guava', title: N_('Guava') },
]);

const TOGGLE = ['small', 'medium'];
const MENU_TOGGLE = ['medium', 'large'];
const MODULE = ['large'];

// kind:
//   stock    a GNOME Quick Settings item, found by its model key (model.js STOCK)
//   module   a module Guava already adds in the default layout (Now Playing, Guava row)
//   feature  a Guava feature on/off switch bound to its settings key
//   setting  a switch over a GNOME setting: {schema, key, type: 'b'|'d', invert?, on?, off?}
//   action   a Guava control with its own behaviour (the adapter builds it by id)
const STOCK_CONTROLS = [
    ['wifi', 'connectivity', N_('Wi-Fi'), 'network-wireless-symbolic', MENU_TOGGLE],
    ['wired', 'connectivity', N_('Wired'), 'network-wired-symbolic', MENU_TOGGLE],
    ['bluetooth', 'connectivity', N_('Bluetooth'), 'bluetooth-active-symbolic', MENU_TOGGLE],
    ['vpn', 'connectivity', N_('VPN'), 'network-vpn-symbolic', MENU_TOGGLE],
    ['modem', 'connectivity', N_('Mobile Broadband'), 'network-cellular-symbolic', MENU_TOGGLE],
    ['bt-tether', 'connectivity', N_('Bluetooth Tethering'), 'bluetooth-active-symbolic', MENU_TOGGLE],
    ['airplane', 'connectivity', N_('Airplane Mode'), 'airplane-mode-symbolic', TOGGLE],
    ['dnd', 'system', N_('Focus'), 'notifications-disabled-symbolic', TOGGLE],
    ['brightness', 'display-sound', N_('Display'), 'display-brightness-symbolic', MODULE],
    ['volume-out', 'display-sound', N_('Sound'), 'audio-volume-high-symbolic', MODULE],
    ['volume-in', 'display-sound', N_('Microphone'), 'audio-input-microphone-symbolic', MODULE],
    ['dark-style', 'display-sound', N_('Dark Mode'), 'dark-mode-symbolic', TOGGLE],
    ['night-light', 'display-sound', N_('Night Shift'), 'night-light-symbolic', TOGGLE],
    ['backlight', 'display-sound', N_('Keyboard Brightness'), 'keyboard-brightness-symbolic', MENU_TOGGLE],
    ['rotation', 'display-sound', N_('Auto Rotate'), 'rotation-allowed-symbolic', TOGGLE],
    ['power-saver', 'system', N_('Power Mode'), 'power-profile-balanced-symbolic', MENU_TOGGLE],
    ['location', 'system', N_('Location'), 'location-services-active-symbolic', TOGGLE],
    ['camera', 'system', N_('Camera'), 'camera-web-symbolic', TOGGLE],
    ['remote-access', 'system', N_('Screen Sharing'), 'screen-shared-symbolic', TOGGLE],
    ['thunderbolt', 'system', N_('Thunderbolt'), 'thunderbolt-symbolic', TOGGLE],
    ['unsafe', 'system', N_('Unsafe Mode'), 'channel-insecure-symbolic', TOGGLE],
    ['background-apps', 'system', N_('Background Apps'), 'application-x-executable-symbolic', MODULE],
];

const SETTING_CONTROLS = [
    ['text-size', N_('Text Size'), 'zoom-in-symbolic',
        { schema: 'org.gnome.desktop.interface', key: 'text-scaling-factor', type: 'd', on: 1.25, off: 1.0 }],
    ['high-contrast', N_('Increase Contrast'), 'view-reveal-symbolic',
        { schema: 'org.gnome.desktop.a11y.interface', key: 'high-contrast', type: 'b' }],
    ['reduce-motion', N_('Reduce Motion'), 'emblem-synchronizing-symbolic',
        { schema: 'org.gnome.desktop.interface', key: 'enable-animations', type: 'b', invert: true }],
    ['screen-reader', N_('VoiceOver'), 'audio-speakers-symbolic',
        { schema: 'org.gnome.desktop.a11y.applications', key: 'screen-reader-enabled', type: 'b' }],
    ['screen-keyboard', N_('Accessibility Keyboard'), 'input-keyboard-symbolic',
        { schema: 'org.gnome.desktop.a11y.applications', key: 'screen-keyboard-enabled', type: 'b' }],
    ['sticky-keys', N_('Sticky Keys'), 'preferences-desktop-keyboard-symbolic',
        { schema: 'org.gnome.desktop.a11y.keyboard', key: 'stickykeys-enable', type: 'b' }],
    ['visual-alerts', N_('Flash Screen for Alerts'), 'dialog-warning-symbolic',
        { schema: 'org.gnome.desktop.wm.preferences', key: 'visual-bell', type: 'b' }],
];

const ACTION_CONTROLS = [
    ['screenshot', 'actions', N_('Screenshot'), 'camera-photo-symbolic', TOGGLE],
    ['screen-recording', 'actions', N_('Screen Recording'), 'media-record-symbolic', TOGGLE],
    ['timer', 'actions', N_('Timer'), 'alarm-symbolic', MENU_TOGGLE],
    ['keep-awake', 'system', N_('Keep Awake'), 'weather-clear-night-symbolic', TOGGLE],
    ['low-power', 'system', N_('Low Power Mode'), 'battery-level-50-symbolic', TOGGLE],
];

const def = (id, kind, group, title, icon, sizes, extra = {}) =>
    Object.freeze({ id, kind, group, title, icon, sizes, defaultSize: sizes[0], ...extra });

/** Every control of the gallery. */
export const CONTROLS = Object.freeze([
    ...STOCK_CONTROLS.map(([id, group, title, icon, sizes]) => def(id, 'stock', group, title, icon, sizes)),
    def('now-playing', 'module', 'display-sound', N_('Now Playing'), 'audio-x-generic-symbolic', MODULE),
    def('guava-toggles', 'module', 'guava', N_('Guava Features'), 'emblem-system-symbolic', MODULE),
    ...GUAVA_TOGGLES.map(t => def(`feature:${t.key}`, 'feature', 'guava', t.label, t.icon, TOGGLE, { key: t.key })),
    ...SETTING_CONTROLS.map(([id, title, icon, binding]) =>
        def(id, 'setting', 'accessibility', title, icon, TOGGLE, { binding: Object.freeze(binding) })),
    ...ACTION_CONTROLS.map(([id, group, title, icon, sizes]) => def(id, 'action', group, title, icon, sizes)),
]);

const BY_ID = new Map(CONTROLS.map(c => [c.id, c]));

/** @returns {?object} the control with this id */
export function control(id) {
    return BY_ID.get(id) ?? null;
}

/** Ids Guava builds actors for (not GNOME's, not the default modules). */
export function isOwnControl(id) {
    const kind = BY_ID.get(id)?.kind;
    return kind === 'feature' || kind === 'setting' || kind === 'action';
}

/** The size a control can really take: the asked one when allowed, else its default. */
export function fitSize(id, size) {
    const c = BY_ID.get(id);
    if (!c)
        return null;
    return c.sizes.includes(size) ? size : c.defaultSize;
}

/**
 * The saved layout, cleaned: unknown ids and duplicates dropped, sizes fitted.
 *
 * @param {string[]} strv entries "id:size"
 * @returns {{id: string, size: string}[]}
 */
export function parseLayout(strv) {
    const seen = new Set();
    const out = [];
    for (const entry of strv ?? []) {
        const cut = String(entry).lastIndexOf(':');
        // feature ids contain a colon themselves: the size is always after the last one
        const [id, size] = cut > 0 && SIZES.includes(entry.slice(cut + 1))
            ? [entry.slice(0, cut), entry.slice(cut + 1)]
            : [String(entry), null];
        if (!BY_ID.has(id) || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, size: fitSize(id, size) });
    }
    return out;
}

/** @returns {string[]} */
export function serializeLayout(layout) {
    return layout.map(({ id, size }) => `${id}:${size}`);
}

/** Add a control (at `index`, default the end). Already there: unchanged. */
export function addControl(layout, id, index = layout.length) {
    if (!BY_ID.has(id) || layout.some(e => e.id === id))
        return layout;
    const out = [...layout];
    out.splice(Math.max(0, Math.min(index, out.length)), 0, { id, size: BY_ID.get(id).defaultSize });
    return out;
}

export function removeControl(layout, id) {
    return layout.filter(e => e.id !== id);
}

/** Move a control by `delta` places (clamped). */
export function moveControl(layout, id, delta) {
    const from = layout.findIndex(e => e.id === id);
    if (from < 0)
        return layout;
    const to = Math.max(0, Math.min(layout.length - 1, from + delta));
    if (to === from)
        return layout;
    const out = [...layout];
    const [entry] = out.splice(from, 1);
    out.splice(to, 0, entry);
    return out;
}

/** Move a control to `index` (drag and drop). */
export function moveControlTo(layout, id, index) {
    const from = layout.findIndex(e => e.id === id);
    return from < 0 ? layout : moveControl(layout, id, index - from);
}

export function setSize(layout, id, size) {
    return layout.map(e => e.id === id ? { id, size: fitSize(id, size) } : e);
}

/** The next allowed size of a control (small -> medium -> large -> small). */
export function nextSize(id, size) {
    const sizes = BY_ID.get(id)?.sizes ?? [];
    if (sizes.length < 2)
        return size;
    return sizes[(sizes.indexOf(size) + 1) % sizes.length];
}

/** Grid span of a size -> its name, for writing down the default arrangement. */
function sizeOfSpan(id, span) {
    const size = span >= COLUMNS ? 'large' : span >= 2 ? 'medium' : 'small';
    return fitSize(id, size);
}

/**
 * The default arrangement (model.js planLayout) as a layout, the starting point of the first
 * edit. Hidden stock items (no Bluetooth adapter today) keep their place, so they come back.
 *
 * @param {{id: string, span: number}[]} plan planLayout() output
 * @param {Map<string, ?string>} keyOf plan id -> model key
 * @returns {{id: string, size: string}[]}
 */
export function layoutFromPlan(plan, keyOf) {
    const out = [];
    for (const p of plan) {
        const key = keyOf.get(p.id);
        if (key && BY_ID.has(key) && !out.some(e => e.id === key))
            out.push({ id: key, size: sizeOfSpan(key, p.span) });
    }
    return out;
}

/** Fixed footer items: never edited, always last (model keys of model.js). */
const FOOTER = ['notifications', 'system', 'edit-controls'];

/**
 * The grid plan for a custom layout.
 *
 * - Controls in the layout come first, in its order, at their size. A small toggle the shell
 *   cannot make icon-only (it has a menu arrow) stays a labelled half tile.
 * - Editable controls the user removed are hidden (`hide`).
 * - Items Guava does not know (other extensions' toggles) are never dropped: they follow under
 *   the "More" header with their stock size, then the notifications and the footer.
 *
 * @param {{id: string, key: ?string, stockSpan?: number, visible: boolean,
 *   compactable?: boolean}[]} entries the grid's items, as for planLayout()
 * @param {{id: string, size: string}[]} layout
 * @returns {{id: string, span: number, visible: boolean, compact: boolean, hide: boolean,
 *   joinPrev: boolean, joinNext: boolean}[]}
 */
export function planCustom(entries, layout) {
    const out = [];
    const used = new Set();
    const push = (entry, fields) => {
        used.add(entry);
        out.push({
            id: entry.id, visible: entry.visible, compact: false, hide: false,
            joinPrev: false, joinNext: false, ...fields,
        });
    };
    for (const { id, size } of layout) {
        for (const entry of entries.filter(e => e.key === id)) {
            const small = size === 'small' && !!entry.compactable;
            push(entry, { span: small ? 1 : Math.max(2, SPANS[size] ?? 2), compact: small });
        }
    }
    for (const entry of entries) {
        if (!used.has(entry) && entry.key && BY_ID.has(entry.key))
            push(entry, { span: 2, hide: true, visible: false });
    }
    const extras = entries.filter(e => !used.has(e) && !FOOTER.includes(e.key));
    out.push({
        id: MORE_HEADER_ID, span: COLUMNS, visible: extras.some(e => e.visible),
        compact: false, hide: false, joinPrev: false, joinNext: false,
    });
    for (const entry of extras)
        push(entry, { span: place(entry).span });
    for (const key of FOOTER) {
        for (const entry of entries.filter(e => e.key === key && !used.has(e)))
            push(entry, { span: COLUMNS });
    }
    return out;
}

/**
 * Where each control sits in the editor's preview grid: a flow layout of COLUMNS columns, as
 * the Quick Settings grid lays it out (an item that does not fit starts a new row).
 *
 * @param {{id: string, size: string}[]} layout
 * @returns {{id: string, column: number, row: number, span: number}[]}
 */
export function packRows(layout, columns = COLUMNS) {
    let column = 0;
    let row = 0;
    return layout.map(({ id, size }) => {
        const span = Math.min(columns, SPANS[size] ?? 1);
        if (column + span > columns) {
            column = 0;
            row++;
        }
        const cell = { id, column, row, span };
        column += span;
        if (column >= columns) {
            column = 0;
            row++;
        }
        return cell;
    });
}

/**
 * The gallery, grouped, filtered by a search text.
 *
 * @param {{id: string}[]} layout
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {(c: object) => string} [opts.titleOf] translated title (default: the English one)
 * @param {(id: string) => boolean} [opts.available] false hides the control (e.g. no schema)
 * @returns {{group: string, title: string, controls: {id: string, title: string,
 *   icon: string, added: boolean}[]}[]}
 */
export function gallery(layout, { query = '', titleOf = c => c.title, available = () => true } = {}) {
    const q = query.trim().toLowerCase();
    const added = new Set(layout.map(e => e.id));
    return GROUPS.map(g => ({
        group: g.id,
        title: g.title,
        controls: CONTROLS
            .filter(c => c.group === g.id && available(c.id))
            .filter(c => !q || titleOf(c).toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
            .map(c => ({ id: c.id, title: titleOf(c), icon: c.icon, added: added.has(c.id) })),
    })).filter(g => g.controls.length);
}

/**
 * The value a setting control writes, and whether a read value counts as on.
 *
 * @param {{type: string, invert?: boolean, on?: number, off?: number}} binding
 */
export function settingIsOn(binding, value) {
    if (binding.type === 'b')
        return binding.invert ? !value : !!value;
    return Math.abs(value - binding.on) < Math.abs(value - binding.off);
}

export function settingValue(binding, on) {
    if (binding.type === 'b')
        return binding.invert ? !on : !!on;
    return on ? binding.on : binding.off;
}

// ---- timer --------------------------------------------------------------------------

/** Timer lengths offered in its menu, in minutes. */
export const TIMER_MINUTES = Object.freeze([1, 3, 5, 10, 15, 30, 60]);

/** "4:05" / "1:02:03" for a number of seconds left. */
export function formatCountdown(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// ---- pinning from the editor ------------------------------------------------------------

/** Control -> its menu bar item (lib/menuBarPins.js PINNABLE), for the editor's pin button. */
const PIN_OF = Object.freeze({
    'wifi': 'wifi',
    'bluetooth': 'bluetooth',
    'volume-out': 'sound',
    'dnd': 'focus',
    'now-playing': 'now-playing',
    'backlight': 'keyboard-brightness',
    'screen-recording': 'screen-recording',
});

/** @returns {?string} the pin id of a control, or null when it cannot be pinned */
export function pinOf(id) {
    return PIN_OF[id] ?? null;
}
