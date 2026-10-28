// SPDX-License-Identifier: GPL-3.0-or-later
// The three tabs of the expanded notch, all on one 648x192 shape so switching never resizes:
//   Now      the media hero (or a large clock), then live activities and recent notifications
//   Tray     the file shelf, a drop target while files are dragged over the notch (and the
//            clipboard column when notch-show-clipboard is on)
//   Widgets  calendar day, weather, quick controls (Do Not Disturb, microphone, timers)
// Builders only: no state. `env` carries gettext, the handlers and the 1 s refresh list:
//   {_, h, live: Function[], alive: () => boolean, clockFormat: () => string}

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import * as A11y from '../../lib/a11y.js';
import { label, icon, themed, button, artwork, track, column, setText } from './ui.js';
import { trackProgress, seekTarget, formatClock } from './dashboardModel.js';
export { DASH_SIZE } from './dashboardModel.js';
import { nowRows } from './model.js';
import { row as activityRow } from './pills.js';
import { dragIconName } from './shelfHelperModel.js';

const WIDTH = Object.freeze({ hero: 340, list: 248, clipboard: 196, inner: 608 });
const SHELF_VISIBLE = 8;
const TIMER_PRESETS = [1, 5, 15];
const SEEK_STEP_S = 5;      // a Left / Right press on the scrubber

function mediaColumn(env, media, width, live) {
    const col = column('guava-notch-media', width);
    let alive = true;
    col.connect('destroy', () => {
        alive = false;
    });

    // Art, title and artist, the app icon in the top-right corner
    const top = new St.BoxLayout({ style_class: 'guava-notch-media-top' });
    top.add_child(artwork(media, 68, 'guava-notch-artwork-large'));
    const text = new St.BoxLayout({
        style_class: 'guava-notch-media-text',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    text.add_child(label(media.title || env._('Unknown title'), 'guava-notch-media-title'));
    if (media.artist)
        text.add_child(label(media.artist, 'guava-notch-media-artist'));
    top.add_child(text);
    if (media.appIcon) {
        top.add_child(new St.Icon({
            gicon: media.appIcon, icon_size: 16,
            style_class: 'guava-notch-media-app', y_align: Clutter.ActorAlign.START,
        }));
    }
    col.add_child(top);

    // The scrubber, when the player reports a length (and then a position)
    const hasLength = Number.isFinite(media.length) && media.length > 0;
    const scrub = new St.BoxLayout({ style_class: 'guava-notch-scrub', visible: hasLength, opacity: 0 });
    const elapsed = label('', 'guava-notch-scrub-time');
    const remaining = label('', 'guava-notch-scrub-time guava-notch-scrub-remaining');
    const bar = track('guava-notch-scrub-track', 'guava-notch-scrub-fill', 4, 0);
    // A click on the bar seeks there. It is a button so the press stays with it and does
    // not count as a click on the notch (which would close the dashboard).
    const seekable = hasLength && !!media.canSeek && !!env.h.onSeek;
    const hit = new St.Button({
        style_class: 'guava-notch-scrub-hit',
        child: bar,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: seekable,
        can_focus: seekable,
        accessible_name: env._('Seek'),
        accessible_role: A11y.Role.SLIDER,
    });
    let position = 0;       // the last fraction shown, the start of a keyboard step
    const seekTo = fraction => {
        if (seekTarget(fraction, media.length) === null)
            return;
        position = Math.max(0, Math.min(1, fraction));
        bar.guavaSetFraction(position);
        env.h.onSeek(fraction);
    };
    hit.connect('clicked', () => {
        const [px] = global.get_pointer();
        const [tx] = bar.get_transformed_position();
        const [tw] = bar.get_transformed_size();
        if (tw > 0)
            seekTo((px - tx) / tw);
    });
    // Left and Right skip SEEK_STEP_S seconds, as a media player's slider does
    hit.connect('key-press-event', (_a, event) => {
        const sym = event.get_key_symbol();
        if (sym !== Clutter.KEY_Left && sym !== Clutter.KEY_Right)
            return Clutter.EVENT_PROPAGATE;
        const step = SEEK_STEP_S / media.length;
        seekTo(position + (sym === Clutter.KEY_Right ? step : -step));
        return Clutter.EVENT_STOP;
    });
    scrub.add_child(elapsed);
    scrub.add_child(hit);
    scrub.add_child(remaining);
    col.add_child(scrub);
    if (hasLength && env.h.getPosition) {
        live.push(() => {
            env.h.getPosition().then(position => {
                if (!alive || !env.alive())
                    return;
                const p = trackProgress(position, media.length);
                const shown = p ? 255 : 0;
                if (scrub.opacity !== shown)
                    scrub.opacity = shown;
                if (!p)
                    return;
                setText(elapsed, p.elapsed);
                setText(remaining, p.remaining);
                position = p.fraction;
                bar.guavaSetFraction(p.fraction);
            }).catch(() => {});
        });
    }

    // Previous, play / pause, next
    const controls = new St.BoxLayout({
        style_class: 'guava-notch-controls', x_align: Clutter.ActorAlign.CENTER,
    });
    const control = (name, symbolic, command, enabled, size) => {
        const b = new St.Button({
            style_class: 'guava-notch-control',
            child: new St.Icon({ icon_name: symbolic, icon_size: size }),
            can_focus: enabled,
            reactive: enabled,
            opacity: enabled ? 255 : 90,
            accessible_name: name,
        });
        b.connect('clicked', () => env.h.onMedia(command));
        controls.add_child(b);
    };
    control(env._('Previous'), 'media-skip-backward-symbolic', 'previous', media.canPrevious, 20);
    control(media.playing ? env._('Pause') : env._('Play'),
        media.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
        'toggle', true, 24);
    control(env._('Next'), 'media-skip-forward-symbolic', 'next', media.canNext, 20);
    col.add_child(controls);
    return col;
}

// Nothing is playing: a large clock and the date in place of the player
function clockColumn(env, width, live) {
    const col = column('guava-notch-clock', width);
    const row = new St.BoxLayout({ style_class: 'guava-notch-clock-row' });
    const time = new St.Label({ style_class: 'guava-notch-clock-time' });
    const suffix = new St.Label({ style_class: 'guava-notch-clock-suffix', y_align: Clutter.ActorAlign.END });
    row.add_child(time);
    row.add_child(suffix);
    col.add_child(row);
    const day = label('', 'guava-notch-clock-date');
    col.add_child(day);
    live.push(() => {
        const now = GLib.DateTime.new_now_local();
        const c = formatClock(now.get_hour(), now.get_minute(), env.clockFormat());
        setText(time, c.time);
        setText(suffix, c.suffix);
        suffix.visible = !!c.suffix;
        setText(day, now.format('%A, %e %B').replace(/\s+/g, ' '));
    });
    return col;
}

// Recent notifications (and an "N more" line) for the Now tab's right column
function listColumn(env, ctx) {
    const col = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    const recent = ctx.recent ?? [];
    if (!recent.length && ctx.empty) {
        col.add_child(label(env._('No notifications'), 'guava-notch-empty-text guava-notch-list-empty', {
            x_align: Clutter.ActorAlign.CENTER,
        }));
    }
    for (const item of recent) {
        const b = new St.Button({
            style_class: 'guava-notch-recent',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            accessible_name: item.title,
        });
        const row = new St.BoxLayout({ style_class: 'guava-notch-recent-row', x_expand: true });
        row.add_child(icon(item.gicon ?? themed('dialog-information-symbolic'), 20, 'guava-notch-recent-icon'));
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const line = new St.BoxLayout({ style_class: 'guava-notch-recent-line' });
        line.add_child(label(item.title, 'guava-notch-recent-title', { x_expand: true }));
        if (item.when)
            line.add_child(label(item.when, 'guava-notch-recent-time'));
        text.add_child(line);
        const body = (item.body ?? '').replace(/\s+/g, ' ').trim();
        if (body || item.app) {
            const sub = label('', 'guava-notch-recent-sub');
            // Like the card: the body may carry markup (Rhythmbox sends
            // "by <i>Artist</i>"); fixMarkup keeps the allowed tags and escapes the rest.
            try {
                sub.clutter_text.set_markup(body
                    ? Util.fixMarkup(body, !!item.markup)
                    : Util.fixMarkup(item.app, false));
            } catch (_e) {
                sub.text = body || item.app;
            }
            text.add_child(sub);
        }
        row.add_child(text);
        b.set_child(row);
        b.connect('clicked', () => env.h.onOpenNotification?.(item.notification));
        col.add_child(b);
    }
    const more = ctx.more ?? 0;
    if (more > 0) {
        const b = new St.Button({
            style_class: 'guava-notch-more',
            label: env._('%d more').format(more),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        b.connect('clicked', () => env.h.onOpenList?.());
        col.add_child(b);
    }
    return col;
}

// Clipboard history (null while the clipboard feature or its notch option is off)
function clipboardColumn(env, entries, width) {
    const col = column('guava-notch-clipboard', width);
    col.add_child(label(env._('Clipboard'), 'guava-notch-caption'));
    if (!entries.length)
        col.add_child(label(env._('Nothing copied yet'), 'guava-notch-empty-text'));
    for (const entry of entries) {
        const b = new St.Button({
            style_class: 'guava-notch-clip',
            accessible_name: entry.text,
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            child: label(entry.text, 'guava-notch-clip-text'),
        });
        b.connect('clicked', () => env.h.onCopy(entry.id));
        col.add_child(b);
    }
    return col;
}

// ---- Now -------------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {{media, activities: object[], recent: object[], count: number}} ctx
 */
export function nowTab(env, ctx) {
    const body = new St.BoxLayout({ style_class: 'guava-notch-tab-body guava-notch-tab-now', x_expand: true, y_expand: true });
    // Both columns sit in the middle of the body's height, so a short one (the clock, one or
    // two notifications) is balanced against the other instead of hugging the top
    const hero = ctx.media ? mediaColumn(env, ctx.media, WIDTH.hero, env.live) : clockColumn(env, WIDTH.hero, env.live);
    hero.y_align = Clutter.ActorAlign.CENTER;
    body.add_child(hero);

    const col = column('guava-notch-list', WIDTH.list);
    col.y_align = Clutter.ActorAlign.CENTER;
    const acts = (ctx.activities ?? []).filter(a => a.kind !== 'media' && a.kind !== 'media-paused');
    const recent = ctx.recent ?? [];
    const rows = nowRows(acts.length, Math.max(recent.length, ctx.count ?? 0));
    for (const a of acts.slice(0, rows.activities))
        col.add_child(activityRow(a, { _: env._, live: env.live, onAction: env.h.onActivityAction }));
    const listed = recent.slice(0, rows.notifications);
    const more = Math.max(0, (ctx.count ?? recent.length) - listed.length);
    col.add_child(listColumn(env, { recent: listed, more: rows.activities + listed.length < 3 ? more : 0, empty: !acts.length }));
    body.add_child(col);
    return body;
}

// ---- Tray ------------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {{shelf: {uris: string[], info: Function, clipboardHasFiles: boolean}, selected: string|null,
 *   clipboard: object[]|null}} ctx
 */
export function trayTab(env, ctx) {
    const body = new St.BoxLayout({ style_class: 'guava-notch-tab-body guava-notch-tab-tray', x_expand: true, y_expand: true });
    const width = ctx.clipboard ? WIDTH.inner - WIDTH.clipboard - 20 : WIDTH.inner;
    const shelf = column(`guava-notch-shelf${ctx.dropping ? ' guava-notch-shelf-dropping' : ''}`, width);
    const uris = ctx.shelf.uris;
    const selected = uris.includes(ctx.selected) ? ctx.selected : null;

    // Toolbar: what you can do with the selection, or how to add files
    const bar = new St.BoxLayout({ style_class: 'guava-notch-shelf-bar' });
    if (ctx.dropping) {
        bar.add_child(icon(themed('folder-download-symbolic'), 16, 'guava-notch-glyph guava-notch-tint-accent'));
        bar.add_child(label(env._('Drop to add to the Shelf'), 'guava-notch-shelf-selected', { x_expand: true }));
    } else if (selected) {
        const info = ctx.shelf.info(selected);
        bar.add_child(label(info.name, 'guava-notch-shelf-selected', { x_expand: true }));
        const act = (iconName, name, fn) => bar.add_child(button({
            styleClass: 'guava-notch-row-action', iconName, accessibleName: name, size: 14, onClick: fn,
        }));
        act('document-open-symbolic', env._('Open'), () => env.h.onShelf('open', selected));
        act('folder-open-symbolic', env._('Show in Files'), () => env.h.onShelf('reveal', selected));
        act('edit-copy-symbolic', env._('Copy'), () => env.h.onShelf('copy', selected));
        act('list-remove-symbolic', env._('Remove from Shelf'), () => env.h.onShelf('remove', selected));
    } else {
        const add = button({
            styleClass: 'guava-notch-chip', iconName: 'list-add-symbolic', text: env._('Add from Clipboard'),
            accessibleName: env._('Add from Clipboard'), size: 12, onClick: () => env.h.onShelf('add-clipboard'),
        });
        add.reactive = ctx.shelf.clipboardHasFiles;
        add.opacity = add.reactive ? 255 : 110;
        bar.add_child(add);
        bar.add_child(new St.Widget({ x_expand: true }));
        if (uris.length) {
            bar.add_child(button({
                styleClass: 'guava-notch-chip', text: env._('Clear'), accessibleName: env._('Clear Shelf'),
                onClick: () => env.h.onShelf('clear'),
            }));
        }
    }
    shelf.add_child(bar);

    if (!uris.length) {
        const empty = new St.BoxLayout({ style_class: 'guava-notch-shelf-empty', orientation: Clutter.Orientation.VERTICAL, y_expand: true });
        empty.add_child(icon(themed('folder-download-symbolic'), 24, 'guava-notch-shelf-empty-icon'));
        empty.add_child(label(env._('Drop files here, or copy them and Add from Clipboard'),
            'guava-notch-empty-text guava-notch-shelf-hint', { x_align: Clutter.ActorAlign.CENTER }));
        shelf.add_child(empty);
    } else {
        const grid = new St.Widget({
            style_class: 'guava-notch-shelf-grid',
            layout_manager: new Clutter.GridLayout({ column_homogeneous: true, column_spacing: 8, row_spacing: 8 }),
            x_expand: true,
        });
        const perRow = 4;
        const tiles = [];
        uris.slice(0, SHELF_VISIBLE).forEach((uri, i) => {
            const info = ctx.shelf.info(uri);
            const tile = new St.Button({
                style_class: `guava-notch-shelf-tile${uri === selected ? ' guava-notch-shelf-tile-selected' : ''}${info.missing ? ' guava-notch-shelf-missing' : ''}`,
                can_focus: true,
                accessible_name: info.name,
                x_expand: true,
            });
            const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
            box.add_child(icon(info.gicon ?? themed('text-x-generic-symbolic'), 28, 'guava-notch-shelf-icon'));
            box.add_child(label(info.name, 'guava-notch-shelf-name', { x_align: Clutter.ActorAlign.CENTER }));
            tile.set_child(box);
            tile.connect('clicked', () => env.h.onShelf(uri === selected ? 'open' : 'select', uri));
            grid.layout_manager.attach(tile, i % perRow, Math.floor(i / perRow), 1, 1);
            tiles.push({ actor: tile, uri, icon: dragIconName(info.gicon) });
        });
        shelf.add_child(grid);
        env.shelf = { grid, tiles };
        if (uris.length > SHELF_VISIBLE)
            bar.insert_child_at_index(label(`+${uris.length - SHELF_VISIBLE}`, 'guava-notch-badge'), 0);
    }
    body.add_child(shelf);
    if (ctx.clipboard)
        body.add_child(clipboardColumn(env, ctx.clipboard, WIDTH.clipboard));
    return body;
}

// ---- Widgets ---------------------------------------------------------------------------

function card(styleClass, width) {
    return new St.BoxLayout({
        style_class: `guava-notch-widget ${styleClass}`,
        orientation: Clutter.Orientation.VERTICAL,
        width,
        y_expand: true,
    });
}

/**
 * @param {object} env
 * @param {{events: object[]|null, weather: object|null, mic: {available, muted}, dnd: boolean,
 *   timersEnabled: boolean}} ctx
 */
export function widgetsTab(env, ctx) {
    const body = new St.BoxLayout({ style_class: 'guava-notch-tab-body guava-notch-tab-widgets', x_expand: true, y_expand: true });

    // Calendar day: weekday and date, then today's next events
    const cal = card('guava-notch-widget-calendar', 252);
    const now = GLib.DateTime.new_now_local();
    const top = new St.BoxLayout({ style_class: 'guava-notch-cal-top' });
    top.add_child(label(now.format('%A').toUpperCase(), 'guava-notch-cal-weekday', { x_expand: true }));
    top.add_child(label(String(now.get_day_of_month()), 'guava-notch-cal-day'));
    cal.add_child(top);
    const nowMs = Date.now();
    const upcoming = (ctx.events ?? []).filter(e => e.end > nowMs).sort((a, b) => a.start - b.start).slice(0, 2);
    if (!upcoming.length)
        cal.add_child(label(ctx.events ? env._('No more events today') : env._('No calendar'), 'guava-notch-cal-none'));
    for (const e of upcoming) {
        const r = new St.BoxLayout({ style_class: 'guava-notch-cal-event' });
        r.add_child(new St.Widget({ style_class: 'guava-notch-cal-bar', y_expand: true }));
        const text = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        text.add_child(label(e.summary, 'guava-notch-cal-summary'));
        const time = e.allDay ? env._('All day')
            : GLib.DateTime.new_from_unix_local(Math.floor(e.start / 1000)).format('%H:%M');
        text.add_child(label(time, 'guava-notch-cal-time'));
        r.add_child(text);
        cal.add_child(r);
    }
    const calButton = new St.Button({ style_class: 'guava-notch-widget-button', child: cal, can_focus: true, accessible_name: env._('Calendar') });
    calButton.connect('clicked', () => env.h.onOpenCalendar());
    body.add_child(calButton);

    // Weather from the date menu's client
    const w = ctx.weather;
    const wx = card('guava-notch-widget-weather', 160);
    if (w && !w.loading) {
        wx.add_child(label(w.location, 'guava-notch-wx-place'));
        const line = new St.BoxLayout({ style_class: 'guava-notch-wx-line' });
        line.add_child(icon(themed(w.icon), 28, 'guava-notch-wx-icon'));
        line.add_child(label(w.temp, 'guava-notch-wx-temp'));
        wx.add_child(line);
        wx.add_child(label(w.summary, 'guava-notch-wx-summary'));
    } else {
        wx.add_child(label(env._('Weather'), 'guava-notch-wx-place'));
        wx.add_child(icon(themed('weather-overcast-symbolic'), 28, 'guava-notch-wx-icon guava-notch-wx-off'));
        wx.add_child(label(w?.loading ? env._('Loading…') : env._('Not available'), 'guava-notch-wx-summary'));
    }
    const wxButton = new St.Button({ style_class: 'guava-notch-widget-button', child: wx, can_focus: true, accessible_name: env._('Weather') });
    wxButton.connect('clicked', () => env.h.onOpenWeather());
    body.add_child(wxButton);

    // Quick controls
    const ctl = card('guava-notch-widget-controls', 156);
    const toggles = new St.BoxLayout({ style_class: 'guava-notch-toggles' });
    const toggle = (iconName, name, on, fn, enabled = true) => {
        const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'guava-notch-toggle-box', x_expand: true });
        const b = button({ styleClass: 'guava-notch-toggle', iconName, accessibleName: name, size: 18, toggle: on, onClick: fn });
        b.reactive = enabled;
        b.opacity = enabled ? 255 : 110;
        b.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(b);
        box.add_child(label(name, 'guava-notch-toggle-caption', { x_align: Clutter.ActorAlign.CENTER }));
        toggles.add_child(box);
    };
    // The active Focus mode's icon and name (features/focus), else the Do Not Disturb moon
    const focus = ctx.focus?.id ? ctx.focus : null;
    toggle(focus?.icon ?? 'weather-clear-night-symbolic', focus?.name ?? env._('Focus'),
        ctx.dnd || !!focus, () => env.h.onToggleDnd());
    toggle(ctx.mic.muted ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic',
        env._('Mic Off'), ctx.mic.muted, () => env.h.onToggleMic(), ctx.mic.available);
    ctl.add_child(toggles);
    if (ctx.timersEnabled) {
        const presets = new St.BoxLayout({ style_class: 'guava-notch-presets' });
        presets.add_child(icon(themed('alarm-symbolic'), 14, 'guava-notch-glyph guava-notch-tint-orange'));
        for (const m of TIMER_PRESETS) {
            presets.add_child(button({
                styleClass: 'guava-notch-chip guava-notch-preset',
                text: env._('%dm').format(m),
                accessibleName: env._('Start a %d minute timer').format(m),
                onClick: () => env.h.onTimerPreset(m),
            }));
        }
        ctl.add_child(presets);
    }
    body.add_child(ctl);
    return body;
}
