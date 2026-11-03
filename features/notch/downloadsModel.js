// SPDX-License-Identifier: GPL-3.0-or-later
// Which downloads the notch shows, and when they go. Pure: no gi:// imports, no clocks; the
// caller passes `now` (monotonic ms). Fed by sources/downloads.js, tested by
// tests/notchDownloadsModel.test.js.
//
// Two inputs:
//   - LauncherEntry progress bars (com.canonical.Unity.LauncherEntry Update). Updates merge,
//     as the spec says: a bar shows only while progress-visible is true. Each bar remembers
//     the D-Bus name that sent it; when that name leaves the bus (the browser was closed or
//     crashed) the bar goes.
//   - partial files in Downloads (.part, .crdownload, ...), shown while they grow.
//
// Expiry: an app that cancels a download without hiding its bar, or a partial file an
// interrupted download left behind, would otherwise stay in the notch for ever (and come
// back at every login: B8). Anything that has not moved for STALE_MS goes dormant: hidden,
// and a partial file is no longer polled for its size. Moving again (new progress, the file
// grows or is written to) brings it back. A partial file older than STALE_MS when first seen
// starts dormant.

import { downloadSummary } from './model.js';

export const STALE_MS = 5 * 60 * 1000;

const appLabel = uri => uri.replace(/^application:\/\//, '').replace(/\.desktop$/, '');

export class DownloadTracker {
    constructor({ staleMs = STALE_MS } = {}) {
        this._staleMs = staleMs;
        this._apps = new Map();      // app uri -> {sender, progress, visible, at, stale}
        this._partials = new Map();  // file name -> {bytes, at, stale}
    }

    /**
     * A LauncherEntry Update.
     * @param {?string} sender the unique bus name
     * @param {string} uri application://...
     * @param {object} props unpacked a{sv}
     * @returns {boolean} whether what the notch shows may have changed
     */
    appUpdate(sender, uri, props, now) {
        if (typeof uri !== 'string' || !uri.startsWith('application://'))
            return false;
        const old = this._apps.get(uri);
        const progress = Number(props?.['progress']);
        const next = {
            sender: sender ?? old?.sender ?? null,
            progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : old?.progress ?? null,
            visible: typeof props?.['progress-visible'] === 'boolean' ? props['progress-visible'] : old?.visible ?? false,
            at: old?.at ?? now,
            stale: old?.stale ?? false,
        };
        const moved = !old || next.progress !== old.progress || next.visible !== old.visible;
        if (moved) {
            next.at = now;
            next.stale = false;
        }
        if (!old && next.progress === null && !next.visible)
            return false;   // a badge-only app (count, urgent): not a download
        this._apps.set(uri, next);
        return moved && (next.visible || !!old?.visible);
    }

    /** The bus name left: its bars go. @returns {boolean} changed */
    senderGone(sender) {
        let changed = false;
        for (const [uri, a] of this._apps) {
            if (a.sender === sender) {
                changed ||= a.visible && !a.stale;
                this._apps.delete(uri);
            }
        }
        return changed;
    }

    /** The bus names holding bars (to watch for them leaving). */
    senders() {
        return [...new Set([...this._apps.values()].map(a => a.sender).filter(Boolean))];
    }

    /**
     * A partial file appeared or was written to.
     * @param {number} [ageMs] how long ago it was last modified (at login: its mtime)
     * @returns {boolean} changed
     */
    partialSeen(name, bytes, now, ageMs = 0) {
        const old = this._partials.get(name);
        const at = now - Math.max(0, ageMs);
        const stale = now - at >= this._staleMs;
        const size = Number.isFinite(bytes) ? bytes : old?.bytes ?? 0;
        this._partials.set(name, { bytes: size, at, stale });
        return !stale && (!old || old.stale || old.bytes !== size);
    }

    /** A size read for a known partial file; it counts as progress only when it differs. */
    partialSize(name, bytes, now) {
        const old = this._partials.get(name);
        if (!old || old.bytes === bytes)
            return false;
        this._partials.set(name, { bytes, at: now, stale: false });
        return true;
    }

    /** Removed or renamed. @returns {boolean} whether it was known (a rename = finished) */
    partialGone(name) {
        return this._partials.delete(name);
    }

    /** Partial files whose size is worth polling. */
    livePartials() {
        return [...this._partials].filter(([, p]) => !p.stale).map(([name]) => name);
    }

    /** Put what has not moved for staleMs to sleep. @returns {boolean} changed */
    prune(now) {
        let changed = false;
        for (const map of [this._apps, this._partials]) {
            for (const e of map.values()) {
                if (!e.stale && now - e.at >= this._staleMs) {
                    e.stale = true;
                    changed ||= map === this._partials || e.visible;
                }
            }
        }
        return changed;
    }

    /** When the next live entry goes stale, or null. */
    nextExpiry() {
        let t = null;
        for (const map of [this._apps, this._partials]) {
            for (const e of map.values()) {
                if (!e.stale && (map === this._partials || e.visible) && (t === null || e.at + this._staleMs < t))
                    t = e.at + this._staleMs;
            }
        }
        return t;
    }

    /** The notch's download activity data, or null (model.js downloadSummary). */
    summary() {
        const apps = [];
        for (const [uri, a] of this._apps) {
            if (a.visible && !a.stale && a.progress !== null)
                apps.push({ appId: appLabel(uri), progress: a.progress });
        }
        const partials = [];
        for (const [name, p] of this._partials) {
            if (!p.stale)
                partials.push({ name, bytes: p.bytes });
        }
        return downloadSummary(apps, partials);
    }

    clear() {
        this._apps.clear();
        this._partials.clear();
    }
}
