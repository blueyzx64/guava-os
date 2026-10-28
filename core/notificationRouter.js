// SPDX-License-Identifier: GPL-3.0-or-later
// NotificationRouter: the one owner of how notification banners reach the screen.
//
// Stock GNOME shows one banner at a time in Main.messageTray._bannerBin. Before this module
// calendar.js re-aligned that bin, the calendar dot polled the tray every 5 s, and a notch
// would have needed a third copy of the same state. Now:
//
//   import { NotificationRouter } from './notificationRouter.js';
//
//   // Divert banners to your own UI. The stock filters (acknowledged, urgency, DND,
//   // busy, fullscreen) have already run. The notification is already acknowledged and still in
//   // its source, so it stays in the calendar's message list. Last sink registered wins.
//   const h = NotificationRouter.setBannerSink(cleanup, { present(notification) {...} });
//   h.release();                       // also on cleanup.dispose(); stock banners come back
//
//   // Hold back some banners (Focus modes). Runs before any sink and before the stock banner;
//   // a held-back notification is acknowledged and stays in the history, without a sound.
//   NotificationRouter.setBannerFilter(cleanup, notification => true /* show */);
//
//   // Every change of the history (added, removed, sources come and go), for the
//   // Notification Center column. Fires synchronously; coalesce in the listener.
//   NotificationRouter.watchHistory(cleanup, () => ...);
//   NotificationRouter.sources();      // Main.messageTray.getSources()
//
//   // Keep stock banners in the top-right corner (calendar.js, "move calendar right").
//   NotificationRouter.pinBanners(cleanup);
//
//   // Shared model: {count, dnd}. count = notifications in the message list + queued banners.
//   NotificationRouter.connect(cleanup, state => ...);   // only fires when it changes
//   NotificationRouter.state();   NotificationRouter.setDnd(bool);   NotificationRouter.isDiverting();
//
// The service starts with the first user and tears everything down when the last one leaves.
// Private Shell API used (guarded in lib/compat.js): MessageTray._showNotification,
// ._notificationQueue, ._updateState, ._bannerBin.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { CleanupRegistry } from '../lib/disposables.js';
import { takeQueuedBanner, kickTray, canDivertBanners, requeueBanner } from '../lib/compat.js';

const NOTIFICATION_SCHEMA = 'org.gnome.desktop.notifications';

let users = 0;                   // holders of any kind; the service runs while > 0
let service = null;              // {cleanup, settings, last}
const sinks = [];                // newest last
const filters = [];              // allow(notification) -> boolean
const historyListeners = new Set();
const pins = new Set();
let savedBin = null;             // {x_align, y_align, x_expand} captured at the first pin
const listeners = new Set();
let diversion = null;            // CleanupRegistry while _showNotification is patched

function countNotifications() {
    let count = Main.messageTray.queueCount ?? 0;
    for (const source of Main.messageTray.getSources())
        count += source.notifications.length;
    return count;
}

function readState() {
    return {
        count: countNotifications(),
        dnd: service ? !service.settings.get_boolean('show-banners') : false,
    };
}

function emitIfChanged() {
    if (!service)
        return;
    const next = readState();
    const last = service.last;
    if (last && last.count === next.count && last.dnd === next.dnd)
        return;
    service.last = next;
    for (const fn of [...listeners]) {
        try {
            fn(next);
        } catch (e) {
            console.error('[Guava] NotificationRouter listener failed:', e);
        }
    }
}

function historyChanged() {
    emitIfChanged();
    for (const fn of [...historyListeners]) {
        try {
            fn();
        } catch (e) {
            console.error('[Guava] NotificationRouter history listener failed:', e);
        }
    }
}

function watchSource(source) {
    if (service.sources.has(source))
        return;
    service.sources.set(source, [
        source.connect('notification-added', historyChanged),
        source.connect('notification-removed', historyChanged),
    ]);
}

function unwatchSource(source) {
    const ids = service.sources.get(source);
    if (!ids)
        return;
    service.sources.delete(source);
    ids.forEach(id => source.disconnect(id));
}

function startService() {
    const cleanup = new CleanupRegistry();
    service = {
        cleanup,
        settings: new Gio.Settings({ schema_id: NOTIFICATION_SCHEMA }),
        last: null,
        sources: new Map(),
    };
    cleanup.connect(service.settings, 'changed::show-banners', emitIfChanged);
    const tray = Main.messageTray;
    cleanup.connect(tray, 'source-added', (_tray, source) => {
        watchSource(source);
        historyChanged();
    });
    cleanup.connect(tray, 'source-removed', (_tray, source) => {
        unwatchSource(source);
        historyChanged();
    });
    cleanup.connect(tray, 'queue-changed', emitIfChanged);
    tray.getSources().forEach(watchSource);
    const state = service;
    cleanup.add(() => {
        for (const [source, ids] of state.sources) {
            try {
                ids.forEach(id => source.disconnect(id));
            } catch (_e) {
                // The source was finalised already.
            }
        }
        state.sources.clear();
    });
    service.last = readState();
}

function stopService() {
    service.cleanup.dispose();
    service = null;
}

function acquire(cleanup) {
    if (users++ === 0)
        startService();
    let done = false;
    const release = () => {
        if (done)
            return;
        done = true;
        if (--users === 0)
            stopService();
    };
    cleanup?.add(release);
    return release;
}

// --- banner diversion -----------------------------------------------------------------------
function passesFilters(notification) {
    for (const allow of filters) {
        try {
            if (!allow(notification))
                return false;
        } catch (e) {
            console.error('[Guava] banner filter failed:', e);
        }
    }
    return true;
}

// The tray stays HIDDEN after a diverted or held-back banner: give the rest of the queue its turn
function kickRestOfQueue(tray) {
    if (tray._notificationQueue.length > 0) {
        diversion?.idle(() => {
            kickTray(tray);
            return GLib.SOURCE_REMOVE;
        }, { name: 'notification queue' });
    }
}

function installDiversion() {
    if (diversion || !canDivertBanners(Main.messageTray))
        return;
    diversion = new CleanupRegistry();
    diversion.inject(MessageTray.MessageTray.prototype, '_showNotification', function (orig) {
        const next = this._notificationQueue[0];
        if (next && !passesFilters(next)) {
            // Held back (Focus): seen, so it is not queued again, and kept in the history.
            // A transient one would only have lived as a banner: it goes, as after the stock
            // banner (_hideNotificationCompleted).
            takeQueuedBanner(this);
            if (next.isTransient)
                next.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
            else
                next.acknowledged = true;
            kickRestOfQueue(this);
            return undefined;
        }
        const sink = sinks[sinks.length - 1];
        if (!sink)
            return orig.call(this);
        const notification = takeQueuedBanner(this);
        if (!notification)
            return undefined;
        // The stock banner marks the notification as seen; keep the unread count right.
        notification.acknowledged = true;
        try {
            sink.present(notification);
        } catch (e) {
            // The sink is broken: drop it and let the stock banner show this one.
            console.error('[Guava] banner sink failed, back to stock banners:', e);
            const index = sinks.indexOf(sink);
            if (index >= 0)
                sinks.splice(index, 1);
            removeDiversionIfUnused();
            requeueBanner(this, notification);
            // We are inside _updateState(), which ignores re-entry: kick it once it is done.
            service?.cleanup.idle(() => kickTray(Main.messageTray), { name: 'banner fallback' });
            return undefined;
        }
        // The stock banner plays the sound when it shows (_updateShowingNotification, 48-51,
        // unconditionally; policy.enableSound is checked inside playSound()). DnD, busy and
        // fullscreen were already filtered before _showNotification() was called.
        try {
            notification.playSound?.();
        } catch (e) {
            console.error('[Guava] notification sound failed:', e);
        }
        kickRestOfQueue(this);
        return undefined;
    });
}

function removeDiversionIfUnused() {
    if (sinks.length > 0 || filters.length > 0)
        return;
    diversion?.dispose();
    diversion = null;
}

// --- banner position ------------------------------------------------------------------------
function applyPin() {
    const bin = Main.messageTray._bannerBin;
    savedBin ??= { x_align: bin.x_align, y_align: bin.y_align, x_expand: bin.x_expand };
    bin.set_x_expand(true);
    bin.set_x_align(Clutter.ActorAlign.END);
    bin.set_y_align(Clutter.ActorAlign.START);
}

function removePin() {
    if (!savedBin)
        return;
    const bin = Main.messageTray._bannerBin;
    bin.set_x_expand(savedBin.x_expand);
    bin.set_x_align(savedBin.x_align);
    bin.set_y_align(savedBin.y_align);
    savedBin = null;
}

export const NotificationRouter = {
    /**
     * @param {CleanupRegistry} cleanup released on dispose
     * @param {{present: function(Notification): void}} sink
     * @returns {{release: function(): void}}
     */
    setBannerSink(cleanup, sink) {
        const releaseUse = acquire(null);
        sinks.push(sink);
        installDiversion();
        // Anything already queued goes to the new sink.
        kickTray(Main.messageTray);
        let done = false;
        const handle = {
            release() {
                if (done)
                    return;
                done = true;
                const index = sinks.indexOf(sink);
                if (index >= 0)
                    sinks.splice(index, 1);
                removeDiversionIfUnused();
                releaseUse();
                kickTray(Main.messageTray);
            },
        };
        cleanup?.add(() => handle.release());
        return handle;
    },

    /**
     * Hold back banners. Every filter must allow a notification for its banner to show (in the
     * notch or stock); the rest are acknowledged and stay in the history.
     *
     * @param {CleanupRegistry} cleanup released on dispose
     * @param {function(Notification): boolean} allow
     * @returns {{release: function(): void}}
     */
    setBannerFilter(cleanup, allow) {
        const releaseUse = acquire(null);
        filters.push(allow);
        installDiversion();
        let done = false;
        const handle = {
            release() {
                if (done)
                    return;
                done = true;
                const index = filters.indexOf(allow);
                if (index >= 0)
                    filters.splice(index, 1);
                removeDiversionIfUnused();
                releaseUse();
            },
        };
        cleanup?.add(() => handle.release());
        return handle;
    },

    /**
     * @param {CleanupRegistry} cleanup
     * @param {function(): void} fn on every added or removed notification or source
     */
    watchHistory(cleanup, fn) {
        const releaseUse = acquire(null);
        historyListeners.add(fn);
        cleanup?.add(() => {
            historyListeners.delete(fn);
            releaseUse();
        });
    },

    /**
     * The desktop id of the app behind a source ('org.gnome.Calendar.desktop'), or null for
     * senders without one (plain notify-send). Shell 48-51: FdoNotificationDaemonSource.app,
     * GtkNotificationDaemonAppSource._appId (notificationDaemon.js).
     */
    appIdOf(source) {
        const app = source?.app;
        if (app?.get_id)
            return app.get_id();
        return source?._appId ? `${source._appId}.desktop` : null;
    },

    /** @returns {MessageTray.Source[]} the sources of the history (the stock message tray) */
    sources() {
        return Main.messageTray.getSources();
    },

    /** Stock banners at the top-right instead of the top-centre. Restored when the last pin goes. */
    pinBanners(cleanup) {
        const releaseUse = acquire(null);
        const token = {};
        pins.add(token);
        applyPin();
        let done = false;
        const handle = {
            release() {
                if (done)
                    return;
                done = true;
                pins.delete(token);
                if (pins.size === 0)
                    removePin();
                releaseUse();
            },
        };
        cleanup?.add(() => handle.release());
        return handle;
    },

    /**
     * @param {CleanupRegistry} cleanup
     * @param {function({count: number, dnd: boolean}): void} fn runs on every change, not at once
     */
    connect(cleanup, fn) {
        const releaseUse = acquire(null);
        listeners.add(fn);
        cleanup?.add(() => {
            listeners.delete(fn);
            releaseUse();
        });
    },

    /** @returns {{count: number, dnd: boolean}} */
    state() {
        if (service)
            return service.last ?? readState();
        return {
            count: countNotifications(),
            dnd: !new Gio.Settings({ schema_id: NOTIFICATION_SCHEMA }).get_boolean('show-banners'),
        };
    },

    /** Do Not Disturb on or off (the GNOME key org.gnome.desktop.notifications show-banners). */
    setDnd(on) {
        const settings = service?.settings ?? new Gio.Settings({ schema_id: NOTIFICATION_SCHEMA });
        settings.set_boolean('show-banners', !on);
    },

    /** @returns {boolean} a sink is taking the stock banners */
    isDiverting() {
        return sinks.length > 0 && diversion !== null;
    },
};
