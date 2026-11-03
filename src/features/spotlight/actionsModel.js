// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight Actions: Guava's own actions, typed parameters ("timer 5m") and the rows they make.
// Pure (no gi imports), unit-tested in tests/spotlightActions.test.js. The adapter
// (providers/actions.js) runs them and adds the .desktop actions and Settings panels.
//
//   actionItems(GUAVA_ACTIONS, { dnd: false, dark: true }, _)   -> rows for the Actions view
//   parameterItems(GUAVA_ACTIONS, 'timer 5m', _)                  -> [{... args: {seconds: 300}}]
//   parseDuration('1h30m')                                       -> 5400

const N_ = s => s;

export const ACTION_BOOST = 120;

/**
 * Guava's actions. `title` may depend on the state ({dnd, dark}) through `titles`.
 * `param: 'duration'` takes a trailing duration after one of `triggers`.
 * `needs` names a capability the adapter reports (a feature that must be running).
 */
export const GUAVA_ACTIONS = Object.freeze([
    { id: 'show-desktop', title: N_('Show Desktop'), keywords: ['desktop', 'hide windows', 'clear'],
        icon: 'user-desktop-symbolic', needs: 'show-desktop' },
    { id: 'lock', title: N_('Lock Screen'), keywords: ['lock', 'away', 'screen lock'],
        icon: 'system-lock-screen-symbolic' },
    { id: 'timer', title: N_('Start Timer'), keywords: ['timer', 'countdown', 'tmr', 'clock'],
        icon: 'alarm-symbolic', param: 'duration', triggers: ['timer', 'tmr', 'countdown'] },
    { id: 'dnd', titles: { on: N_('Turn Off Do Not Disturb'), off: N_('Turn On Do Not Disturb') },
        state: 'dnd', keywords: ['focus', 'do not disturb', 'dnd'],
        icon: 'notifications-disabled-symbolic' },
    { id: 'dark-mode', titles: { on: N_('Turn Off Dark Mode'), off: N_('Turn On Dark Mode') },
        state: 'dark', keywords: ['dark mode', 'dark style', 'light mode', 'appearance', 'theme', 'night'],
        icon: 'weather-clear-night-symbolic' },
    { id: 'empty-trash', title: N_('Empty Trash'), keywords: ['trash', 'bin', 'wastebasket'],
        icon: 'user-trash-full-symbolic', needs: 'trash' },
    { id: 'screenshot', title: N_('Take Screenshot'), keywords: ['screenshot', 'screen capture', 'capture', 'print screen', 'screen recording'],
        icon: 'camera-photo-symbolic' },
]);

/** Ids the Quick Keys editor offers, with their (untranslated) titles. */
export function actionChoices(defs = GUAVA_ACTIONS) {
    return defs.map(d => ({ id: d.id, title: d.title ?? d.titles.off }));
}

function titleOf(def, state) {
    if (def.titles)
        return state?.[def.state] ? def.titles.on : def.titles.off;
    return def.title;
}

/**
 * The rows for Guava's actions. `available` holds the capabilities the adapter found; actions
 * that need a missing one are left out.
 */
export function actionItems(defs, state, _, available = null) {
    return defs
        .filter(d => !d.needs || !available || available.has(d.needs))
        .map(d => ({
            id: `action:${d.id}`,
            kind: 'command',
            actionId: d.id,
            title: _(titleOf(d, state)),
            subtitle: _('Guava Action'),
            keywords: [...d.keywords, d.id],
            iconName: d.icon,
            // An action that matches is what was asked for: it ranks over a Settings panel
            // whose keywords say the same ("do not disturb" -> the action, not Notifications)
            boost: ACTION_BOOST,
        }));
}

const UNIT = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600 };
const MAX_SECONDS = 24 * 3600;

/**
 * A duration as typed: "5" (minutes, as macOS's "tmr 5"), "5m", "90s", "1h30m", "1 h 30 min",
 * "2:30" (minutes:seconds). @returns {?number} seconds, null when it is not a duration
 */
export function parseDuration(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t)
        return null;
    let seconds;
    if (/^\d+(\.\d+)?$/.test(t)) {
        seconds = Math.round(Number(t) * 60);
    } else if (/^\d+:\d{1,2}$/.test(t)) {
        const [m, s] = t.split(':').map(Number);
        if (s >= 60)
            return null;
        seconds = m * 60 + s;
    } else {
        const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
        let consumed = '';
        let m;
        seconds = 0;
        while ((m = re.exec(t)) !== null) {
            const unit = UNIT[m[2]];
            if (!unit)
                return null;
            seconds += Number(m[1]) * unit;
            consumed += m[0];
        }
        if (consumed.replace(/\s+/g, '') !== t.replace(/\s+/g, ''))
            return null;
        seconds = Math.round(seconds);
    }
    return seconds > 0 && seconds <= MAX_SECONDS ? seconds : null;
}

/** "1 h 30 min", "5 min", "45 s", "2 min 30 s". */
export function formatDuration(seconds, _ = s => s) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (h)
        parts.push(`${h} ${_('h')}`);
    if (m)
        parts.push(`${m} ${_('min')}`);
    if (s)
        parts.push(`${s} ${_('s')}`);
    return parts.join(' ') || `0 ${_('s')}`;
}

/**
 * Rows for actions with a typed parameter: "timer 5m" -> "Start a 5 min Timer". The row ranks
 * above everything (it is exactly what was typed). A trigger alone ("timer") gives nothing
 * here; the plain action row still matches.
 * @param {object[]} defs
 * @param {string} query the search text
 * @param {Function} _ gettext
 * @param {string} [viaAlias] a Quick Key that stands for the action (then every word is the parameter)
 */
export function parameterItems(defs, query, _, viaAlias = null) {
    const words = String(query ?? '').trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (const def of defs) {
        if (def.param !== 'duration')
            continue;
        let rest;
        if (viaAlias === def.id)
            rest = words.join(' ');
        else if (words.length > 1 && def.triggers.includes(words[0].toLowerCase()))
            rest = words.slice(1).join(' ');
        else
            continue;
        const seconds = parseDuration(rest);
        if (seconds === null)
            continue;
        const label = formatDuration(seconds, _);
        out.push({
            id: `action:${def.id}:${seconds}`,
            kind: 'command',
            actionId: def.id,
            args: { seconds, label },
            title: _('Start a %s Timer').replace('%s', label),
            subtitle: _('Guava Action'),
            iconName: def.icon,
            score: 1500,
        });
    }
    return out;
}
