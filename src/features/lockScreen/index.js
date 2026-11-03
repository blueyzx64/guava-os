// SPDX-License-Identifier: GPL-3.0-or-later
// Lock screen like macOS (B32, D-022). A `lockScreen: true` feature (features.js): Guava is alive
// while the screen is locked and every other feature is suspended; this one dresses GNOME's own
// lock dialog (dialog.js) and leaves sign-in alone.
//
// How it reaches the dialog: the Shell makes it in ScreenShield._ensureUnlockDialog() just before
// it pushes the 'unlock-dialog' session mode. A wrapper (cleanup.inject) lets that run, then
// styles `this._dialog`. A dialog that already exists (Guava enabled while locked) is styled from
// lock(). The wrapper never throws into the Shell: a failure leaves the lock screen stock.
// Settings changes restyle a live dialog. Docs: docs/features/lock-screen.md.

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GuavaSettings } from '../../lib/settings.js';
import { StyledDialog } from './dialog.js';
import { normalizeOptions } from './model.js';
import { Power } from './power.js';

const KEYS = [
    'lockscreen-large-clock', 'lockscreen-wallpaper', 'lockscreen-show-user', 'lockscreen-message-on',
    'lockscreen-message', 'lockscreen-power-buttons', 'lockscreen-now-playing', 'lockscreen-notifications',
    'lockscreen-password-hint',
];

export class LockScreen {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._styled = new Set();
        this._options = null;
        this._power = null;
    }

    enable() {
        const { settings } = this._ctx;
        const ks = new GuavaSettings(settings);
        ks.attach(this._cleanup);
        this._ks = ks;
        this._options = this._read();
        ks.watch(KEYS, () => {
            this._options = this._read();
            this._restyle();
        });

        const cancellable = new Gio.Cancellable();
        this._cleanup.add(() => cancellable.cancel());
        this._power = new Power(cancellable);

        // No screen shield (no GDM, or a session that cannot lock): nothing to dress
        if (!Main.screenShield)
            return;

        const self = this;
        this._cleanup.inject(Main.screenShield, '_ensureUnlockDialog', function (orig, ...args) {
            const result = orig.apply(this, args);
            self._attach(this._dialog);
            return result;
        });
        this._cleanup.add(() => {
            for (const styled of this._styled)
                styled.dispose();
            this._styled.clear();
        });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** The screen locked (also right after enable() when it already was). */
    lock() {
        this._attach(Main.screenShield?._dialog);
    }

    unlock() {
        // The Shell destroys the dialog (and with it every part); the styled wrapper drops itself.
        this._styled.clear();
    }

    /** For the harness: the StyledDialog of the live dialog. */
    get current() {
        return [...this._styled][0] ?? null;
    }

    _read() {
        const ks = this._ks;
        return normalizeOptions({
            clock: ks.string('lockscreen-large-clock'),
            wallpaper: ks.string('lockscreen-wallpaper'),
            showUser: ks.bool('lockscreen-show-user'),
            messageOn: ks.bool('lockscreen-message-on'),
            message: ks.string('lockscreen-message'),
            powerButtons: ks.bool('lockscreen-power-buttons'),
            nowPlaying: ks.bool('lockscreen-now-playing'),
            notifications: ks.string('lockscreen-notifications'),
            hint: ks.bool('lockscreen-password-hint'),
        });
    }

    _attach(dialog) {
        try {
            if (!dialog || [...this._styled].some(s => s._d === dialog))
                return;
            const styled = new StyledDialog(dialog, this._ctx, this._options, { power: this._power });
            if (!styled.apply())
                return;
            this._styled.add(styled);
            dialog.connect('destroy', () => this._styled.delete(styled));
            if (this._options.powerButtons)
                this._askPower(styled);
        } catch (e) {
            console.error('[Guava] lock screen: styling failed, left stock:', e);
        }
    }

    async _askPower(styled) {
        const can = await this._power.can();
        if (styled.applied)
            styled.setCan(can);
    }

    _restyle() {
        for (const styled of [...this._styled]) {
            const dialog = styled._d;
            styled.dispose();
            this._styled.delete(styled);
            this._attach(dialog);
        }
    }
}
