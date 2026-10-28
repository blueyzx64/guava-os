// SPDX-License-Identifier: GPL-3.0-or-later
// The controls Guava builds for the customisable Control Center (customModel.js kinds
// 'feature', 'setting' and 'action'). Each is a stock QuickToggle / QuickMenuToggle, so it
// looks and sizes like GNOME's own tiles, and owns a CleanupRegistry disposed with its actor.
//
//   feature:<key>     a Guava feature on/off (bound to its settings key)
//   setting controls  a GNOME setting (accessibility, text size); writing it is the user's
//                     own choice, like GNOME's Dark Style tile, so it is not restored on disable
//   screenshot, screen-recording   GNOME's screenshot UI (ui/screenshot.js)
//   timer             hands the countdown to the notch's timers ('timer-start-requested');
//                     without them, its own countdown with a notification at the end
//   keep-awake        an idle inhibitor (org.gnome.SessionManager.Inhibit), dropped on disable
//   low-power         features/lowPower (Low Power Mode of the power source in use)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import { QuickMenuToggle, QuickToggle } from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { TIMER_MINUTES, control, formatCountdown, settingIsOn, settingValue } from './customModel.js';
import { guavaGicon } from './tiles.js';

const INHIBIT_IDLE = 8;
const APP_ID = 'org.gnome.Shell.Extensions.Guava';
const DEFAULT_TIMER_MINUTES = 5;

const schemaSource = () => Gio.SettingsSchemaSource.get_default();

/**
 * Whether a control can be offered here (its settings key or GNOME schema exists).
 *
 * @param {string} id
 * @param {Gio.Settings} settings Guava's
 */
export function controlAvailable(id, settings) {
    const c = control(id);
    if (!c)
        return false;
    if (c.kind === 'feature')
        return !!settings.settings_schema?.has_key(c.key);
    if (c.kind === 'setting')
        return !!schemaSource()?.lookup(c.binding.schema, true)?.has_key(c.binding.key);
    if (id === 'screen-recording' || id === 'screenshot')
        return !!Main.screenshotUI;
    return true;
}

/**
 * Build one of Guava's controls, or null when it cannot exist here.
 *
 * @param {string} id
 * @param {object} deps
 * @param {object} deps.ctx the feature ctx (settings, gettext, features, events, extension)
 * @param {() => void} deps.closeMenu closes the Control Center (before an action takes the screen)
 * @returns {?QuickToggle}
 */
export function createControl(id, { ctx, closeMenu }) {
    const c = control(id);
    if (!c || !controlAvailable(id, ctx.settings))
        return null;
    const _ = ctx.gettext;
    const reg = new CleanupRegistry();
    const gicon = guavaGicon(c.icon, ctx.extension?.dir);
    const params = { title: _(c.title), gicon };
    let toggle;
    try {
        if (c.kind === 'feature')
            toggle = featureToggle(c, params, ctx, reg);
        else if (c.kind === 'setting')
            toggle = settingToggle(c, params, reg);
        else
            toggle = ACTIONS[id]({ params, ctx, reg, _, closeMenu });
    } catch (e) {
        reg.dispose();
        throw e;
    }
    toggle.accessible_name = params.title;
    toggle.add_style_class_name('guava-cc-own-control');
    toggle.connect('destroy', () => reg.dispose());
    return toggle;
}

function featureToggle(c, params, ctx, reg) {
    const toggle = new QuickToggle({ ...params, toggleMode: true });
    ctx.settings.bind(c.key, toggle, 'checked', Gio.SettingsBindFlags.DEFAULT);
    reg.add(() => {
        try {
            Gio.Settings.unbind(toggle, 'checked');
        } catch (_e) {
            // Unbound with the object
        }
    });
    return toggle;
}

function settingToggle(c, params, reg) {
    const { schema, key } = c.binding;
    const gs = new Gio.Settings({ schema_id: schema });
    const toggle = new QuickToggle(params);
    const read = () => (c.binding.type === 'b' ? gs.get_boolean(key) : gs.get_double(key));
    const sync = () => {
        toggle.checked = settingIsOn(c.binding, read());
    };
    reg.connect(gs, `changed::${key}`, sync);
    reg.connect(toggle, 'clicked', () => {
        const value = settingValue(c.binding, !settingIsOn(c.binding, read()));
        if (c.binding.type === 'b')
            gs.set_boolean(key, value);
        else
            gs.set_double(key, value);
    });
    sync();
    return toggle;
}

// ---- actions ---------------------------------------------------------------------------------

const ACTIONS = {
    'screenshot': ({ params, reg, closeMenu }) => {
        const toggle = new QuickToggle(params);
        reg.connect(toggle, 'clicked', () => {
            closeMenu();
            Screenshot.showScreenshotUI();
        });
        return toggle;
    },

    'screen-recording': ({ params, reg, closeMenu }) => {
        const ui = Main.screenshotUI;
        const toggle = new QuickToggle(params);
        const sync = () => {
            toggle.checked = !!ui.screencast_in_progress;
        };
        reg.connect(ui, 'notify::screencast-in-progress', sync);
        reg.connect(toggle, 'clicked', () => {
            closeMenu();
            if (ui.screencast_in_progress)
                ui.stopScreencast();
            else
                Screenshot.showScreenRecordingUI();
        });
        sync();
        return toggle;
    },

    'timer': ({ params, ctx, reg, _ }) => {
        const toggle = new QuickMenuToggle({ ...params, subtitle: _('Off') });
        let endsAt = 0;
        let tick = 0;
        let minutes = DEFAULT_TIMER_MINUTES;
        const stop = () => {
            if (tick)
                reg.release(tick);
            tick = 0;
            endsAt = 0;
            toggle.checked = false;
            toggle.subtitle = _('%d min').replace('%d', String(minutes));
        };
        const update = () => {
            const left = (endsAt - GLib.get_monotonic_time()) / 1e6;
            if (left <= 0) {
                tick = 0;   // this source ends by returning SOURCE_REMOVE
                stop();
                Main.notify(_('Timer'), _('Time is up.'));
                global.display.get_sound_player?.()?.play_from_theme('complete', _('Timer'), null);
                return GLib.SOURCE_REMOVE;
            }
            toggle.subtitle = formatCountdown(left);
            return GLib.SOURCE_CONTINUE;
        };
        const start = m => {
            // The notch's live activities own timers while they run (core/events.js)
            if (ctx.events.listenerCount('timer-start-requested') > 0) {
                ctx.events.emit('timer-start-requested', { seconds: m * 60, label: _('Timer'), source: 'control-center' });
                return;
            }
            stop();
            minutes = m;
            endsAt = GLib.get_monotonic_time() + m * 60e6;
            toggle.checked = true;
            update();
            tick = reg.timeout(1000, update, { name: 'Control Center timer' });
        };
        toggle.menu.setHeader(params.gicon, _('Timer'));
        for (const m of TIMER_MINUTES) {
            const item = new PopupMenu.PopupMenuItem(m >= 60 ? _('1 hour') : _('%d minutes').replace('%d', String(m)));
            item.connect('activate', () => start(m));
            toggle.menu.addMenuItem(item);
        }
        reg.connect(toggle, 'clicked', () => (endsAt ? stop() : start(minutes)));
        stop();
        return toggle;
    },

    'keep-awake': ({ params, reg, _ }) => {
        const toggle = new QuickToggle({ ...params, subtitle: null });
        let cookie = 0;
        let pending = false;
        let gone = false;
        const call = (method, args, type, done) => Gio.DBus.session.call('org.gnome.SessionManager',
            '/org/gnome/SessionManager', 'org.gnome.SessionManager', method, args,
            type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    done(conn.call_finish(res));
                } catch (e) {
                    console.warn(`[Guava] Keep Awake: ${method} failed: ${e.message}`);
                    done(null);
                }
            });
        const release = () => {
            if (cookie)
                call('Uninhibit', new GLib.Variant('(u)', [cookie]), null, () => {});
            cookie = 0;
            toggle.checked = pending;
        };
        reg.connect(toggle, 'clicked', () => {
            if (cookie || pending) {
                pending = false;
                release();
                return;
            }
            pending = true;
            toggle.checked = true;
            call('Inhibit', new GLib.Variant('(susu)', [APP_ID, 0, _('Keep Awake'), INHIBIT_IDLE]), '(u)', reply => {
                const wanted = pending;
                pending = false;
                if (!reply) {
                    toggle.checked = false;
                    return;
                }
                [cookie] = reply.deepUnpack();
                // Turned off, or the control went away, while asking
                if (!wanted || gone)
                    release();
            });
        });
        reg.add(() => {
            gone = true;
            release();
        });
        return toggle;
    },

    'low-power': ({ params, ctx, reg, _ }) => {
        const toggle = new QuickToggle(params);
        const lp = () => ctx.features.instance('low-power');
        const sync = () => {
            const inst = lp();
            toggle.checked = !!inst?.active;
            toggle.reactive = !!inst?.available;
            toggle.subtitle = inst?.available
                ? (inst.onBattery ? _('On battery') : _('On power adapter'))
                : _('Not available');
        };
        ctx.events.on('low-power-changed', sync, reg);
        ctx.events.on('feature-changed', ({ id }) => id === 'low-power' && sync(), reg);
        reg.connect(toggle, 'clicked', () => lp()?.toggle());
        sync();
        return toggle;
    },
};
