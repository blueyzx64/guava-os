// SPDX-License-Identifier: GPL-3.0-or-later
// Appearance rules (pure; tests/appearanceModel.test.js): when Auto Light/Dark switches, the
// sunrise/sunset maths, the location fallback from the time zone, and the accent and highlight
// mappings. The adapter (scheme.js) feeds it the clock, the settings and the location.

/** GNOME color-scheme values Auto writes: macOS Light is GNOME's prefer-light (the Shell turns
 * light only then; 'default' keeps it dark), macOS Dark is prefer-dark. */
export const SCHEME = { light: 'prefer-light', dark: 'prefer-dark' };

/** How long the user must be idle before Auto switches (macOS waits for an idle moment). */
export const IDLE_BEFORE_SWITCH_MS = 60 * 1000;

/** Night Theme Switcher does the same job; Guava's Auto stays off while it runs. */
export const NIGHT_THEME_SWITCHER_UUID = 'nightthemeswitcher@romainvigier.fr';

const DAY_MS = 86400000;
const RAD = Math.PI / 180;
const J1970 = 2440587.5;
const J2000 = 2451545;

/** Valid latitude/longitude pair (GNOME's "unknown" is (91, 181)). */
export function validCoords(c) {
    return Array.isArray(c) && c.length === 2 && c.every(Number.isFinite) &&
        Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180;
}

/**
 * Sunrise and sunset for the UTC day that contains `dayMs` (the sunrise equation, with the
 * standard -0.833° altitude for refraction and the solar disc; accurate to about a minute).
 *
 * @returns {{sunrise: number, sunset: number}|{polar: 'day'|'night'}} times in ms since 1970
 */
export function sunTimes(dayMs, lat, lon) {
    // Days since J2000 to the noon of that UTC day
    const n = Math.floor(dayMs / DAY_MS) + J1970 + 0.5 - J2000;
    const jStar = n - lon / 360;
    const m = (357.5291 + 0.98560028 * jStar) % 360;
    const c = 1.9148 * Math.sin(m * RAD) + 0.02 * Math.sin(2 * m * RAD) + 0.0003 * Math.sin(3 * m * RAD);
    const lambda = (m + c + 180 + 102.9372) % 360;
    const transit = J2000 + jStar + 0.0053 * Math.sin(m * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
    const sinDecl = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
    const cosDecl = Math.cos(Math.asin(sinDecl));
    const cosOmega = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDecl) / (Math.cos(lat * RAD) * cosDecl);
    if (cosOmega < -1)
        return { polar: 'day' };
    if (cosOmega > 1)
        return { polar: 'night' };
    const omega = Math.acos(cosOmega) / RAD;
    const toMs = j => Math.round((j - J1970) * DAY_MS);
    return { sunrise: toMs(transit - omega / 360), sunset: toMs(transit + omega / 360) };
}

/**
 * Light and dark start times around `now`, sorted: [{at, phase}], phase 'light' | 'dark'.
 *
 * @param {number} now ms since 1970
 * @param {{kind: 'sun', lat: number, lon: number}|{kind: 'custom', lightMinute: number,
 *          darkMinute: number}} schedule custom minutes are local wall-clock time
 */
export function events(now, schedule) {
    const list = [];
    for (let d = -2; d <= 2; d++) {
        if (schedule.kind === 'custom') {
            const day = new Date(now + d * DAY_MS);
            const at = minute => new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                Math.floor(minute / 60), minute % 60).getTime();
            list.push({ at: at(schedule.lightMinute), phase: 'light' });
            list.push({ at: at(schedule.darkMinute), phase: 'dark' });
        } else {
            const t = sunTimes(now + d * DAY_MS, schedule.lat, schedule.lon);
            if (t.polar)
                list.push({ at: Math.floor((now + d * DAY_MS) / DAY_MS) * DAY_MS, phase: t.polar === 'day' ? 'light' : 'dark' });
            else
                list.push({ at: t.sunrise, phase: 'light' }, { at: t.sunset, phase: 'dark' });
        }
    }
    // Same times (equal custom minutes) or duplicates: keep the order stable, drop repeats
    list.sort((a, b) => a.at - b.at);
    return list.filter((e, i) => i === 0 || e.at !== list[i - 1].at);
}

/**
 * The phase now and when it next changes.
 *
 * @returns {{phase: 'light'|'dark', scheme: string, next: ?number}} next: ms of the next
 *   change, null when there is none in reach (polar day or night, equal custom times)
 */
export function plan(now, schedule) {
    const list = events(now, schedule);
    const phase = list.filter(e => e.at <= now).at(-1)?.phase ?? 'light';
    const next = list.find(e => e.at > now && e.phase !== phase)?.at ?? null;
    return { phase, scheme: SCHEME[phase], next };
}

/**
 * Coordinates of a time zone from zone1970.tab / zone.tab (`code<TAB>±DDMM[SS]±DDDMM[SS]<TAB>Zone`).
 *
 * @returns {?number[]} [lat, lon] in degrees, null when the zone is not listed
 */
export function zoneCoords(text, zone) {
    if (!zone)
        return null;
    for (const line of (text ?? '').split('\n')) {
        if (line.startsWith('#'))
            continue;
        const cols = line.split('\t');
        if (cols[2] !== zone)
            continue;
        const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(cols[1] ?? '');
        if (!m)
            return null;
        const deg = (sign, d, mi, s) => (sign === '-' ? -1 : 1) * (Number(d) + Number(mi) / 60 + Number(s ?? 0) / 3600);
        return [deg(m[1], m[2], m[3], m[4]), deg(m[5], m[6], m[7], m[8])];
    }
    return null;
}

/** Guava accent choice -> GNOME accent-color, null for multicolor (follow GNOME, write nothing). */
export function gnomeAccent(choice) {
    const map = {
        blue: 'blue', purple: 'purple', pink: 'pink', red: 'red', orange: 'orange',
        yellow: 'yellow', green: 'green', graphite: 'slate',
    };
    return map[choice] ?? null;
}

/** Highlight choice -> the class on the UI group, null for 'accent' (the theme's own colour). */
export function highlightClass(choice) {
    const named = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'];
    return named.includes(choice) ? `guava-highlight-${choice}` : null;
}
