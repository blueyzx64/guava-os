// SPDX-License-Identifier: GPL-3.0-or-later
// Appearance (registry id 'appearance', always running; each part has its own key):
// - Auto Light/Dark (appearance-auto): Light by day, Dark by night, by sunrise and sunset or
//   by two custom times. It switches only once the user has been idle for a minute (macOS
//   never flips the look mid-work); turning Auto on, logging in and unlocking apply at once.
//   GNOME's color-scheme is owned through core/originals (the user's value comes back when Auto
//   goes off, even after a crash). Choosing a style yourself turns Auto off. Night Theme
//   Switcher does the same job: while it runs, Auto stays out of its way.
// - Accent (appearance-accent): Multicolor, the macOS default, follows GNOME's accent and
//   writes nothing; a colour owns GNOME's accent-color (Guava's surfaces all draw with
//   -st-accent-color). Picking an accent in GNOME Settings sets this back to Multicolor.
// - Highlight (appearance-highlight): the text selection colour in Guava's glass search fields,
//   a class on the UI group (styles/base.css).
// Location for the sun schedule: the last position GNOME's Night Light saw, else the time
// zone's city (zone1970.tab), else 07:00 / 19:00.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import { getLoginManager } from 'resource:///org/gnome/shell/misc/loginManager.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { GuavaSettings } from '../../lib/settings.js';
import { SettingOwner } from '../../core/originals.js';
import {
    IDLE_BEFORE_SWITCH_MS, NIGHT_THEME_SWITCHER_UUID, gnomeAccent, highlightClass, plan,
    validCoords, zoneCoords,
} from './model.js';

const IFACE_SCHEMA = 'org.gnome.desktop.interface';
const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
const ZONE_TABS = ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab'];
/** Custom times used when no location is known (minutes after midnight). */
const FALLBACK = { lightMinute: 7 * 60, darkMinute: 19 * 60 };
const AUTO_KEYS = ['appearance-auto', 'appearance-auto-schedule',
    'appearance-auto-light-minute', 'appearance-auto-dark-minute'];
const HIGHLIGHT_CLASS = 'guava-highlight';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

export class Appearance {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ks = null;
        this._iface = null;
        this._auto = null;      // CleanupRegistry of the running Auto part
        this._owner = null;     // SettingOwner of color-scheme while Auto runs
        this._scheme = null;    // the scheme Auto wants now
        this._coords = null;    // [lat, lon] for the sun schedule, null when unknown
        this._timer = 0;        // token of the wait for the next sunrise/sunset
        this._idleMonitor = null;
        this._idleWatch = 0;
        this._accent = null;    // {owner, value} while Guava owns accent-color
        this._highlight = null; // class on the UI group
    }

    enable() {
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(cleanup);
        this._ks = ks;
        this._iface = new Gio.Settings({ schema_id: IFACE_SCHEMA });

        ks.watch(AUTO_KEYS, () => this._syncAuto());
        cleanup.connect(Main.extensionManager, 'extension-state-changed', (_m, ext) => {
            if (ext?.uuid === NIGHT_THEME_SWITCHER_UUID)
                this._syncAuto();
        });
        cleanup.add(() => this._stopAuto());
        this._syncAuto();

        ks.watch(['appearance-accent'], () => this._syncAccent());
        cleanup.add(() => this._releaseAccent());
        this._syncAccent();

        ks.watch(['appearance-highlight'], () => this._syncHighlight());
        cleanup.add(() => this._setHighlight(null));
        this._syncHighlight();
    }

    disable() {
        // The cleanup registry gives back color-scheme and accent-color and drops the class
    }

    // ---- Auto Light/Dark ---------------------------------------------------------------

    _nightThemeSwitcherRuns() {
        return Main.extensionManager.lookup(NIGHT_THEME_SWITCHER_UUID)?.state === ExtensionState.ACTIVE;
    }

    _syncAuto() {
        const want = this._ks.bool('appearance-auto') && !this._nightThemeSwitcherRuns();
        if (!want) {
            this._stopAuto();
            return;
        }
        if (this._auto) {
            // A schedule change: re-plan and apply at once, the user is in the settings
            this._replan(true);
            return;
        }
        this._startAuto();
    }

    _startAuto() {
        const reg = new CleanupRegistry();
        this._auto = reg;
        this._scheme = null;
        this._timer = 0;
        this._coords = null;
        this._owner = new SettingOwner(this._ctx.originals, this._iface, 'color-scheme', {
            type: 's',
            transform: () => this._scheme,
            yieldToUser: true,
            // The user picked Light or Dark: Auto goes off, like choosing it on macOS
            onOriginalChanged: () => this._ks.setBool('appearance-auto', false),
        });
        reg.add(() => {
            this._cancelIdle();
            this._owner.release();
            this._owner = null;
        });

        // Back from suspend the timer is late (it does not count sleep): re-plan
        const lm = getLoginManager();
        reg.connect(lm, 'prepare-for-sleep', (_lm, aboutToSuspend) => {
            if (!aboutToSuspend)
                this._replan(false);
        });

        const cancellable = new Gio.Cancellable();
        reg.add(() => cancellable.cancel());
        this._locate(cancellable).then(coords => {
            if (cancellable.is_cancelled())
                return;
            this._coords = coords;
            this._replan(true);
        }).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('[Guava] Auto appearance: no location:', e);
        });
    }

    _stopAuto() {
        const reg = this._auto;
        this._auto = null;
        reg?.dispose();
    }

    /** Night Light's last position, else the time zone's city, else null. */
    async _locate(cancellable) {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(COLOR_SCHEMA, true);
        if (schema?.has_key('night-light-last-coordinates')) {
            const c = new Gio.Settings({ schema_id: COLOR_SCHEMA })
                .get_value('night-light-last-coordinates').deepUnpack();
            if (validCoords(c))
                return c;
        }
        const zone = GLib.TimeZone.new_local().get_identifier();
        for (const path of ZONE_TABS) {
            try {
                const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
                const c = zoneCoords(new TextDecoder().decode(bytes), zone);
                if (c)
                    return c;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            }
        }
        return null;
    }

    _schedule() {
        if (this._ks.string('appearance-auto-schedule') === 'custom') {
            return {
                kind: 'custom',
                lightMinute: this._ks.int('appearance-auto-light-minute'),
                darkMinute: this._ks.int('appearance-auto-dark-minute'),
            };
        }
        return this._coords ? { kind: 'sun', lat: this._coords[0], lon: this._coords[1] }
            : { kind: 'custom', ...FALLBACK };
    }

    /** Work out the phase; apply it now, or at the next idle moment; wait for the next change. */
    _replan(now) {
        const reg = this._auto;
        if (!reg || !this._owner)
            return;
        const p = plan(Date.now(), this._schedule());
        if (now || this._scheme === null)
            this._apply(p.scheme);
        else if (p.scheme !== this._scheme)
            this._applyWhenIdle(p.scheme);

        if (this._timer)
            reg.release(this._timer);
        this._timer = 0;
        if (p.next !== null) {
            // One second past the boundary, so the next plan lands in the new phase
            const ms = Math.max(1000, p.next - Date.now() + 1000);
            this._timer = reg.timeout(ms, () => {
                this._timer = 0;
                this._replan(false);
            }, { name: 'guava-auto-appearance' });
        }
    }

    _apply(scheme) {
        this._cancelIdle();
        this._scheme = scheme;
        if (this._owner.owning)
            this._owner.reapply();
        else
            this._owner.sync(true);
    }

    _applyWhenIdle(scheme) {
        this._cancelIdle();
        const monitor = global.backend.get_core_idle_monitor();
        if (monitor.get_idletime() >= IDLE_BEFORE_SWITCH_MS) {
            this._apply(scheme);
            return;
        }
        this._idleMonitor = monitor;
        this._idleWatch = monitor.add_idle_watch(IDLE_BEFORE_SWITCH_MS, () => {
            if (this._auto && this._owner)
                this._apply(scheme);
        });
    }

    _cancelIdle() {
        if (this._idleWatch)
            this._idleMonitor.remove_watch(this._idleWatch);
        this._idleWatch = 0;
        this._idleMonitor = null;
    }

    // ---- accent ------------------------------------------------------------------------

    _syncAccent() {
        const value = this._iface.settings_schema.has_key('accent-color')
            ? gnomeAccent(this._ks.string('appearance-accent')) : null;
        if (!value) {
            this._releaseAccent();
            return;
        }
        if (this._accent) {
            this._accent.value = value;
            this._accent.owner.reapply();
            return;
        }
        const state = { value, owner: null };
        state.owner = new SettingOwner(this._ctx.originals, this._iface, 'accent-color', {
            type: 's',
            transform: () => state.value,
            yieldToUser: true,
            // An accent picked in GNOME Settings wins: Guava follows it again (Multicolor)
            onOriginalChanged: () => {
                this._accent = null;
                this._ks.setString('appearance-accent', 'multicolor');
            },
        });
        this._accent = state;
        state.owner.sync(true);
    }

    _releaseAccent() {
        const state = this._accent;
        this._accent = null;
        state?.owner.release();
    }

    // ---- highlight -----------------------------------------------------------------------

    _syncHighlight() {
        this._setHighlight(highlightClass(this._ks.string('appearance-highlight')));
    }

    _setHighlight(name) {
        const group = Main.uiGroup;
        if (this._highlight === name)
            return;
        if (this._highlight) {
            group.remove_style_class_name(this._highlight);
            group.remove_style_class_name(HIGHLIGHT_CLASS);
        }
        this._highlight = name;
        if (name) {
            group.add_style_class_name(HIGHLIGHT_CLASS);
            group.add_style_class_name(name);
        }
    }
}
