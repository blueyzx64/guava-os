// SPDX-License-Identifier: GPL-3.0-or-later
// Focus modes: the pure rules (no gi imports, unit-tested with an injected clock).
//
// A Focus mode (macOS Monterey's Do Not Disturb, Sleep, Work, Personal and custom ones) is a
// profile: which apps may still notify, when it turns on by itself (schedules, "while this app
// is open") and whether time-sensitive (critical) notifications break through.
//
// What is active is decided by evaluate() from three inputs: the manual state (the user turned
// a mode on or off, perhaps for a while), the automations (app open, schedule) and the clock.
// Nothing here reads the clock; callers pass `now` in milliseconds.

export const URGENCY_CRITICAL = 3;      // MessageTray.Urgency.CRITICAL
export const MAX_CUSTOM_MODES = 10;     // as macOS

/** Built-in modes in menu order. `icon` is a symbolic icon name of the Adwaita theme. */
export const BUILT_IN = Object.freeze([
    { id: 'dnd', name: 'Do Not Disturb', icon: 'notifications-disabled-symbolic' },
    { id: 'sleep', name: 'Sleep', icon: 'weather-clear-night-symbolic' },
    { id: 'work', name: 'Work', icon: 'applications-engineering-symbolic' },
    { id: 'personal', name: 'Personal', icon: 'avatar-default-symbolic' },
]);

export const CUSTOM_ICON = 'starred-symbolic';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
export const EVERY_DAY = Object.freeze([0, 1, 2, 3, 4, 5, 6]);      // Date.getDay(): 0 = Sunday

/** The id of a desktop entry without ".desktop", lower case: the form every comparison uses. */
export function normalizeAppId(id) {
    return String(id ?? '').replace(/\.desktop$/i, '').toLowerCase();
}

function blankProfile(base) {
    return {
        id: base.id,
        name: base.name,
        icon: base.icon ?? CUSTOM_ICON,
        builtIn: !!base.builtIn,
        allowedApps: [],
        allowTimeSensitive: true,
        schedules: [],              // {days: number[], start: minutes, end: minutes}
        appTriggers: [],            // app ids that turn the mode on while they run
    };
}

const unique = list => [...new Set(list)];

function cleanSchedule(raw) {
    const days = unique((raw?.days ?? []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)).sort();
    const start = Number(raw?.start);
    const end = Number(raw?.end);
    const valid = m => Number.isInteger(m) && m >= 0 && m < DAY_MINUTES;
    if (!days.length || !valid(start) || !valid(end) || start === end)
        return null;
    return { days, start, end };
}

function cleanProfile(raw, base) {
    const profile = blankProfile(base);
    if (typeof raw?.name === 'string' && raw.name.trim() && !profile.builtIn)
        profile.name = raw.name.trim();
    if (typeof raw?.icon === 'string' && raw.icon)
        profile.icon = raw.icon;
    profile.allowedApps = unique((raw?.allowedApps ?? []).map(normalizeAppId).filter(Boolean));
    profile.appTriggers = unique((raw?.appTriggers ?? []).map(normalizeAppId).filter(Boolean));
    profile.allowTimeSensitive = raw?.allowTimeSensitive !== false;
    profile.schedules = (raw?.schedules ?? []).map(cleanSchedule).filter(Boolean);
    return profile;
}

/**
 * The modes, from the stored JSON: the built-ins (always present, in order, with the stored
 * settings applied) followed by the custom ones. Bad input falls back to the defaults.
 *
 * @param {string} json the `focus-profiles` setting ('' for none)
 * @returns {object[]}
 */
export function parseProfiles(json) {
    let stored = [];
    try {
        const parsed = json ? JSON.parse(json) : [];
        if (Array.isArray(parsed))
            stored = parsed.filter(p => p && typeof p.id === 'string');
    } catch (_e) {
        stored = [];
    }
    const byId = new Map(stored.map(p => [p.id, p]));
    const profiles = BUILT_IN.map(base => cleanProfile(byId.get(base.id), { ...base, builtIn: true }));
    const seen = new Set(profiles.map(p => p.id));
    for (const raw of stored) {
        if (seen.has(raw.id) || profiles.length >= BUILT_IN.length + MAX_CUSTOM_MODES)
            continue;
        seen.add(raw.id);
        profiles.push(cleanProfile(raw, { id: raw.id, name: String(raw.name ?? '').trim() || raw.id }));
    }
    return profiles;
}

/** @returns {string} the JSON to store: only what differs from the defaults */
export function serializeProfiles(profiles) {
    const plain = profiles.map(p => ({
        id: p.id, name: p.name, icon: p.icon, allowedApps: p.allowedApps,
        allowTimeSensitive: p.allowTimeSensitive, schedules: p.schedules, appTriggers: p.appTriggers,
    }));
    const defaults = parseProfiles('');
    const isDefault = plain.length === defaults.length &&
        plain.every((p, i) => JSON.stringify(p) === JSON.stringify(serializeOne(defaults[i])));
    return isDefault ? '' : JSON.stringify(plain);
}

function serializeOne(p) {
    return {
        id: p.id, name: p.name, icon: p.icon, allowedApps: p.allowedApps,
        allowTimeSensitive: p.allowTimeSensitive, schedules: p.schedules, appTriggers: p.appTriggers,
    };
}

/** Id for a new custom mode named `name` that no profile uses yet. */
export function customId(profiles, name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'focus';
    const taken = new Set(profiles.map(p => p.id));
    let id = `custom-${slug}`;
    for (let n = 2; taken.has(id); n++)
        id = `custom-${slug}-${n}`;
    return id;
}

// ---- manual state -------------------------------------------------------------------------

/**
 * The user's choice, kept in the `focus-state` setting.
 *   null                          nothing chosen: the automations decide
 *   {id: 'work', until: 0}        Work until the user turns it off
 *   {id: 'work', until: ms}       Work until that time
 *   {id: null, until: 0}          the user turned Focus off while an automation had it on:
 *                                 off until that automation ends
 *
 * @param {string} json
 * @returns {?{id: ?string, until: number}}
 */
export function parseState(json) {
    try {
        const raw = json ? JSON.parse(json) : null;
        if (!raw || typeof raw !== 'object' || !('id' in raw))
            return null;
        if (raw.id !== null && typeof raw.id !== 'string')
            return null;
        const until = Number.isFinite(raw.until) && raw.until > 0 ? raw.until : 0;
        return { id: raw.id, until };
    } catch (_e) {
        return null;
    }
}

export function serializeState(state) {
    return state ? JSON.stringify({ id: state.id, until: state.until }) : '';
}

// ---- schedules ----------------------------------------------------------------------------

function minutesOf(date) {
    return date.getHours() * 60 + date.getMinutes();
}

/** Is the schedule running at `date`? A window past midnight belongs to the day it starts. */
export function scheduleActive(schedule, date) {
    const day = date.getDay();
    const minute = minutesOf(date);
    if (schedule.start < schedule.end)
        return schedule.days.includes(day) && minute >= schedule.start && minute < schedule.end;
    const yesterday = (day + 6) % 7;
    return (schedule.days.includes(day) && minute >= schedule.start) ||
        (schedule.days.includes(yesterday) && minute < schedule.end);
}

function atMinute(date, dayOffset, minute) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset,
        Math.floor(minute / 60), minute % 60).getTime();
}

/** Every start and end instant of the schedule within the next eight days, after `now`. */
function edges(schedule, now) {
    const date = new Date(now);
    const out = [];
    for (let offset = -1; offset <= 8; offset++) {
        const weekday = (date.getDay() + offset + 7) % 7;
        if (!schedule.days.includes(weekday))
            continue;
        const start = atMinute(date, offset, schedule.start);
        const crosses = schedule.end <= schedule.start;
        const end = atMinute(date, offset + (crosses ? 1 : 0), schedule.end);
        for (const t of [start, end]) {
            if (t > now)
                out.push(t);
        }
    }
    return out;
}

// ---- evaluation ---------------------------------------------------------------------------

/**
 * Which mode the automations want right now, and when that stops.
 *
 * @param {object[]} profiles
 * @param {number} now ms
 * @param {Set<string>|string[]} openApps normalized ids of the running apps
 * @returns {?{id: string, reason: 'app'|'schedule', endsAt: ?number}}
 */
export function automatic(profiles, now, openApps) {
    const open = new Set([...openApps].map(normalizeAppId));
    const date = new Date(now);
    // A running trigger app beats a schedule, as on macOS where the newer rule wins
    for (const p of profiles) {
        if (p.appTriggers.some(app => open.has(app)))
            return { id: p.id, reason: 'app', endsAt: null };
    }
    for (const p of profiles) {
        const active = p.schedules.filter(s => scheduleActive(s, date));
        if (active.length === 0)
            continue;
        // It ends at the first edge at which none of the mode's schedules runs (adjacent ones join)
        const ends = p.schedules.flatMap(s => edges(s, now))
            .filter(t => !p.schedules.some(o => scheduleActive(o, new Date(t))));
        return { id: p.id, reason: 'schedule', endsAt: ends.length ? Math.min(...ends) : null };
    }
    return null;
}

/**
 * The next instant at which an answer of evaluate() can change by itself (a schedule edge or
 * the end of "for 1 hour"), or null. App triggers are events, not times.
 */
export function nextEdge(profiles, manual, now) {
    const times = [];
    if (manual?.until > now)
        times.push(manual.until);
    for (const p of profiles) {
        for (const s of p.schedules)
            times.push(...edges(s, now));
    }
    return times.length ? Math.min(...times) : null;
}

/**
 * @param {{profiles: object[], manual: ?object, now: number, openApps: Set<string>|string[]}} input
 * @returns {{active: ?{id: string, reason: 'manual'|'app'|'schedule'}, manual: ?object, until: ?number}}
 *   `manual` is the state to keep (expired choices are dropped); `until` is when the active
 *   mode ends by itself, if it does.
 */
export function evaluate({ profiles, manual, now, openApps }) {
    const auto = automatic(profiles, now, openApps);
    let state = manual;
    if (state?.until && now >= state.until)
        state = null;
    // "Off until the automation ends" is over when the automation is
    if (state && state.id === null && !auto)
        state = null;
    // A mode that was removed cannot stay on
    if (state?.id && !profiles.some(p => p.id === state.id))
        state = null;
    if (state)
        return { active: state.id ? { id: state.id, reason: 'manual' } : null, manual: state, until: state.until || null };
    if (auto)
        return { active: { id: auto.id, reason: auto.reason }, manual: null, until: auto.endsAt };
    return { active: null, manual: null, until: null };
}

/**
 * The state after the user turns a mode on or off.
 *
 * @param {?{id: string}} active what evaluate() reported before
 * @param {?string} id the mode to turn on, or null to turn Focus off
 * @param {number} [durationMs] 0 or absent: until turned off
 * @param {number} now
 * @param {boolean} automationOn an automation currently wants a mode
 */
export function choose(active, id, durationMs, now, automationOn) {
    if (id)
        return { id, until: durationMs > 0 ? now + durationMs : 0 };
    // Off: forget the choice, but keep an automation from turning it straight back on
    return automationOn && active ? { id: null, until: 0 } : null;
}

/** The first "evening" or "tomorrow morning" instant for the menu's duration items. */
export function untilTomorrow(now) {
    const date = new Date(now);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 7, 0).getTime();
}

// ---- notifications ------------------------------------------------------------------------

/**
 * May this notification show a banner under the active mode? Silenced ones are still recorded
 * by the caller (they stay in the Notification Center).
 *
 * @param {?object} profile the active mode, null when Focus is off
 * @param {{appId: ?string, urgency: number}} notification
 */
export function allows(profile, notification) {
    if (!profile)
        return true;
    if (profile.allowTimeSensitive && notification.urgency >= URGENCY_CRITICAL)
        return true;
    const app = normalizeAppId(notification.appId);
    return app !== '' && profile.allowedApps.includes(app);
}

/** Add or remove an app from a list, returning the new list. */
export function toggleApp(list, appId) {
    const id = normalizeAppId(appId);
    return list.includes(id) ? list.filter(x => x !== id) : [...list, id];
}

// ---- display ------------------------------------------------------------------------------

export function minutesToText(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function textToMinutes(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
    if (!match)
        return null;
    const [h, m] = [Number(match[1]), Number(match[2])];
    return h < 24 && m < 60 ? h * 60 + m : null;
}

export const HOUR_MS = 60 * MINUTE_MS;
