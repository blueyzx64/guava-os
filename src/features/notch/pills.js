// SPDX-License-Identifier: GPL-3.0-or-later
// What each live activity looks like: describe() turns an activity (stateMachine/model) into
// glyph, tint, title, detail and action, and pill() / row() draw it compact (the 32px pill,
// like a compact Dynamic Island: leading glyph, title, trailing detail) or as a row of the
// Now tab. Media has its own pill (art and waveform), built by the view.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { label, icon, themed, button, track, setText } from './ui.js';
import { formatCountdown, formatElapsed, formatBytes, minutesUntil } from './model.js';

const monoNow = () => Math.floor(GLib.get_monotonic_time() / 1000);

function batteryIcon(percent, charging) {
    const level = Math.max(0, Math.min(100, Math.round((percent ?? 0) / 10) * 10));
    return `battery-level-${level}${charging ? '-charging' : ''}-symbolic`;
}

/**
 * @param {{kind: string, data: object}} activity
 * @param {function(string): string} _
 * @returns {{iconName: string, tint: string|null, title: string, detail: string|(() => string),
 *   fraction?: number|null, actions: Array<{id: string, label: string, iconName?: string}>}}
 *   detail as a function: it changes every second (countdowns), the view refreshes it
 */
export function describe(activity, _) {
    const d = activity.data ?? {};
    switch (activity.kind) {
    case 'timer': {
        const left = () => (d.state === 'paused' ? d.remainingMs : Math.max(0, d.endsAt - Date.now()));
        return {
            iconName: 'alarm-symbolic', tint: 'orange', title: d.label || _('Timer'),
            detail: d.state === 'paused' ? formatCountdown(d.remainingMs) : () => formatCountdown(left()),
            actions: [
                d.state === 'paused'
                    ? { id: 'resume', label: _('Resume'), iconName: 'media-playback-start-symbolic' }
                    : { id: 'pause', label: _('Pause'), iconName: 'media-playback-pause-symbolic' },
                { id: 'cancel', label: _('Cancel'), iconName: 'window-close-symbolic' },
            ],
        };
    }
    case 'timer-done':
        return { iconName: 'alarm-symbolic', tint: 'orange', title: d.label || _('Timer'), detail: _('Done'), actions: [] };
    case 'recording':
        return {
            iconName: 'media-record-symbolic', tint: 'red', title: _('Recording'),
            detail: () => formatElapsed(monoNow() - d.startedAt),
            actions: [{ id: 'stop', label: _('Stop Recording'), iconName: 'media-playback-stop-symbolic' }],
        };
    case 'charging-started':
    case 'charging':
        return { iconName: batteryIcon(d.percent, true), tint: 'green', title: _('Charging'), detail: `${d.percent}%`, actions: [] };
    case 'low-battery':
        return { iconName: batteryIcon(d.percent, false), tint: 'red', title: _('Low Battery'), detail: `${d.percent}%`, actions: [] };
    case 'headphones-connected':
    case 'headphones':
        return {
            iconName: 'audio-headphones-symbolic', tint: null, title: d.name || _('Headphones'),
            detail: Number.isFinite(d.battery) ? `${Math.round(d.battery)}%` : _('Connected'), actions: [],
        };
    case 'download':
        return {
            iconName: 'folder-download-symbolic', tint: 'blue',
            title: d.count > 1 ? _('%d downloads').format(d.count) : d.label,
            detail: d.fraction !== null && d.fraction !== undefined ? `${Math.round(d.fraction * 100)}%` : formatBytes(d.bytes),
            fraction: d.fraction ?? null,
            actions: [],
        };
    case 'event-soon':
    case 'event': {
        const when = () => {
            if (d.start <= Date.now())
                return _('Now');
            const m = minutesUntil(d.start, Date.now());
            if (m < 60)
                return _('in %d min').format(m);
            return GLib.DateTime.new_from_unix_local(Math.floor(d.start / 1000)).format('%H:%M');
        };
        return { iconName: 'x-office-calendar-symbolic', tint: 'red', title: d.summary || _('Event'), detail: when, actions: [] };
    }
    case 'code':
        return {
            iconName: 'dialog-password-symbolic', tint: 'accent', title: d.code,
            detail: d.app ?? '',
            actions: [{ id: 'copy', label: _('Copy'), iconName: 'edit-copy-symbolic' }],
        };
    default:
        return { iconName: 'dialog-information-symbolic', tint: null, title: '', detail: '', actions: [] };
    }
}

const glyph = (desc, size) => {
    const i = icon(themed(desc.iconName), size, `guava-notch-glyph${desc.tint ? ` guava-notch-tint-${desc.tint}` : ''}`);
    return i;
};

// A detail label that a function keeps current: refreshed by the view's 1 s tick while shown
function detailLabel(desc, styleClass, live) {
    const l = label('', styleClass);
    if (typeof desc.detail === 'function') {
        const fn = desc.detail;
        live.push(() => setText(l, fn()));
        l.text = fn();
    } else {
        l.text = desc.detail ?? '';
    }
    return l;
}

/**
 * The compact pill for a non-media activity.
 * @param {object} activity
 * @param {{_: Function, live: Function[], onAction: (activity, id) => void}} env
 */
export function pill(activity, env) {
    const desc = describe(activity, env._);
    const row = new St.BoxLayout({ style_class: `guava-notch-row guava-notch-activity guava-notch-pill-${activity.kind}` });
    row.add_child(glyph(desc, 16));
    const code = activity.kind === 'code';
    row.add_child(label(code ? env._('Code %s').format(desc.title) : desc.title,
        `guava-notch-pill-title${code ? ' guava-notch-code' : ''}`, { x_expand: true }));
    if (activity.kind === 'download' && desc.fraction !== null) {
        const t = track('guava-notch-mini-track', 'guava-notch-mini-fill', 4, desc.fraction, { x_expand: false, width: 40 });
        row.add_child(t);
    }
    if (!code)
        row.add_child(detailLabel(desc, `guava-notch-value${desc.tint ? ` guava-notch-tint-${desc.tint}` : ''}`, env.live));
    // One action in the pill: Copy for a code, Stop for a recording
    const main = desc.actions.find(a => a.id === 'copy' || a.id === 'stop');
    if (main) {
        row.add_child(button({
            styleClass: `guava-notch-pill-action guava-notch-pill-action-${main.id}`,
            iconName: main.id === 'stop' ? main.iconName : null,
            text: main.id === 'stop' ? null : main.label,
            accessibleName: main.label,
            size: 12,
            onClick: () => env.onAction(activity, main.id),
        }));
    }
    return row;
}

/**
 * One row of the Now tab's list.
 * @param {object} activity
 * @param {{_: Function, live: Function[], onAction: Function}} env
 */
export function row(activity, env) {
    const desc = describe(activity, env._);
    const box = new St.BoxLayout({ style_class: 'guava-notch-activity-row', x_expand: true });
    const disc = new St.Bin({ style_class: `guava-notch-activity-disc${desc.tint ? ` guava-notch-disc-${desc.tint}` : ''}`, child: glyph(desc, 16) });
    box.add_child(disc);
    const text = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    text.add_child(label(activity.kind === 'code' ? env._('Code %s').format(desc.title) : desc.title, 'guava-notch-recent-title'));
    text.add_child(detailLabel(desc, 'guava-notch-recent-sub', env.live));
    box.add_child(text);
    for (const a of desc.actions) {
        box.add_child(button({
            styleClass: 'guava-notch-row-action',
            iconName: a.iconName,
            accessibleName: a.label,
            size: 14,
            onClick: () => env.onAction(activity, a.id),
        }));
    }
    return box;
}

/**
 * How often a pill's text changes while shown (ms), or null when it never does: countdowns
 * and elapsed time every second, "in 12 min" twice a minute.
 */
export function tickMs(activity) {
    if (activity.kind === 'recording' || (activity.kind === 'timer' && activity.data?.state === 'running'))
        return 1000;
    if (activity.kind === 'event-soon')
        return 30000;
    return null;
}
