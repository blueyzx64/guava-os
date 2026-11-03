// SPDX-License-Identifier: GPL-3.0-or-later
// StyledDialog: dresses ONE instance of GNOME's lock dialog (ui/unlockDialog.js) the macOS way and
// undoes it on dispose(). It only styles and arranges: sign-in (AuthPrompt, GDM, PAM, polkit),
// the swipe, the idle timeout, the unlock animation and the screen shield stay the Shell's.
//
// What it does to the dialog (all reversible):
//   - a scrim over the wallpaper (contrast), and, for a sharp wallpaper, no blur effect;
//   - the big clock: its own two labels (date above, large light time), fed from the stock
//     clock's text; the stock clock is hidden;
//   - a "teaser" in the stock page stack: user photo, name and an "Enter Password" glass capsule.
//     Activating it (click, Enter, any key) is the stock _showPrompt(), which crossfades to the
//     real AuthPrompt in the same place, so the field is always at the bottom centre;
//   - its own layout manager (model.js layout()) in place of UnlockDialogLayout;
//   - optional: a message, Sleep / Restart / Shut Down buttons, notification and media rules,
//     the password hint after failures.
//
// Private Shell API (checked on GNOME Shell 50.6, ui/unlockDialog.js): _stack, _clock (_time,
// _date), _promptBox, _authPrompt (_userWell, _passwordEntry, _textEntry), _notificationsBox
// (_notificationBox, _sources, _players, _shouldShowDetails, _detailedChanged), _otherUserButton,
// _backgroundGroup, _adjustment, _user, _ensureAuthPrompt, _setTransitionProgress,
// _updateBackgroundEffects. Everything is looked up at use and guarded: if the Shell changes and a
// part is missing, the dialog stays stock and one error is logged.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';

import * as A11y from '../../lib/a11y.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { bigTime, hintLine, layout, notificationRule, powerActions, pressPower, CONFIRM_MS } from './model.js';

const SOURCE_CLASS = 'unlock-dialog-notification-source';
const FAIL_FLASH_MS = 700;
const SHAKE = [-12, 10, -6, 3, 0];   // px, each step 'short' / 3 long
const POWER_ICONS = { suspend: 'weather-clear-night-symbolic', restart: 'system-reboot-symbolic', poweroff: 'system-shutdown-symbolic' };

const REQUIRED = ['_stack', '_clock', '_promptBox', '_notificationsBox', '_otherUserButton', '_backgroundGroup', '_adjustment'];

const LockLayout = GObject.registerClass(class GuavaLockLayout extends Clutter.LayoutManager {
    _init(parts) {
        super._init();
        this._p = parts;
        this._box = new Clutter.ActorBox();
    }

    vfunc_get_preferred_width(container, forHeight) {
        return this._p.stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(container, forWidth) {
        return this._p.stack.get_preferred_height(forWidth);
    }

    _place(actor, b) {
        const box = this._box;
        box.x1 = b ? b.x : 0;
        box.y1 = b ? b.y : 0;
        box.x2 = box.x1 + (b ? b.w : 0);
        box.y2 = box.y1 + (b ? b.h : 0);
        actor.allocate(box);
    }

    vfunc_allocate(container, box) {
        const [width, height] = box.get_size();
        const p = this._p;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const natural = a => {
            if (!a?.visible)
                return null;
            const [, , w, h] = a.get_preferred_size();
            return { w, h };
        };
        const wrapped = (a, maxW) => {
            if (!a?.visible)
                return null;
            const w = Math.min(a.get_preferred_width(-1)[1], maxW);
            return { w, h: a.get_preferred_height(w)[1] };
        };

        const placed = layout({
            width, height, scale,
            rtl: p.switchUser.get_text_direction() === Clutter.TextDirection.RTL,
            clock: natural(p.clock),
            stack: natural(p.stack) ?? { w: 0, h: 0 },
            notes: natural(p.notes),
            message: wrapped(p.message, Math.round(width * 0.8)),
            power: natural(p.power),
            switchUser: natural(p.switchUser),
        });

        this._place(p.stack, placed.stack);
        for (const key of ['clock', 'notes', 'message', 'power', 'switchUser']) {
            if (p[key]?.visible)
                this._place(p[key], placed[key]);   // dropped for lack of room: a zero box
        }
    }
});

export class StyledDialog {
    /**
     * @param {object} dialog the Shell's UnlockDialog instance
     * @param {object} ctx extension context (gettext, motion)
     * @param {object} options model.js normalizeOptions() result
     * @param {{power: ?object}} deps power: features/lockScreen/power.js, for the buttons
     */
    constructor(dialog, ctx, options, deps = {}) {
        this._d = dialog;
        this._ctx = ctx;
        this._o = options;
        this._deps = deps;
        this._c = null;
        this._dead = false;
        this._failures = 0;
        this._armed = null;
        this._buttons = new Map();
        this._can = null;
        this._applied = false;
    }

    get applied() {
        return this._applied;
    }

    /** The parts, for the harness and tests. */
    get parts() {
        return this._parts ?? null;
    }

    /** @returns {boolean} false when the dialog does not look like GNOME Shell 50's */
    apply() {
        try {
            return this._apply();
        } catch (e) {
            // Half-styled is worse than stock: undo what was done (the clock comes back, the scrim and
            // the overrides go) and report that the lock screen is left stock
            console.error('[Guava] lock screen: styling failed midway, undone:', e);
            this._rollback();
            return false;
        }
    }

    _rollback() {
        const c = this._c;
        this._c = null;
        this._applied = false;
        try {
            c?.dispose();
        } finally {
            const d = this._d;
            if (c && !this._dead && d?._adjustment) {
                try {
                    d._setTransitionProgress(d._adjustment.value);
                    if (this._restoreBackgrounds)
                        d._updateBackgrounds?.();
                } catch (e) {
                    console.error('[Guava] lock screen: rollback incomplete:', e);
                }
            }
        }
    }

    _apply() {
        const d = this._d;
        const missing = REQUIRED.filter(k => !d[k]);
        const mainBox = d._stack?.get_parent?.();
        if (missing.length || !mainBox) {
            console.error(`[Guava] lock screen: dialog lacks ${missing.join(', ') || 'a main box'}; left stock`);
            return false;
        }
        const c = this._c = new CleanupRegistry();
        const o = this._o;
        const _ = this._ctx.gettext;
        const undo = fn => c.add(() => {
            if (!this._dead)
                fn();
        });
        const destroyId = d.connect('destroy', () => {
            this._dead = true;
            this._applied = false;
            c.dispose();
        });
        c.add(() => {
            if (!this._dead)
                d.disconnect(destroyId);
        });

        d.add_style_class_name('guava-lock-dialog');
        undo(() => d.remove_style_class_name('guava-lock-dialog'));
        if (o.wallpaper === 'blurred') {
            d.add_style_class_name('guava-lock-blurred');
            undo(() => d.remove_style_class_name('guava-lock-blurred'));
        }

        // scrim between the wallpaper and the content
        const scrim = c.actor(new St.Widget({ name: 'guava-lock-scrim', style_class: 'guava-lock-scrim', reactive: false }));
        scrim.add_constraint(new Clutter.BindConstraint({ source: global.stage, coordinate: Clutter.BindCoordinate.ALL }));
        d.insert_child_above(scrim, d._backgroundGroup);

        this._wallpaper(o.wallpaper === 'sharp');
        this._clock(mainBox);
        const teaser = this._teaser(_);
        const notes = this._notifications();
        const message = this._message(mainBox);
        const power = this._powerRow(mainBox);

        // the Shell's transition between the clock page and the prompt page, minus the scaling
        // and sliding: the clock stays, the teaser and the prompt crossfade in the same place
        this._override('_setTransitionProgress', (orig, progress) => {
            d._promptBox.visible = progress > 0;
            d._promptBox.opacity = 255 * progress;
            teaser.visible = progress < 1;
            teaser.opacity = 255 * (1 - progress);
            A11y.setEnabled(this._capsule, progress < 1);
            d._otherUserButton.set({ reactive: progress > 0, can_focus: progress > 0, opacity: 255 * progress });
        });
        this._override('_ensureAuthPrompt', orig => {
            orig();
            this._prompt();
        });
        d._setTransitionProgress(d._adjustment.value);
        this._prompt();


        // our own layout manager for the main box
        const stockLayout = mainBox.layout_manager;
        this._parts = { stack: d._stack, clock: this._clockBox, notes, message, power, switchUser: d._otherUserButton };
        mainBox.layout_manager = new LockLayout(this._parts);
        undo(() => {
            mainBox.layout_manager = stockLayout;
        });
        d.queue_relayout();

        if (o.powerButtons && this._can)
            this.setCan(this._can);
        this._applied = true;
        return true;
    }

    /** Undo everything (a setting changed while locked, or Guava is being disabled). */
    dispose() {
        if (!this._c)
            return;
        const wasLive = !this._dead;
        this._c.dispose();
        this._c = null;
        this._applied = false;
        if (wasLive && this._d && this._d._adjustment) {
            this._d._setTransitionProgress(this._d._adjustment.value);
            if (this._restoreBackgrounds)
                this._d._updateBackgrounds?.();
        }
    }

    // ---- helpers ----------------------------------------------------------------------------

    /** d[name] = make(original, ...args): an instance override (the Shell calls these as this.x()). */
    _override(name, make) {
        const d = this._d;
        const orig = d[name].bind(d);
        d[name] = (...args) => make(orig, ...args);
        this._c.add(() => {
            delete d[name];
        });
    }

    /** Keep an actor hidden against the Shell's own visibility updates. */
    _forceHidden(actor) {
        actor.hide();
        this._c.connect(actor, 'notify::visible', () => {
            if (actor.visible)
                actor.hide();
        });
    }

    // ---- parts ------------------------------------------------------------------------------

    _wallpaper(sharp) {
        const d = this._d;
        if (!sharp)
            return;
        this._restoreBackgrounds = true;
        // the Shell re-creates the backgrounds on monitor changes and calls this afterwards
        this._override('_updateBackgroundEffects', orig => {
            orig();
            for (const widget of d._backgroundGroup.get_children())
                widget.remove_effect_by_name('blur');
        });
        d._updateBackgroundEffects();
    }

    _clock(mainBox) {
        const d = this._d;
        const box = this._clockBox = this._c.actor(new St.BoxLayout({
            name: 'guava-lock-clock', style_class: 'guava-lock-clock', orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const date = new St.Label({ style_class: 'guava-lock-date', x_align: Clutter.ActorAlign.CENTER });
        const time = new St.Label({ style_class: 'guava-lock-time', x_align: Clutter.ActorAlign.CENTER });
        box.add_child(date);
        box.add_child(time);
        const sync = () => {
            date.text = d._clock._date?.text ?? '';
            time.text = bigTime(d._clock._time?.text);
        };
        if (d._clock._date)
            this._c.connect(d._clock._date, 'notify::text', sync);
        if (d._clock._time)
            this._c.connect(d._clock._time, 'notify::text', sync);
        sync();
        box.visible = this._o.clock === 'lock-screen';
        d._clock.hide();
        mainBox.add_child(box);
    }

    _teaser(_) {
        const d = this._d;
        const teaser = this._c.actor(new St.BoxLayout({
            name: 'guava-lock-teaser', style_class: 'guava-lock-teaser', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_align: Clutter.ActorAlign.END,
        }));
        teaser.set_pivot_point(0.5, 0.5);
        if (this._o.showUser && d._user) {
            const widget = new UserWidget.UserWidget(d._user, Clutter.Orientation.VERTICAL);
            widget.x_align = Clutter.ActorAlign.CENTER;
            teaser.add_child(widget);
        }
        const capsule = this._capsule = new St.Button({
            name: 'guava-lock-capsule', style_class: 'guava-lock-capsule', label: _('Enter Password'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        A11y.control(capsule, _('Enter Password'));
        capsule.connect('clicked', () => d.activate());
        teaser.add_child(capsule);
        // Takes the place of the prompt's message line (under the field), so the field does not move
        // between the two pages; invisible until the password hint is due
        this._hint = new St.Label({
            name: 'guava-lock-hint', style_class: 'guava-lock-hint', opacity: 0,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hint.clutter_text.line_wrap = true;
        this._hint.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        teaser.add_child(this._hint);
        d._stack.add_child(teaser);
        this._teaserBox = teaser;
        return teaser;
    }

    /** Styling of the real prompt once the Shell has made it (it is made on first use). */
    _prompt() {
        const p = this._d._authPrompt;
        if (!p || p.has_style_class_name?.('guava-lock-prompt'))
            return;
        const _ = this._ctx.gettext;
        p.add_style_class_name('guava-lock-prompt');
        // Only a wrong password counts: the dialog's own 'failed' also fires when the prompt is
        // cancelled (suspend, the idle escape, "log in as another user"), which showed the hint early
        this._c?.connect(p, 'failed', () => this._failed(this._teaserBox));
        p.cancelButton?.hide();   // unused when unlocking (invisible but it takes room and off-centres the field)
        if (p._userWell)
            p._userWell.visible = this._o.showUser;
        for (const entry of [p._passwordEntry, p._textEntry]) {
            if (entry && !entry.accessible_name)
                entry.accessible_name = _('Password');
        }
    }

    _failed(teaser) {
        const _ = this._ctx.gettext;
        this._failures++;
        const capsule = this._capsule;
        capsule.add_style_pseudo_class('error');
        this._c.timeout(FAIL_FLASH_MS, () => {
            if (!this._dead)
                capsule.remove_style_pseudo_class('error');
        });
        const text = hintLine(this._o.hint, this._hintText(), this._failures);
        if (text) {
            this._hint.text = `${_('Hint')}: ${text}`;
            this._hint.opacity = 255;
        }
        const motion = this._ctx.motion;
        if (!motion || motion.env?.reducedMotion || !motion.env?.animations)
            return;
        const step = i => {
            if (this._dead || i >= SHAKE.length)
                return;
            motion.ease(teaser, { translation_x: SHAKE[i] }, { duration: 'short', curve: 'standard', onDone: finished => finished && step(i + 1) }, this._c);
        };
        step(0);
    }

    _hintText() {
        try {
            return this._d._user?.get_password_hint?.() ?? '';
        } catch {
            return '';
        }
    }

    _message(mainBox) {
        const label = this._c.actor(new St.Label({
            name: 'guava-lock-message', style_class: 'guava-lock-message', text: this._o.message,
            visible: !!this._o.message, x_align: Clutter.ActorAlign.CENTER,
        }));
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        mainBox.add_child(label);
        return label;
    }

    _powerRow(mainBox) {
        const row = this._c.actor(new St.BoxLayout({
            name: 'guava-lock-power', style_class: 'guava-lock-power', visible: false,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        mainBox.add_child(row);
        this._row = this._o.powerButtons ? row : null;
        return row;
    }

    /**
     * Fill the power row with what logind allows. Safe to call before or after apply().
     *
     * @param {{suspend?: boolean, restart?: boolean, poweroff?: boolean}} can
     */
    setCan(can) {
        this._can = can;
        const row = this._row;
        if (!row || this._dead)
            return;
        const _ = this._ctx.gettext;
        const labels = { suspend: _('Sleep'), restart: _('Restart'), poweroff: _('Shut Down') };
        row.destroy_all_children();
        this._buttons.clear();
        for (const action of powerActions(can)) {
            const inner = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'guava-lock-power-content' });
            inner.add_child(new St.Icon({ icon_name: POWER_ICONS[action.id], style_class: 'guava-lock-power-icon', x_align: Clutter.ActorAlign.CENTER }));
            const caption = new St.Label({ text: labels[action.id], style_class: 'guava-lock-power-caption', x_align: Clutter.ActorAlign.CENTER });
            inner.add_child(caption);
            const button = new St.Button({ style_class: 'guava-lock-power-button', child: inner, accessible_name: labels[action.id] });
            A11y.control(button, labels[action.id]);
            button.connect('clicked', () => this._pressed(action, labels));
            row.add_child(button);
            this._buttons.set(action.id, { button, caption });
        }
        row.visible = this._buttons.size > 0;
    }

    _pressed(action, labels) {
        const _ = this._ctx.gettext;
        const result = pressPower(this._armed, action, GLib.get_monotonic_time() / 1000);
        this._armed = result.armed;
        for (const [id, { button, caption }] of this._buttons) {
            const armed = this._armed?.id === id;
            caption.text = armed ? _('Click Again') : labels[id];
            A11y.name(button, armed ? `${labels[id]}: ${_('Click Again')}` : labels[id]);
        }
        if (this._armed) {
            this._c.timeout(CONFIRM_MS + 50, () => {
                if (this._dead || !this._armed || this._armed.id !== action.id)
                    return;
                this._armed = null;
                for (const [id, { button, caption }] of this._buttons) {
                    caption.text = labels[id];
                    A11y.name(button, labels[id]);
                }
            });
        }
        if (result.run)
            this._run(result.run);
    }

    /** Overridable (the harness swaps it for a spy). */
    _run(id) {
        this._deps.power?.run(id);
    }

    _notifications() {
        const d = this._d;
        const nb = d._notificationsBox;
        const rule = notificationRule(this._o.notifications);
        const inner = nb._notificationBox;

        // never a body: the Shell shows details for system sources and for apps that opted in
        if (typeof nb._shouldShowDetails === 'function') {
            nb._shouldShowDetails = () => rule.details;
            this._c.add(() => {
                delete nb._shouldShowDetails;
            });
            if (nb._sources && nb._detailedChanged) {
                for (const [source, obj] of nb._sources)
                    nb._detailedChanged(source, obj);
            }
        }

        const hide = child => {
            const isSource = child.has_style_class_name?.(SOURCE_CLASS);
            if (isSource ? !rule.sources : !this._o.nowPlaying)
                this._forceHidden(child);
        };
        if (inner) {
            inner.get_children().forEach(hide);
            this._c.connect(inner, 'child-added', (_box, child) => hide(child));
            nb._updateVisibility?.();
            this._c.add(() => {
                if (this._dead)
                    return;
                nb._sources?.forEach((obj, source) => {
                    obj.sourceBox.visible = obj.visible && source.unseenCount > 0;
                });
                nb._players?.forEach(message => message.show());
                nb._updateVisibility?.();
            });
        }
        return nb;
    }
}
