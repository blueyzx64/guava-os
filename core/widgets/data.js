// SPDX-License-Identifier: GPL-3.0-or-later
// Pure data shaping for the built-in widgets: what each provider's raw input turns into.
// No gi:// imports; tested by tests/widgetsData.test.js.

// ---- clock -------------------------------------------------------------------------------

/** Hand angles in degrees (12 o'clock = 0, clockwise) for an analog face. */
export function handAngles(hours, minutes) {
    return {
        hour: ((hours % 12) + minutes / 60) * 30,
        minute: minutes * 6,
    };
}

/** Milliseconds until the next whole minute, so a clock ticks on the minute (at least 1 s). */
export function msToNextMinute(seconds, ms = 0) {
    return Math.max(1000, (60 - seconds) * 1000 - ms);
}

/**
 * The difference of a world clock to local time, as "+3h", "−1h 30m" or "Same time".
 *
 * @param {number} offsetSeconds the other zone's UTC offset minus the local one
 * @param {(s: string) => string} _ gettext
 */
export function offsetLabel(offsetSeconds, _ = s => s) {
    if (offsetSeconds === 0)
        return _('Same time');
    const sign = offsetSeconds > 0 ? '+' : '−';
    const total = Math.abs(Math.round(offsetSeconds / 60));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${sign}${h}h ${m}m` : `${sign}${h}h`;
}

/** The city a time-zone identifier names: "Europe/Riga" is "Riga", "America/New_York" "New York". */
export function cityFromTimezone(identifier) {
    const last = String(identifier ?? '').split('/').pop().replace(/_/g, ' ');
    return last && last !== 'UTC' ? last : '';
}

/**
 * The line under a world clock: the day and the hours it is ahead of or behind local time,
 * "Today, +3h", "Tomorrow, +13h", "Yesterday, −5h".
 *
 * @param {number} dayDelta calendar days the other zone is ahead (-1, 0 or 1)
 * @param {number} offsetSeconds the other zone's UTC offset minus the local one
 */
export function worldLabel(dayDelta, offsetSeconds, _ = s => s) {
    const day = dayDelta > 0 ? _('Tomorrow') : dayDelta < 0 ? _('Yesterday') : _('Today');
    return `${day}, ${offsetLabel(offsetSeconds, _)}`;
}

// ---- calendar ----------------------------------------------------------------------------

/**
 * The events still to come today and in the next days, soonest first, all-day events of a
 * day before its timed ones.
 *
 * @param {Array<{id: string, summary: string, date: Date, end: Date}>} events
 * @param {Date} now
 * @param {number} limit
 * @returns {Array<{id: string, summary: string, date: Date, end: Date, allDay: boolean, today: boolean}>}
 */
export function upcomingEvents(events, now, limit) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(dayStart.getTime() + 86400000);
    const out = [];
    for (const e of events ?? []) {
        if (!(e?.date instanceof Date) || !(e.end instanceof Date) || e.end <= now)
            continue;
        const len = e.end - e.date;
        const allDay = len >= 86400000 && e.date.getHours() === 0 && e.date.getMinutes() === 0;
        out.push({
            id: e.id, summary: e.summary || '', date: e.date, end: e.end, allDay,
            today: e.date < tomorrow,
        });
    }
    out.sort((a, b) => {
        const da = a.allDay && a.date < dayStart ? dayStart : a.date;
        const db = b.allDay && b.date < dayStart ? dayStart : b.date;
        const dayA = Math.floor((da - dayStart) / 86400000);
        const dayB = Math.floor((db - dayStart) / 86400000);
        if (dayA !== dayB)
            return dayA - dayB;
        if (a.allDay !== b.allDay)
            return a.allDay ? -1 : 1;
        return a.date - b.date;
    });
    return out.slice(0, limit);
}

/**
 * The days of a month grid (weeks of 7), starting on `weekStart` (0 = Sunday).
 *
 * @returns {Array<Array<{day: number, inMonth: boolean, today: boolean}>>}
 */
export function monthGrid(year, month, today, weekStart = 1) {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() - weekStart + 7) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const weeks = [];
    let week = [];
    for (let i = -lead; weeks.length < 6; i++) {
        const d = new Date(year, month, 1 + i);
        week.push({
            day: d.getDate(),
            inMonth: i >= 0 && i < days,
            today: d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() &&
                d.getDate() === today.getDate(),
        });
        if (week.length === 7) {
            weeks.push(week);
            week = [];
            if (i + 1 >= days)
                break;
        }
    }
    return weeks;
}

// ---- weather -----------------------------------------------------------------------------

/**
 * "H:21° L:12°" from the forecast's temperature texts ("21°C", "54 °F"), or '' with fewer than two
 * numbers to compare.
 *
 * @param {Array<{temp: string}>} forecasts
 */
export function highLow(forecasts) {
    const values = (forecasts ?? []).map(f => /-?\d+/.exec(f.temp ?? '')?.[0]).filter(Boolean).map(Number);
    if (values.length < 2)
        return '';
    return `H:${Math.max(...values)}° L:${Math.min(...values)}°`;
}

// ---- batteries ---------------------------------------------------------------------------

// UPower.DeviceKind and DeviceState values (org.freedesktop.UPower.Device Type / State)
const KIND_LINE_POWER = 1;
const KIND_BATTERY = 2;
const ICONS = {
    2: 'computer-symbolic', 3: 'uninterruptible-power-supply-symbolic', 5: 'input-mouse-symbolic',
    6: 'input-keyboard-symbolic', 8: 'phone-symbolic', 9: 'multimedia-player-symbolic',
    10: 'computer-apple-ipad-symbolic', 12: 'input-gaming-symbolic', 13: 'input-tablet-symbolic',
    14: 'input-touchpad-symbolic', 17: 'audio-headset-symbolic', 18: 'audio-speakers-symbolic',
    19: 'audio-headphones-symbolic', 26: 'watch-symbolic',
};
export const STATE_CHARGING = 1;
export const STATE_FULL = 4;

/**
 * The devices the Batteries widget lists: the laptop's own battery first, then every other
 * device with a charge (mice, keyboards, headsets, phones), by name. Line power, absent
 * batteries and devices without a percentage are left out.
 *
 * @param {Array<{path: string, type: number, percentage: number, state: number, model: string,
 *   powerSupply: boolean, isPresent: boolean}>} devices
 * @returns {Array<{path: string, name: string, percent: number, charging: boolean, icon: string, internal: boolean}>}
 */
export function batteryList(devices, _ = s => s) {
    const out = [];
    for (const d of devices ?? []) {
        if (!d || d.type === KIND_LINE_POWER || !Number.isFinite(d.percentage))
            continue;
        if (d.type === KIND_BATTERY && d.isPresent === false)
            continue;
        const internal = d.type === KIND_BATTERY && d.powerSupply !== false;
        out.push({
            path: d.path,
            name: internal ? _('This Computer') : d.model || _('Device'),
            percent: Math.round(Math.min(100, Math.max(0, d.percentage))),
            charging: d.state === STATE_CHARGING || d.state === STATE_FULL,
            icon: ICONS[d.type] ?? 'battery-symbolic',
            internal,
        });
    }
    out.sort((a, b) => (a.internal !== b.internal ? (a.internal ? -1 : 1) : a.name.localeCompare(b.name)));
    return out;
}

/** The fill level of a battery ring: a colour class by charge. */
export function batteryLevel(percent, charging) {
    if (charging)
        return 'charging';
    if (percent <= 10)
        return 'critical';
    if (percent <= 20)
        return 'low';
    return 'normal';
}

// ---- system ------------------------------------------------------------------------------

/** The cpu line of /proc/stat as {idle, total} jiffies, or null. */
export function parseCpu(stat) {
    const line = (stat ?? '').split('\n').find(l => l.startsWith('cpu '));
    if (!line)
        return null;
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    if (v.length < 4 || v.some(n => !Number.isFinite(n)))
        return null;
    const idle = v[3] + (v[4] ?? 0);
    const total = v.reduce((a, b) => a + b, 0);
    return { idle, total };
}

/** CPU use between two samples, 0..1. */
export function cpuUsage(prev, next) {
    if (!prev || !next || next.total <= prev.total)
        return 0;
    const busy = (next.total - prev.total) - (next.idle - prev.idle);
    return Math.min(1, Math.max(0, busy / (next.total - prev.total)));
}

/** Memory from /proc/meminfo: {used, total} in bytes, or null. */
export function parseMemory(meminfo) {
    const get = key => {
        const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo ?? '');
        return m ? Number(m[1]) * 1024 : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    if (!total || avail === null)
        return null;
    return { used: total - avail, total };
}

/** "3.2 GB" style size. */
export function formatBytes(bytes) {
    const gb = bytes / 1024 ** 3;
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

// ---- media -------------------------------------------------------------------------------

/**
 * What the Now Playing widget shows for a player (or null for none).
 *
 * @param {?{trackTitle: string, trackArtists: string[], trackCoverUrl: string, status: string,
 *   canGoNext: boolean, canGoPrevious: boolean, appName: string}} p
 */
export function mediaState(p) {
    if (!p)
        return { playing: false, title: '', artist: '', art: '', canNext: false, canPrev: false, app: '', has: false };
    return {
        has: true,
        playing: p.status === 'Playing',
        title: p.trackTitle || '',
        artist: (p.trackArtists ?? []).filter(Boolean).join(', '),
        art: p.trackCoverUrl || '',
        canNext: !!p.canGoNext,
        canPrev: !!p.canGoPrevious,
        app: p.appName || '',
    };
}
