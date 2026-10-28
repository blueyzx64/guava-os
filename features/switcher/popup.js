// SPDX-License-Identifier: GPL-3.0-or-later
// The Cmd-Tab panel: one big app icon per running app on a faux-glass panel, the name under
// the selected one. A subclass of the Shell's SwitcherPopup (js/ui/switcherPopup.js, GNOME
// 50), which brings the modal grab, the "release the modifier to finish" logic, the short
// show delay for quick taps, mouse hover and click. Everything that acts on apps is a
// callback into features/switcher/index.js; the selection rules are in model.js.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { indexAfterRemoval, initialIndex, keyAction, pickAfterHide, step } from './model.js';

const KEY_NAMES = new Map([
    [Clutter.KEY_Tab, 'Tab'], [Clutter.KEY_ISO_Left_Tab, 'ISO_Left_Tab'],
    [Clutter.KEY_grave, 'grave'], [Clutter.KEY_dead_grave, 'dead_grave'],
    [Clutter.KEY_Left, 'Left'], [Clutter.KEY_Right, 'Right'],
    [Clutter.KEY_Up, 'Up'], [Clutter.KEY_Down, 'Down'],
    [Clutter.KEY_1, '1'], [Clutter.KEY_KP_1, 'KP_1'],
    [Clutter.KEY_q, 'q'], [Clutter.KEY_Q, 'Q'], [Clutter.KEY_h, 'h'], [Clutter.KEY_H, 'H'],
    [Clutter.KEY_Escape, 'Escape'], [Clutter.KEY_period, 'period'],
    [Clutter.KEY_Return, 'Return'], [Clutter.KEY_KP_Enter, 'KP_Enter'],
    [Clutter.KEY_ISO_Enter, 'ISO_Enter'], [Clutter.KEY_space, 'space'],
]);

const BINDING_ACTIONS = new Map([
    [Meta.KeyBindingAction.SWITCH_APPLICATIONS, 'next'],
    [Meta.KeyBindingAction.SWITCH_APPLICATIONS_BACKWARD, 'previous'],
    // Super+` while the panel is open moves back, as Cmd-` does in macOS's switcher
    [Meta.KeyBindingAction.SWITCH_GROUP, 'previous'],
    [Meta.KeyBindingAction.SWITCH_GROUP_BACKWARD, 'next'],
]);

const AppItem = GObject.registerClass(
class GuavaSwitcherAppItem extends St.BoxLayout {
    _init(app, iconSize) {
        super._init({
            style_class: 'guava-switcher-app',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.app = app;
        this.add_child(app.create_icon_texture(iconSize));
        this.label = new St.Label({
            style_class: 'guava-switcher-label',
            text: app.get_name(),
            // As wide as the icon: a long name ellipsizes instead of widening every item
            width: iconSize,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this.label);
    }
});

/**
 * @typedef {object} SwitcherCallbacks
 * @property {(app: Shell.App, timestamp: number, altHeld: boolean) => void} activate
 * @property {(app: Shell.App) => void} quit
 * @property {(app: Shell.App) => void} hide
 * @property {(app: Shell.App) => void} expose
 */

export const AppSwitcherPopup = GObject.registerClass(
class GuavaAppSwitcherPopup extends SwitcherPopup.SwitcherPopup {
    /**
     * @param {Shell.App[]} apps most recently used first
     * @param {{iconSize: number, frontIsFirst: boolean, callbacks: SwitcherCallbacks, label: string}} opts
     *   label: the panel's accessible name
     */
    _init(apps, { iconSize, frontIsFirst, callbacks, label }) {
        super._init();
        A11y.dialog(this, label);
        this.add_style_class_name('guava-switcher-popup');
        this._callbacks = callbacks;
        this._frontIsFirst = frontIsFirst;
        this._hidden = new Set(); // apps H hid while the panel was open

        this._switcherList = new SwitcherPopup.SwitcherList(true);
        this._switcherList.add_style_class_name('guava-switcher');
        this._items = apps.map(app => {
            const item = new AppItem(app, iconSize);
            const button = this._switcherList.addItem(item, item.label);
            button.accessible_name = app.get_name();
            return item;
        });
        this._glass = Glass.attach(this._switcherList, { surface: 'overlays', role: 'content' });

        // An app that quits (Q, or on its own) leaves the panel, as on macOS
        for (const item of this._items) {
            item.app.connectObject('notify::state', app => {
                if (app.state === Shell.AppState.STOPPED)
                    this._removeApp(app);
            }, this);
        }
    }

    _removeApp(app) {
        const index = this._items.findIndex(i => i.app === app);
        if (index < 0)
            return;
        this._items.splice(index, 1);
        app.disconnectObject(this);
        this._switcherList.removeItem(index); // emits item-removed: the selection follows
    }

    _initialSelection(backward, _binding) {
        this._select(initialIndex(this._items.length, { backward, frontIsFirst: this._frontIsFirst }));
    }

    _itemRemovedHandler(n) {
        if (this._items.length === 0) {
            this.fadeAndDestroy();
            return;
        }
        this._select(indexAfterRemoval(this._selectedIndex, n, this._items.length));
    }

    _keyPressHandler(keysym, action) {
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const what = BINDING_ACTIONS.get(action) ?? keyAction(KEY_NAMES.get(keysym) ?? '', { rtl });
        const app = this._items[this._selectedIndex]?.app;
        switch (what) {
        case 'next':
        case 'previous':
            this._select(step(this._selectedIndex, this._items.length, what === 'next' ? 1 : -1));
            return Clutter.EVENT_STOP;
        case 'quit':
            if (app)
                this._callbacks.quit(app);
            return Clutter.EVENT_STOP;
        case 'hide':
            if (app) {
                this._hidden.add(app);
                this._callbacks.hide(app);
            }
            return Clutter.EVENT_STOP;
        case 'expose':
            this.fadeAndDestroy();
            if (app)
                this._callbacks.expose(app);
            return Clutter.EVENT_STOP;
        case 'cancel':
            this.fadeAndDestroy();
            return Clutter.EVENT_STOP;
        case 'activate':
            this._finish(global.get_current_time());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _finish(timestamp) {
        // Releasing Super right after H keeps that app hidden: the front-most app that was not
        // hidden gets the focus instead (pickAfterHide)
        const index = pickAfterHide(this._selectedIndex, this._items.map(i => this._hidden.has(i.app)));
        const app = this._items[index]?.app;
        const [, , mods] = global.get_pointer();
        // Pop the grab before activating, so the activated window gets the keyboard focus
        super._finish(timestamp);
        if (app)
            this._callbacks.activate(app, timestamp, !!(mods & Clutter.ModifierType.MOD1_MASK));
    }

    _onDestroy() {
        for (const item of this._items)
            item.app.disconnectObject(this);
        this._glass?.destroy();
        this._glass = null;
        super._onDestroy();
    }
});

/**
 * Super+` (Cmd-`): no panel. Each press brings the next window of the front app to the
 * front; releasing Super focuses it, Esc puts the first one back on top. The popup is only
 * the Shell's grab that sees the release; it draws nothing.
 */
export const WindowCyclerPopup = GObject.registerClass(
class GuavaWindowCyclerPopup extends SwitcherPopup.SwitcherPopup {
    /** @param {Meta.Window[]} windows the front app's windows on this Space, front first */
    _init(windows, { activate }) {
        super._init(windows);
        this.add_style_class_name('guava-window-cycler');
        this._activate = activate;
        // SwitcherPopup allocates a list and connects to it; this one stays empty and hidden
        // (_select below never highlights in it)
        this._switcherList = new SwitcherPopup.SwitcherList(false);
        this._switcherList.visible = false;
        for (const win of windows)
            win.connectObject('unmanaged', () => this._windowGone(win), this);
    }

    _windowGone(win) {
        win.disconnectObject(this);
        const index = this._items.indexOf(win);
        if (index < 0)
            return;
        this._items.splice(index, 1);
        if (this._items.length < 2)
            this.fadeAndDestroy();
        else
            this._select(Math.min(this._selectedIndex, this._items.length - 1));
    }

    _select(num) {
        this._selectedIndex = num;
        this._items[num]?.raise();
    }

    _initialSelection(backward) {
        this._select(initialIndex(this._items.length, { backward }));
    }

    _keyPressHandler(keysym, action) {
        if (action === Meta.KeyBindingAction.SWITCH_GROUP)
            this._select(step(this._selectedIndex, this._items.length, 1));
        else if (action === Meta.KeyBindingAction.SWITCH_GROUP_BACKWARD)
            this._select(step(this._selectedIndex, this._items.length, -1));
        else if (keysym === Clutter.KEY_Escape)
            this._cancel();
        else
            return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    _cancel() {
        this._items[0]?.raise();
        this.fadeAndDestroy();
    }

    _finish(timestamp) {
        const win = this._items[this._selectedIndex];
        super._finish(timestamp);
        if (win)
            this._activate(win, timestamp);
    }

    _onDestroy() {
        for (const win of this._items)
            win.disconnectObject(this);
        super._onDestroy();
    }
});
