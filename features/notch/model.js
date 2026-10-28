// SPDX-License-Identifier: GPL-3.0-or-later
// Notch v3, the pure part: which live activity the pill shows, one-time code detection, the
// file shelf, and the small derivations the activity sources need (battery, headphones,
// downloads, the next calendar event, countdowns). No gi:// imports; tested by
// tests/notchModel.test.js. The notification queue and the shape stay in stateMachine.js.

// ---- live activities --------------------------------------------------------------------
//
// The pill shows one activity. Priority rules, highest first:
//   1. Alerts: something that just happened and needs a glance. They show for a short time
//      (ttlMs) and then step back. A finished timer, a one-time code, low battery, a charger
//      plugged in, headphones connected.
//   2. Ongoing activities that the user started or must be aware of: a screen recording
//      (privacy first), a running timer, the playing song, a download, an event about to start.
//   3. Quiet background state, never in the pill, only listed in the expanded Now tab:
//      charging in progress, a paused song, headphones already connected.
// Within the same priority the newest wins. Every kind is in KINDS; a source only says which
// kind it is and when it started, never a number.

export const KINDS = Object.freeze({
    'timer-done': { priority: 120, ttlMs: 10000, pill: true },
    'code': { priority: 110, ttlMs: 30000, pill: true },
    'low-battery': { priority: 105, ttlMs: 8000, pill: true },
    'charging-started': { priority: 100, ttlMs: 4000, pill: true },
    'headphones-connected': { priority: 100, ttlMs: 4000, pill: true },
    'recording': { priority: 90, ttlMs: null, pill: true },
    'timer': { priority: 80, ttlMs: null, pill: true },
    'media': { priority: 70, ttlMs: null, pill: true },
    'download': { priority: 60, ttlMs: null, pill: true },
    'event-soon': { priority: 50, ttlMs: null, pill: true },
    'media-paused': { priority: 40, ttlMs: null, pill: true },
    'event': { priority: 15, ttlMs: null, pill: false },
    'charging': { priority: 20, ttlMs: null, pill: false },
    'headphones': { priority: 10, ttlMs: null, pill: false },
});

/** Pill widths per kind (logical px); a code needs room for its Copy button. */
export const PILL_WIDTH = Object.freeze({ default: 250, code: 300, recording: 270, download: 270 });

export function pillWidth(kind) {
    return PILL_WIDTH[kind] ?? PILL_WIDTH.default;
}

/**
 * @param {string} kind a KINDS key
 * @param {number} at when it started (ms)
 * @returns {{priority: number, until: number|null, pill: boolean}}
 */
export function activityTiming(kind, at) {
    const k = KINDS[kind];
    if (!k)
        throw new Error(`notch: unknown activity kind '${kind}'`);
    return { priority: k.priority, until: k.ttlMs === null ? null : at + k.ttlMs, pill: k.pill };
}

const live = (a, now) => a.until === null || a.until === undefined || a.until > now;

/**
 * Activities still alive at `now`, best first (priority, then newest).
 * @param {Array<{key, kind, priority, at, until, pill}>} list
 */
export function rankActivities(list, now) {
    return list
        .filter(a => live(a, now))
        .sort((a, b) => b.priority - a.priority || b.at - a.at);
}

/** The activity the pill shows, or null. */
export function pillActivity(list, now) {
    return rankActivities(list, now).find(a => a.pill) ?? null;
}

/** The soonest time an alert steps back, or null. */
export function nextActivityExpiry(list, now) {
    let t = null;
    for (const a of list) {
        if (a.until !== null && a.until !== undefined && a.until > now && (t === null || a.until < t))
            t = a.until;
    }
    return t;
}

// ---- one-time codes ---------------------------------------------------------------------
//
// Local and conservative: a code is offered only when the text names it (code, OTP, PIN,
// passcode, verification, ...) and a single 4-8 digit group (digits may be split by one space
// or dash, "482 913") stands near that word. Amounts, times, dates, phone numbers and long
// numbers are skipped. Returns the digits, or null.

const CODE_WORDS = /(code|otp|pin\b|passcode|password|verif|one[- ]time|2fa|two[- ]factor|security|login|sign[- ]in|authenticat|código|codigo|codice|kod\b|kodu|bestätigung|bestatigung|コード|验证码|驗證碼|인증)/i;
const CANDIDATE = /(^|[^\w$€£¥.,:/+-])((?:[A-Z]-)?(\d{3,4}[ -]\d{3,4}|\d{4,8}))(?![\w%€$]|[.,:/]\d)/g;
const MAX_GAP = 60; // characters between the keyword and the code

export function detectCode(text) {
    if (typeof text !== 'string' || !text)
        return null;
    const plain = text.replace(/<[^>]*>/g, ' ');
    const words = [...plain.matchAll(new RegExp(CODE_WORDS.source, 'gi'))].map(m => m.index);
    if (!words.length)
        return null;
    const found = [];
    for (const m of plain.matchAll(CANDIDATE)) {
        const start = m.index + m[1].length;
        const raw = m[2];
        const digits = raw.replace(/^[A-Z]-/, '').replace(/[ -]/g, '');
        if (digits.length < 4 || digits.length > 8)
            continue;
        if (/^(19|20)\d\d$/.test(digits) && !/[ -]/.test(raw))
            continue; // a year
        const near = words.some(w => Math.abs(w - start) <= MAX_GAP);
        if (near)
            found.push(digits);
    }
    const unique = [...new Set(found)];
    return unique.length === 1 ? unique[0] : null;
}

// ---- the file shelf ---------------------------------------------------------------------
//
// A list of file links, newest first; the files stay where they are. Added by the clipboard
// ("Add from Clipboard" with files copied in Files), by finished downloads and by screenshots.

export const SHELF_LIMIT = 24;

/** @returns {string[]} the shelf with `uris` added at the front (deduplicated, capped) */
export function addToShelf(shelf, uris, limit = SHELF_LIMIT) {
    const fresh = uris.filter(u => typeof u === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(u));
    const seen = new Set();
    const out = [];
    for (const u of [...fresh, ...shelf]) {
        if (seen.has(u))
            continue;
        seen.add(u);
        out.push(u);
    }
    return out.slice(0, limit);
}

export function removeFromShelf(shelf, uri) {
    return shelf.filter(u => u !== uri);
}

/** text/uri-list (RFC 2483): one URI per line, # comments, CRLF or LF */
export function parseUriList(text) {
    return String(text ?? '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && /^[a-z][a-z0-9+.-]*:\/\//i.test(l));
}

/** x-special/gnome-copied-files: "copy" or "cut", then one URI per line */
export function parseGnomeCopiedFiles(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    if (lines[0] !== 'copy' && lines[0] !== 'cut')
        return [];
    return parseUriList(lines.slice(1).join('\n'));
}

/** A plain-text clipboard holding one absolute path or file:// link per line */
export function parsePlainFiles(text) {
    const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length || lines.length > SHELF_LIMIT)
        return [];
    const uris = [];
    for (const l of lines) {
        if (/^file:\/\//.test(l))
            uris.push(l);
        else if (l.startsWith('/') && !/[\0]/.test(l))
            uris.push(`file://${l.split('/').map(encodeURIComponent).join('/')}`);
        else
            return [];
    }
    return uris;
}

/** The order to try clipboard mimetypes in, and how to read each */
export const CLIPBOARD_FILE_TYPES = Object.freeze([
    ['x-special/gnome-copied-files', parseGnomeCopiedFiles],
    ['text/uri-list', parseUriList],
    ['text/plain;charset=utf-8', parsePlainFiles],
    ['text/plain', parsePlainFiles],
]);

/** The order to read a drag's mimetypes in (Meta.SelectionType.SELECTION_DND) */
export const DROP_FILE_TYPES = Object.freeze([
    ['text/uri-list', parseUriList],
    ['x-special/gnome-copied-files', parseGnomeCopiedFiles],
    ['text/plain;charset=utf-8', parsePlainFiles],
]);

/** Is (x, y) inside `zone` ({x, y, w, h}, or null for none)? */
export function inDropZone(zone, x, y) {
    return !!zone && x >= zone.x && y >= zone.y && x < zone.x + zone.w && y < zone.y + zone.h;
}

/**
 * Where a drag counts as "on the notch": the island plus a margin, and never smaller than a
 * generous band at the top centre while the notch is small (a 190x32 pill is a hard target).
 * @param {{x, y, w, h}} island stage coordinates
 * @param {{x, y, width}} monitor
 */
export function dropZone(island, monitor, { margin = 16, minW = 420, minH = 72 } = {}) {
    const w = Math.max(island.w + 2 * margin, minW);
    const h = Math.max(island.h + margin, minH);
    const cx = island.x + island.w / 2;
    return { x: Math.round(cx - w / 2), y: monitor.y, w: Math.round(w), h: Math.round(h) };
}

/** The file name of a link, decoded ("My%20File.pdf" -> "My File.pdf") */
export function displayName(uri) {
    const path = String(uri ?? '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const base = path.slice(path.lastIndexOf('/') + 1);
    try {
        return decodeURIComponent(base);
    } catch (_e) {
        return base;
    }
}

// ---- derivations for the activity sources -----------------------------------------------

// UPower Device.State
export const UPOWER = Object.freeze({ CHARGING: 1, DISCHARGING: 2, EMPTY: 3, FULL: 4, PENDING_CHARGE: 5, PENDING_DISCHARGE: 6 });
export const LOW_BATTERY = 20;
export const CRITICAL_BATTERY = 10;

/**
 * What the battery means for the notch.
 * @param {{present: boolean, state: number, percentage: number}} now
 * @param {{state: number, percentage: number}|null} before the previous reading (null at start)
 * @returns {{charging: boolean, pluggedIn: boolean, low: boolean, percent: number}|null}
 *   pluggedIn: a charger was just connected; low: the level just crossed 20 % or 10 % going down
 */
export function batteryChange(now, before) {
    if (!now?.present)
        return null;
    const percent = Math.round(now.percentage);
    const charging = now.state === UPOWER.CHARGING || now.state === UPOWER.FULL ||
        now.state === UPOWER.PENDING_CHARGE;
    const wasCharging = before ? [UPOWER.CHARGING, UPOWER.FULL, UPOWER.PENDING_CHARGE].includes(before.state) : charging;
    const crossed = threshold => before && before.percentage > threshold && now.percentage <= threshold;
    return {
        charging,
        pluggedIn: !!before && charging && !wasCharging,
        low: !charging && !!(crossed(LOW_BATTERY) || crossed(CRITICAL_BATTERY)),
        percent,
    };
}

const AUDIO_ICONS = /^audio-(headphones|headset|card|speakers)|^(headphones|headset)/;

/**
 * Connected Bluetooth audio devices from BlueZ ObjectManager data.
 * @param {Array<{path: string, name: string, icon: string, connected: boolean, battery: number|null}>} devices
 * @returns {Array} the connected audio ones, by path
 */
export function connectedHeadphones(devices) {
    return devices
        .filter(d => d.connected && AUDIO_ICONS.test(d.icon ?? ''))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Paths in `after` that were not in `before` */
export function newlyConnected(before, after) {
    const had = new Set(before.map(d => d.path));
    return after.filter(d => !had.has(d.path));
}

export const PARTIAL_FILE = /\.(part|crdownload|download|partial|opdownload)$/i;

/**
 * One download summary from app progress bars (LauncherEntry, 0..1) and partial files.
 * @param {Array<{appId: string, progress: number}>} apps
 * @param {Array<{name: string, bytes: number}>} partials
 * @returns {{label: string, fraction: number|null, bytes: number|null, count: number}|null}
 */
export function downloadSummary(apps, partials) {
    const bars = apps.filter(a => Number.isFinite(a.progress) && a.progress >= 0 && a.progress < 1);
    // A browser shows both a progress bar and a partial file for the same download
    const count = Math.max(bars.length, partials.length);
    if (!count)
        return null;
    if (bars.length) {
        const fraction = bars.reduce((s, a) => s + a.progress, 0) / bars.length;
        const name = partials.length === 1 ? partials[0].name.replace(PARTIAL_FILE, '') : null;
        return { label: name ?? bars[0].appId, fraction, bytes: null, count };
    }
    const bytes = partials.reduce((s, p) => s + (p.bytes || 0), 0);
    return { label: partials[0].name.replace(PARTIAL_FILE, ''), fraction: null, bytes, count };
}

/** "740 KB", "12.4 MB", "1.2 GB" */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const EVENT_SOON_MS = 15 * 60 * 1000;
export const EVENT_HORIZON_MS = 24 * 3600 * 1000;

/**
 * The next timed event: ongoing or starting within the horizon. All-day events are skipped.
 * @param {Array<{id: string, summary: string, start: number, end: number, allDay: boolean}>} events
 * @param {number} now ms
 * @returns {{event: object, soon: boolean, ongoing: boolean}|null}
 */
export function nextEvent(events, now, horizonMs = EVENT_HORIZON_MS) {
    let best = null;
    for (const e of events) {
        if (e.allDay || !Number.isFinite(e.start))
            continue;
        const end = Number.isFinite(e.end) && e.end > e.start ? e.end : e.start;
        if (end <= now || e.start - now > horizonMs)
            continue;
        if (!best || e.start < best.start)
            best = e;
    }
    if (!best)
        return null;
    const ongoing = best.start <= now;
    return { event: best, ongoing, soon: ongoing || best.start - now <= EVENT_SOON_MS };
}

/** Whole minutes until the event, at least 1, or 0 once it started */
export function minutesUntil(start, now) {
    return start <= now ? 0 : Math.max(1, Math.ceil((start - now) / 60000));
}

/** "4:05", "1:02:03" for a countdown (rounded up, so 0.2 s left still reads 0:01) */
export function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "0:42", "12:03" for elapsed time */
export function formatElapsed(ms) {
    return formatCountdown(Math.floor(Math.max(0, ms) / 1000) * 1000);
}

// ---- tabs -------------------------------------------------------------------------------

export const TABS = Object.freeze(['now', 'tray', 'widgets']);

/** +1 when `to` is right of `from`, -1 when left, 0 when the same (for the slide direction) */
export function tabDirection(from, to) {
    const a = TABS.indexOf(from);
    const b = TABS.indexOf(to);
    return a < 0 || b < 0 || a === b ? 0 : b > a ? 1 : -1;
}

/** How many rows the Now tab's right column lists: activities first, then notifications */
export function nowRows(activityCount, notificationCount, maxRows = 3) {
    const activities = Math.min(activityCount, maxRows);
    const room = maxRows - activities;
    const fitsAll = notificationCount <= room;
    // Without room for every notification, the last row becomes "N more"
    const notifications = fitsAll ? notificationCount : Math.max(0, room - 1);
    return { activities, notifications, more: notificationCount - notifications };
}
