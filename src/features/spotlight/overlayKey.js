// SPDX-License-Identifier: GPL-3.0-or-later
// Take over the Super tap ("overlay-key") from the Activities overview, and give it back.
//
// How the stock Shell does it: Main.overview's OverviewControls connects a handler to
// global.display 'overlay-key' (js/ui/overviewControls.js, unchanged in structure 48-51; read
// in the 51.1 source). mutter emits that signal only for a Super press and release with no
// other key in between, so Super+key shortcuts are unaffected.
//
// What we do, with no monkey patch of the Shell:
//   start(): find the OLDEST handler connected to 'overlay-key' (GLib keeps handlers in connect
//            order, and the Shell connects its own at startup, before any extension) and block
//            that one id, then connect our own handler. If no handler is found we do nothing
//            and the stock behaviour stays; Spotlight is then reachable by its optional shortcut.
//   stop():  disconnect ours, unblock exactly the id we blocked.
//
// Super while a menu or Guava surface is open: panel menus and Guava's modals run in
// Shell.ActionMode.POPUP, and the Shell allows 'overlay-key' only in NORMAL | OVERVIEW
// (js/ui/main.js _sessionUpdated). mutter still swallows the bare Super release then
// (process_special_modifier_key in keybindings.c returns STOP), but its filter-keybinding check
// drops the signal, so neither the stage nor our handler would see the tap. start() adds POPUP
// for as long as the takeover runs, and stop() puts back exactly the modes it found; the tap
// then closes whatever is open and opens Spotlight (or closes Spotlight itself). Super+<key> combos are untouched: mutter
// clears its "Super only" state on the other key and emits nothing.
//
// Other extensions' overlay-key handlers are not touched. The overview itself is untouched:
// hot corner, touchpad gesture, Super+A and the Activities button keep working, and a Super
// tap while the overview is open still closes it.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SIGNAL = 'overlay-key';

export class OverlayKeyTakeover {
    /** @param {Function} onTap called for a Super tap when the overview is not open */
    constructor(onTap) {
        this._onTap = onTap;
        this._handlerId = 0;
        this._blockedId = 0;
        this._a11y = null;
        this._savedModes = null;   // overlay-key action modes before _allowInPopup(), or null
    }

    get active() {
        return this._handlerId !== 0;
    }

    start() {
        if (this.active)
            return;
        const display = global.display;
        let a11y = null;
        let ours = 0;
        let blocked = 0;
        try {
            // Everything that can throw comes first; nothing is blocked until it is all ready
            a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.keyboard' });
            blocked = GObject.signal_handler_find(display, { signalId: SIGNAL });
            if (!blocked) {
                console.warn('[Guava] spotlight: no stock overlay-key handler found; the Super tap stays with the overview');
                return;
            }
            // No safe way to count handlers (the *_matched calls would also touch handlers other
            // extensions blocked), so only the id is logged, for diagnosis.
            console.debug(`[Guava] spotlight: blocking the oldest overlay-key handler (id ${blocked}, assumed to be the Shell's)`);
            GObject.signal_handler_block(display, blocked);
            ours = display.connect(SIGNAL, () => this._tap());
        } catch (e) {
            console.warn(`[Guava] spotlight: overlay-key takeover failed: ${e.message}`);
            if (blocked)
                GObject.signal_handler_unblock(display, blocked);
            if (ours)
                display.disconnect(ours);
            return;
        }
        this._a11y = a11y;
        this._blockedId = blocked;
        this._handlerId = ours;
        this._allowInPopup();
    }

    _allowInPopup() {
        if (!this.active || this._savedModes !== null || typeof Main.wm?.allowKeybinding !== 'function')
            return;
        const current = Main.wm._allowedKeybindings?.['overlay-key'];
        const before = Number.isInteger(current) ? current : Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        this._savedModes = before;
        Main.wm.allowKeybinding('overlay-key', before | Shell.ActionMode.POPUP);
    }

    _restoreModes() {
        if (this._savedModes === null)
            return;
        Main.wm.allowKeybinding('overlay-key', this._savedModes);
        this._savedModes = null;
    }

    stop() {
        this._restoreModes();
        if (!this.active)
            return;
        const display = global.display;
        display.disconnect(this._handlerId);
        if (GObject.signal_handler_is_connected(display, this._blockedId))
            GObject.signal_handler_unblock(display, this._blockedId);
        this._handlerId = 0;
        this._blockedId = 0;
        this._a11y = null;
    }

    _tap() {
        // The stock handler ignores the key with sticky keys on (Super is a latching modifier
        // then); do the same.
        if (this._a11y?.get_boolean('stickykeys-enable'))
            return;
        if (Main.overview.visible) {
            // Behave as stock while the overview is up: a tap closes it
            Main.overview.toggle();
            return;
        }
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return;
        // A window move or resize is in progress: do not pop up over it. The compositor grab of
        // an open menu or modal is no reason to wait: the tap closes it
        const op = global.display.get_grab_op?.() ?? Meta.GrabOp.NONE;
        if (op !== Meta.GrabOp.NONE && op !== Meta.GrabOp.COMPOSITOR)
            return;
        this._onTap();
    }
}
