// SPDX-License-Identifier: GPL-3.0-or-later
// Notification notch: a black pill in the centre of the top bar that grows to show
// notifications, live activities and volume / brightness confirmations, and opens on hover or
// click into three tabs: Now (media and activities), Tray (the file shelf) and Widgets.
//
// This file is the imperative shell. The decisions live in stateMachine.js (pure, tested);
// the actors in view.js. What this file wires:
//   - NotificationRouter.setBannerSink  stock banners go to the notch, history stays in the
//                                       calendar menu (key notch-notifications)
//   - MprisWatcher                      media live activity + dashboard (notch-live-activities)
//   - ctx.osd sink 'notch'              volume / brightness / backlight OSD, when core/osd.js routes
//                                       them here (osd-location 'notch', the default)
//   - PanelLayout.claim 'notch'         room in the centre box
//   - sources/*.js                      battery, headphones, timers (core/timers), recording,
//                                       next event, downloads, one-time codes; each has its
//                                       own registry and notch-activity-* key
//   - Shelf                             the Tray tab's file links (notch-shelf)
// Every part undoes itself through the CleanupRegistry; stock banners and OSD come back.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import St from 'gi://St';
import Shell from 'gi://Shell';

import { CleanupRegistry } from '../../lib/disposables.js';
import { GuavaSettings } from '../../lib/settings.js';
import { setUnredirectAllowed, requeueBanner, kickTray } from '../../lib/compat.js';
import { PanelLayout } from '../../core/panelLayout.js';
import { NotificationRouter } from '../../core/notificationRouter.js';
import { MprisWatcher } from '../../core/mprisWatcher.js';
import { pickPlayer, showsActivity } from '../../lib/mprisModel.js';
import {
    initialState, step, view, nextDeadline, wantsBar, recentNotifications, URGENCY,
} from './stateMachine.js';
import { seekTarget } from './dashboardModel.js';
import { NotchView } from './view.js';
import { Shelf } from './shelf.js';
import { ShelfHelper } from './shelfHelper.js';
import { watchDrops } from './drop.js';
import { dropZone } from './model.js';
import { watchPower } from './sources/power.js';
import { watchBluetooth } from './sources/bluetooth.js';
import { watchTimers } from './sources/timers.js';
import { watchRecording, stopRecording } from './sources/recording.js';
import { watchCalendar } from './sources/calendar.js';
import { watchDownloads } from './sources/downloads.js';
import { watchCodes } from './sources/codes.js';
import { watchWidgets } from './sources/widgets.js';

const MEDIA_KEY = 'media';
const HIGH_FACTOR = 1.6;     // high-urgency cards stay this much longer than normal ones
const RECENT_LIMIT = 3;      // notifications listed in the Now tab

// Live activity sources, each switched by its own key (and all by notch-live-activities)
const SOURCES = Object.freeze([
    ['battery', 'notch-activity-battery'],
    ['bluetooth', 'notch-activity-bluetooth'],
    ['timers', 'notch-activity-timers'],
    ['recording', 'notch-activity-recording'],
    ['calendar', 'notch-activity-calendar'],
    ['downloads', 'notch-activity-downloads'],
    ['codes', 'notch-copy-codes'],
]);

const nowMs = () => Math.floor(GLib.get_monotonic_time() / 1000);

function mediaInfo(player) {
    return {
        busName: player.busName,
        title: player.trackTitle ?? '',
        artist: (player.trackArtists ?? []).join(', '),
        art: player.trackCoverUrl,
        length: player.length ?? null,
        playing: player.isPlaying(),
        canPrevious: player.canGoPrevious,
        canNext: player.canGoNext,
        canSeek: player.canSeek,
    };
}

export class NotchFeature {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._state = initialState(nowMs());
        this._alive = false;
        this._overFullscreen = false;
        this._deadlineToken = 0;
        this._parts = { sink: null, media: null };
        this._sources = new Map();   // source id -> CleanupRegistry
        this._selected = null;       // the shelf item selected in the Tray tab
        this._events = null;         // today's calendar events for the Widgets tab
        this._watch = null;
    }

    enable() {
        const { settings, gettext } = this._ctx;
        const cleanup = this._cleanup;
        this._alive = true;
        cleanup.add(() => this._teardown());

        const ks = this._ks = new GuavaSettings(settings);
        ks.attach(cleanup);

        this._notifications = new Map();       // id -> Notification
        this._notificationIds = new WeakMap();  // Notification -> id
        this._notificationSignals = new Map();  // Notification -> handler id
        this._shown = new Set();                // ids that have been on screen
        this._nextId = 1;
        cleanup.add(() => this._forgetNotifications());

        this._view = new NotchView(cleanup, {
            onClick: () => this._dispatch({ type: 'click' }),
            onExpand: () => this._dispatch({ type: 'expand' }),
            onTab: tab => this._dispatch({ type: 'tab', tab }),
            onActivityAction: (activity, id) => this._activityAction(activity, id),
            onShelf: (action, uri) => this._shelfAction(action, uri),
            isShelfHelperWindow: window => !!this._shelfHelper?.isHelperWindow(window),
            onShelfLayout: layout => (layout ? this._shelfHelper?.show(layout.box, layout.tiles) : this._shelfHelper?.hide()),
            onTimerPreset: minutes => this._ctx.timers?.startTimer({ seconds: minutes * 60, label: this._ctx.gettext('Timer') }),
            onToggleMic: () => this._widgets?.toggleMic(),
            onOpenWeather: () => {
                this._dispatch({ type: 'collapse' });
                this._widgets?.openWeather();
            },
            onOpenCalendar: () => this._openApp(['org.gnome.Calendar.desktop']),
            onDismiss: () => this._dispatch({ type: 'dismiss' }),
            onHover: value => this._dispatch({ type: 'hover', value }),
            onAction: (id, index) => this._action(id, index),
            onMedia: command => this._media(command),
            onSeek: fraction => this._seek(fraction),
            onCopy: id => {
                const service = this._ctx.features.instance('clipboard-history');
                const entry = service?.get(id);
                if (entry)
                    service.copy(entry);
            },
            onToggleDnd: () => NotificationRouter.setDnd(!NotificationRouter.state().dnd),
            onCollapse: () => this._dispatch({ type: 'collapse' }),
            onOpenNotification: notification => this._openNotification(notification),
            onOpenList: () => this._openMessageList(),
            getPosition: () => this._bestPlayer()?.position ?? Promise.resolve(null),
        }, gettext, this._ctx.motion);
        const syncHover = () => this._view.setHoverIntent({
            enabled: ks.bool('notch-hover-expand'), delayMs: ks.int('notch-hover-delay'),
        });
        ks.watch(['notch-hover-expand', 'notch-hover-delay'], syncHover);
        syncHover();

        this._shelf = new Shelf(cleanup, ks, () => this._sync());
        // Dragging a tile out of the shelf: the helper (if installed) puts a window over the tiles
        this._shelfHelper = new ShelfHelper(cleanup, {
            onClick: uri => this._shelfAction(uri === this._selected ? 'open' : 'select', uri),
            onHover: on => this._view.setHelperHover(on),
            onDrag: on => this._view.setDragging(on),
            onActive: on => this._view.setShelfDrag(on),
        });
        this._widgets = watchWidgets(cleanup, () => this._sync());
        // Files dragged from apps onto the notch land on the shelf (drop.js explains how)
        watchDrops(cleanup, {
            zone: () => {
                const a = this._view.actor;
                const monitor = Main.layoutManager.primaryMonitor;
                if (!monitor || !a.visible)
                    return null;
                const [x, y] = a.get_transformed_position();
                return dropZone({ x, y, w: a.width, h: a.height }, monitor);
            },
            onOver: over => this._dispatch({ type: 'drag-over', value: over }),
            onDrop: uris => {
                this._shelf?.add(uris);
                this._dispatch({ type: 'drag-over', value: false, dropped: true });
            },
        });
        cleanup.add(() => {
            this._widgets = null;
            this._shelf = null;
            this._shelfHelper = null;
        });

        // Room in the centre of the bar so the clock and others keep clear of the pill
        PanelLayout.claim(cleanup, { id: 'notch', actor: this._view.placeholder, box: 'center' });

        // Shared inputs
        NotificationRouter.connect(cleanup, () => this._syncExternal());
        // The active Focus mode's icon (features/focus) shows on the Widgets tab's Focus toggle
        this._ctx.events.on('focus-changed', () => this._sync(), cleanup);
        cleanup.connect(global.display, 'in-fullscreen-changed', () => this._syncExternal());
        // The overview shows the helper's window among the real ones: close the dashboard (and so the helper) first
        cleanup.connect(Main.overview, 'showing', () => this._dispatch({ type: 'collapse' }));
        this._syncExternal(true);

        // The clipboard feature can start or stop after the notch
        this._clipSvc = null;
        this._clipOff = [];
        ks.watch('notch-show-clipboard', () => this._sync());
        this._ctx.events.on('feature-changed', ({ id }) => {
            if (id === 'clipboard-history')
                this._syncClipboard();
        }, cleanup);
        cleanup.add(() => this._dropClipboard());
        this._syncClipboard();

        // The three features can be switched one by one
        // Each part has its own registry, so switching one never touches the others.
        this._applySink();
        this._applyMedia();
        this._ctx.osd.setSink(cleanup, 'notch', osd => this._showOsd(osd));
        const part = (key, apply) => ks.watch(key, () => {
            apply();
            this._dispatch({ type: 'set', patch: {} });
        });
        part('notch-notifications', () => this._applySink());
        part('notch-live-activities', () => {
            this._applyMedia();
            this._applySources();
        });
        for (const [, key] of SOURCES)
            ks.watch(key, () => this._applySources());
        this._applySources();
        // The timeout is read from settings on every event; nothing to rebuild.
        ks.watch('notch-timeout', () => this._dispatch({ type: 'set', patch: {} }));

        // Runs first on dispose (newest first): stop reacting, then give everything back
        cleanup.add(() => this._teardown());
        this._sync();
    }

    // Idempotent. Registered twice: last in enable() (runs first on a normal dispose) and first
    // (runs last), so a throw half-way through enable() still restores banners, OSD and holds.
    _teardown() {
        if (!this._alive && !this._parts.sink && !this._parts.media)
            return;
        // Collect sticky cards first, give the banners back to the stock tray, then queue
        // them there; queued while the sink still existed they would be diverted again.
        const critical = this._notifications ? this._criticalNotifications() : [];
        this._alive = false;
        this._deadlineToken = 0;
        for (const key of ['sink', 'media']) {
            this._parts[key]?.dispose();
            this._parts[key] = null;
        }
        for (const reg of this._sources.values())
            reg.dispose();
        this._sources.clear();
        this._requeue(critical);
        this._watch = null;
        if (this._overFullscreen)
            setUnredirectAllowed(true);
        this._overFullscreen = false;
    }

    disable() {
        // The CleanupRegistry given to the constructor undoes everything, newest first.
    }

    // ---- state ----------------------------------------------------------------------------

    _config() {
        const ks = this._ks;
        const normalMs = Math.max(1, ks.int('notch-timeout')) * 1000;
        return {
            notifications: ks.bool('notch-notifications'),
            activities: ks.bool('notch-live-activities'),
            osd: true,      // what reaches the notch was routed here (core/osd.js); also "Copied"
            normalMs,
            highMs: Math.round(normalMs * HIGH_FACTOR),
        };
    }

    _dispatch(ev) {
        if (!this._alive)
            return;
        const before = this._state.current?.id;
        const pendingBefore = this._state.pending.map(n => n.id);
        const { state, effects } = step(this._state, { now: nowMs(), ...ev }, this._config());
        this._state = state;
        // A card that ran out of time (not clicked, not dismissed, not waiting in the queue)
        if (ev.type === 'tick' && before !== undefined && state.current?.id !== before &&
            !state.pending.some(n => n.id === before))
            this._expire(before);
        // Queued cards pruned by the queue cap or by DnD / fullscreen never get their turn.
        // Only ones that were already on screen expire; never-shown ones keep their place in
        // the message list as the stock tray would.
        if (ev.type !== 'notify-removed') {
            for (const id of pendingBefore) {
                if (id !== state.current?.id && !state.pending.some(n => n.id === id) &&
                    this._shown.has(id))
                    this._expire(id);
            }
        }
        for (const effect of effects)
            this._run(effect);
        this._sync();
    }

    _run(effect) {
        const notification = this._notifications.get(effect.id);
        if (!notification)
            return;
        try {
            if (effect.type === 'activate')
                notification.activate();
            else if (effect.type === 'dismiss')
                notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        } catch (e) {
            console.error('[Guava] notch notification action failed:', e);
        }
    }

    // Transient notifications leave the message list once their banner time is over
    _expire(id) {
        const notification = this._notifications.get(id);
        if (!notification?.isTransient)
            return;
        try {
            notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
        } catch (e) {
            console.error('[Guava] notch could not expire a notification:', e);
        }
    }

    _action(id, index) {
        const notification = this._notifications.get(id);
        const action = notification?.actions?.[index];
        if (!action)
            return;
        // Running the action destroys a non-resident notification; the destroy signal
        // takes the card off the screen.
        try {
            action.activate();
        } catch (e) {
            console.error('[Guava] notch action failed:', e);
        }
        if (this._notifications.has(id))
            this._dispatch({ type: 'notify-removed', id });
    }

    // Inputs that come from outside: Do Not Disturb and fullscreen
    _syncExternal(initial = false) {
        const patch = {
            dnd: NotificationRouter.state().dnd,
            fullscreen: Main.layoutManager.primaryMonitor?.inFullscreen ?? false,
        };
        if (initial) {
            this._state = { ...this._state, ...patch };
            return;
        }
        this._dispatch({ type: 'set', patch });
    }

    // Draw, move the clock for the next deadline, hold the bar
    _sync() {
        if (!this._alive)
            return;
        const state = this._state;
        const vm = view(state);
        const wants = wantsBar(state);
        const fullscreen = state.fullscreen;

        const media = this._bestPlayer();
        const notification = vm.notificationId === null ? null : this._notifications.get(vm.notificationId) ?? null;
        if (notification)
            this._shown.add(vm.notificationId);
        const dashboard = vm.content === 'dashboard';
        this._view.render(vm, {
            notification,
            media: media && showsActivity(media.status) ? { ...mediaInfo(media), appIcon: media.app?.get_icon() ?? null } : null,
            dnd: state.dnd,
            count: NotificationRouter.state().count,
            recent: dashboard ? this._recentNotifications() : null,
            clipboard: dashboard ? this._clipboardEntries() : null,
            shelf: this._shelf,
            selected: this._selected,
            widgets: dashboard ? {
                events: this._events,
                weather: this._widgets?.weather() ?? null,
                mic: this._widgets?.mic() ?? { available: false, muted: false },
                dnd: state.dnd,
                focus: this._ctx.features.instance('focus')?.state() ?? null,
                timersEnabled: !!this._ctx.timers && this._ks.bool('notch-activity-timers'),
            } : null,
        });

        // Only the pill over a fullscreen window; no bar there.
        this._view.setShown(wants || !fullscreen);
        // A pill drawn over a fullscreen window needs the compositor to stop direct scanout
        const overFullscreen = wants && fullscreen;
        if (overFullscreen !== this._overFullscreen) {
            this._overFullscreen = overFullscreen;
            setUnredirectAllowed(!overFullscreen);
        }

        this._schedule(nextDeadline(state));
    }

    _schedule(deadline) {
        if (this._deadlineToken) {
            this._cleanup.release(this._deadlineToken);
            this._deadlineToken = 0;
        }
        if (deadline === null)
            return;
        const wait = Math.max(1, deadline - nowMs());
        this._deadlineToken = this._cleanup.timeout(wait, () => {
            this._deadlineToken = 0;
            this._dispatch({ type: 'tick' });
            return GLib.SOURCE_REMOVE;
        }, { name: 'notch deadline' });
    }

    // ---- banners ---------------------------------------------------------------------------

    _present(notification) {
        let id = this._notificationIds.get(notification);
        if (id === undefined) {
            id = this._nextId++;
            this._notificationIds.set(notification, id);
            this._notificationSignals.set(notification, notification.connect('destroy', () => {
                this._notificationSignals.delete(notification);
                this._notifications.delete(id);
                this._shown.delete(id);
                this._dispatch({ type: 'notify-removed', id });
            }));
        }
        this._notifications.set(id, notification);
        this._dispatch({
            type: 'notify',
            id,
            urgency: notification.urgency,
            forFeedback: !!notification.forFeedback,
        });
    }

    _forgetNotifications() {
        for (const [notification, handlerId] of this._notificationSignals) {
            try {
                notification.disconnect(handlerId);
            } catch (_e) {
                // Destroyed already.
            }
        }
        this._notificationSignals.clear();
        this._notifications.clear();
    }

    // ---- parts that can be switched on and off ----------------------------------------------

    // A critical card is sticky; if the notch stops taking banners it must not vanish with it.
    _criticalNotifications() {
        const { current, pending } = this._state;
        const list = [];
        for (const entry of [current, ...pending]) {
            if (!entry || entry.urgency < URGENCY.CRITICAL)
                continue;
            const notification = this._notifications.get(entry.id);
            if (notification)
                list.push(notification);
        }
        return list;
    }

    // Call only after the banner sink is released, so the stock tray takes them.
    _requeue(notifications) {
        if (!notifications.length)
            return;
        // Oldest last, so the head of the queue ends up as the one that was on screen
        for (const notification of [...notifications].reverse())
            requeueBanner(Main.messageTray, notification);
        kickTray(Main.messageTray);
    }

    // Replace one part's registry; returns the fresh one
    _renew(key) {
        this._parts[key]?.dispose();
        this._parts[key] = new CleanupRegistry();
        return this._parts[key];
    }

    _applySink() {
        const critical = this._ks.bool('notch-notifications') ? [] : this._criticalNotifications();
        const parts = this._renew('sink');
        if (this._ks.bool('notch-notifications'))
            NotificationRouter.setBannerSink(parts, { present: n => this._present(n) });
        this._requeue(critical);
    }

    // A volume / brightness change that core/osd.js routed here. The notch lives on the primary
    // monitor, where the router only looks.
    _showOsd({ icon, label, level, maxLevel }) {
        this._dispatch({
            type: 'osd',
            icon,
            label,
            level: Number.isFinite(level) && level >= 0 ? level : null,
            maxLevel: Number.isFinite(maxLevel) && maxLevel > 0 ? maxLevel : null,
        });
    }

    _applyMedia() {
        const parts = this._renew('media');
        this._watch = null;
        if (this._ks.bool('notch-live-activities')) {
            this._watch = MprisWatcher.acquire(parts, this._ctx.gettext);
            this._playerSignals = new Map();
            this._playedAt = new Map();         // Player -> when it last started playing
            const track = player => {
                if (this._playerSignals.has(player))
                    return;
                this._playerSignals.set(player, player.connect('changed', () => this._syncMedia()));
            };
            this._watch.on('player-added', player => {
                track(player);
                this._syncMedia();
            });
            this._watch.on('player-removed', player => {
                const id = this._playerSignals.get(player);
                if (id !== undefined)
                    player.disconnect(id);
                this._playerSignals.delete(player);
                this._playedAt?.delete(player);
                this._syncMedia();
            });
            this._watch.players.forEach(track);
            parts.add(() => {
                for (const [player, id] of this._playerSignals ?? []) {
                    try {
                        player.disconnect(id);
                    } catch (_e) {
                        // The player is gone.
                    }
                }
                this._playerSignals = null;
                this._playedAt = null;
                this._watch = null;
            });
            this._syncMedia();
        }
    }

    // What the calendar's message list holds, newest first
    _recentNotifications() {
        const entries = [];
        for (const source of Main.messageTray.getSources()) {
            for (const notification of source.notifications ?? []) {
                const datetime = notification.datetime ?? null;
                entries.push({
                    notification,
                    title: notification.title ?? '',
                    body: notification.body ?? '',
                    markup: !!notification.useBodyMarkup,
                    app: source.title ?? '',
                    when: datetime?.format?.('%H:%M') ?? '',
                    time: datetime?.to_unix?.() ?? null,
                    gicon: notification.gicon ?? source.icon ?? null,
                });
            }
        }
        return recentNotifications(entries, RECENT_LIMIT);
    }

    _openNotification(notification) {
        this._dispatch({ type: 'collapse' });
        try {
            notification?.activate();
        } catch (e) {
            console.error('[Guava] notch could not open a notification:', e);
        }
    }

    // The full list: in Quick Settings while the notch is on (calendarRight), else the
    // calendar menu.
    _openMessageList() {
        this._dispatch({ type: 'collapse' });
        const area = Main.panel.statusArea;
        const menu = area.quickSettings?.menu ?? area.dateMenu?.menu;
        try {
            menu?.open();
        } catch (e) {
            console.error('[Guava] notch could not open the message list:', e);
        }
    }

    // ---- clipboard -------------------------------------------------------------------------

    _dropClipboard() {
        this._clipOff?.forEach(off => off());
        this._clipOff = [];
        this._clipSvc = null;
    }

    // Follow the clipboard service as it appears and disappears
    _syncClipboard() {
        if (!this._alive)
            return;
        const service = this._ctx.features.instance('clipboard-history');
        if (service === this._clipSvc)
            return;
        this._dropClipboard();
        this._clipSvc = service;
        if (service) {
            this._clipOff = [
                service.connectChanged(() => this._sync()),
                service.connectCopied(() => this._dispatch({
                    type: 'confirm', kind: 'copied', label: this._ctx.gettext('Copied'),
                })),
            ];
        }
        this._sync();
    }

    _clipboardEntries() {
        if (!this._clipSvc || !this._ks.bool('notch-show-clipboard'))
            return null;
        return this._clipSvc.latest(3).map(e => ({
            id: e.id,
            text: e.kind === 'image' ? this._ctx.gettext('Image') : String(e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        }));
    }

    // ---- live activity sources -------------------------------------------------------------

    _applySources() {
        if (!this._alive)
            return;
        const all = this._ks.bool('notch-live-activities');
        const sink = {
            activity: (key, kind, data, opts = {}) => this._dispatch({
                type: 'activity', key, kind, data: data ?? null, fresh: !!opts.fresh,
            }),
            events: list => {
                this._events = list;
                this._sync();
            },
        };
        for (const [id, key] of SOURCES) {
            const want = all && this._ks.bool(key) && (id !== 'timers' || !!this._ctx.timers);
            const running = this._sources.get(id);
            if (want === !!running)
                continue;
            if (running) {
                this._sources.delete(id);
                running.dispose();
                if (id === 'calendar')
                    this._events = null;
                continue;
            }
            const reg = new CleanupRegistry();
            this._sources.set(id, reg);
            try {
                this._startSource(id, reg, sink);
            } catch (e) {
                console.error(`[Guava] notch: the ${id} activity failed to start:`, e);
            }
        }
    }

    _startSource(id, reg, sink) {
        const { events, timers, gettext } = this._ctx;
        switch (id) {
        case 'battery': watchPower(reg, sink); break;
        case 'bluetooth': watchBluetooth(reg, sink); break;
        case 'timers': watchTimers(reg, { events, timers }, sink, gettext); break;
        case 'recording': watchRecording(reg, events, sink); break;
        case 'calendar': watchCalendar(reg, sink); break;
        case 'downloads':
            watchDownloads(reg, sink, uri => {
                if (this._ks.bool('notch-shelf-downloads'))
                    this._shelf?.add([uri]);
            });
            break;
        case 'codes': watchCodes(reg, sink); break;
        }
    }

    _activityAction(activity, id) {
        const d = activity.data ?? {};
        const timers = this._ctx.timers;
        switch (id) {
        case 'copy':
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, d.code);
            this._dispatch({ type: 'activity', key: activity.key, kind: activity.kind, data: null });
            this._dispatch({ type: 'confirm', kind: 'copied', label: this._ctx.gettext('Code copied') });
            break;
        case 'stop': stopRecording(); break;
        case 'pause': timers?.pause(d.id); break;
        case 'resume': timers?.resume(d.id); break;
        case 'cancel': timers?.cancel(d.id); break;
        }
    }

    _shelfAction(action, uri) {
        const shelf = this._shelf;
        if (!shelf)
            return;
        switch (action) {
        case 'select':
            this._selected = uri;
            this._sync();
            break;
        case 'open':
            this._dispatch({ type: 'collapse' });
            shelf.open(uri);
            break;
        case 'reveal':
            this._dispatch({ type: 'collapse' });
            shelf.reveal(uri);
            break;
        case 'copy':
            shelf.copy(uri);
            this._dispatch({ type: 'confirm', kind: 'copied', label: this._ctx.gettext('Copied') });
            break;
        case 'remove':
            this._selected = null;
            shelf.remove(uri);
            break;
        case 'clear':
            this._selected = null;
            shelf.clear();
            break;
        case 'add-clipboard':
            shelf.addFromClipboard().catch(e => console.error('[Guava] notch shelf:', e));
            break;
        }
    }

    _openApp(ids) {
        this._dispatch({ type: 'collapse' });
        const system = Shell.AppSystem.get_default();
        const app = ids.map(id => system.lookup_app(id)).find(Boolean);
        app?.activate();
    }

    // ---- media -----------------------------------------------------------------------------

    // The player to show: playing beats paused beats stopped; among two playing, the one
    // that started last (see lib/mprisModel.js).
    _bestPlayer() {
        const players = this._watch?.players ?? [];
        return pickPlayer(players.map(p => ({
            status: p.status, since: this._playedAt?.get(p) ?? null, item: p,
        })));
    }

    // Remember when each player went to Playing, so a player that starts takes over.
    _notePlaying() {
        if (!this._playedAt)
            return;
        for (const p of this._watch?.players ?? []) {
            if (!p.isPlaying())
                this._playedAt.delete(p);
            else if (!this._playedAt.has(p))
                this._playedAt.set(p, nowMs());
        }
    }

    _syncMedia() {
        if (!this._alive)
            return;
        this._notePlaying();
        // A paused player keeps its pill, with the waveform at rest; a stopped one leaves.
        const best = this._bestPlayer();
        const data = best && showsActivity(best.status) ? mediaInfo(best) : null;
        this._dispatch({
            type: 'activity',
            key: MEDIA_KEY,
            kind: data?.playing ? 'media' : 'media-paused',
            data,
        });
    }

    _seek(fraction) {
        const player = this._bestPlayer();
        const target = player?.canSeek ? seekTarget(fraction, player.length) : null;
        if (target !== null)
            player.seek(target).catch(() => {});
    }

    _media(command) {
        const player = this._bestPlayer();
        if (!player)
            return;
        if (command === 'previous')
            player.previous();
        else if (command === 'next')
            player.next();
        else
            player.playPause();
    }
}
