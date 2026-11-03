// SPDX-License-Identifier: GPL-3.0-or-later
// The Focus tile of the Control Center and its menu-bar icon (one SystemIndicator, the public
// way to add both: QuickSettings.addExternalIndicator).
//
// The tile is a QuickMenuToggle: a click turns Focus on (the last mode used) or off; its menu
// lists the modes (macOS Monterey's Focus module), each with "For 1 hour" and "Until
// tomorrow", and "Focus Settings…". The `guava-focus-toggle` class tells the Control Center to
// place it where Do Not Disturb goes (features/controlCenter _keyOf).

import GObject from 'gi://GObject';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

export const TOGGLE_CLASS = 'guava-focus-toggle';

const FocusToggle = GObject.registerClass(
class FocusToggle extends QuickMenuToggle {
    constructor(gettext) {
        super({ title: gettext('Focus'), iconName: 'notifications-disabled-symbolic', toggleMode: false });
        this.add_style_class_name(TOGGLE_CLASS);
        this.menu.setHeader('notifications-disabled-symbolic', gettext('Focus'));
    }
});

export const FocusIndicator = GObject.registerClass(
class FocusIndicator extends SystemIndicator {
    /**
     * @param {object} ctl {gettext, profiles(), active(), turnOn(id, durationMs), turnOff(),
     *   toggle(), openSettings()}
     */
    constructor(ctl) {
        super();
        this._ctl = ctl;
        this._icon = this._addIndicator();
        this._icon.add_style_class_name('guava-focus-indicator');
        this._icon.visible = false;
        this._toggle = new FocusToggle(ctl.gettext);
        this._toggle.connect('clicked', () => ctl.toggle());
        this.quickSettingsItems.push(this._toggle);
        this._section = new PopupMenu.PopupMenuSection();
        this._toggle.menu.addMenuItem(this._section);
        this._toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._toggle.menu.addAction(ctl.gettext('Focus Settings…'), () => ctl.openSettings());
        // Rebuilt when it opens, so the list is always the current modes
        this._toggle.menu.connect('open-state-changed', (_m, open) => open && this._fill());
    }

    get toggle() {
        return this._toggle;
    }

    /**
     * @param {?{id: string, name: string, icon: string}} profile the active mode
     * @param {string} subtitle e.g. "Until 07:00"
     * @param {boolean} showIcon the menu-bar icon is wanted
     */
    sync(profile, subtitle, showIcon) {
        const _ = this._ctl.gettext;
        const icon = profile?.icon ?? 'notifications-disabled-symbolic';
        this._toggle.set({ checked: !!profile, iconName: icon, subtitle: profile ? subtitle || null : null });
        this._toggle.title = profile ? profile.name : _('Focus');
        this._toggle.accessible_name = profile ? `${_('Focus')}: ${profile.name}` : _('Focus');
        this._toggle.menu.setHeader(icon, _('Focus'), profile ? profile.name : _('Off'));
        this._icon.icon_name = icon;
        this._icon.visible = !!profile && showIcon;
        this._icon.accessible_name = profile ? `${_('Focus')}: ${profile.name}` : '';
        if (this._toggle.menu.isOpen)
            this._fill();
    }

    _fill() {
        const _ = this._ctl.gettext;
        const active = this._ctl.active();
        this._section.removeAll();
        for (const profile of this._ctl.profiles()) {
            const on = active?.id === profile.id;
            const sub = new PopupMenu.PopupSubMenuMenuItem(profile.name, true);
            sub.icon.icon_name = profile.icon;
            sub.setOrnament(on ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            if (on) {
                sub.menu.addAction(_('Turn Off'), () => this._ctl.turnOff());
            } else {
                sub.menu.addAction(_('Turn On'), () => this._ctl.turnOn(profile.id, 0));
                sub.menu.addAction(_('For 1 hour'), () => this._ctl.turnOn(profile.id, 'hour'));
                sub.menu.addAction(_('Until tomorrow morning'), () => this._ctl.turnOn(profile.id, 'tomorrow'));
            }
            this._section.addMenuItem(sub);
        }
    }
});
