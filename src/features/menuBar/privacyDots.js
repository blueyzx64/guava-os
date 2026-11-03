// SPDX-License-Identifier: GPL-3.0-or-later
// Privacy dots: an orange dot while
// an app records from the microphone, green for the camera, purple while the screen is
// shared or recorded, next to the Control Center. Clicking them lists who is using what.
//
// The data is the Shell's own: its microphone rule on the shared mixer control (a running
// source with a recording client other than volume meters, not muted), the camera
// indicator's PipeWire camera monitor, and the remote-access and screen-sharing indicators'
// visibility. GNOME's own privacy icons are hidden while the dots run, and come back after.
//
// Private Shell API (js/ui/panel.js QuickSettings, 48-51): quickSettings._camera
// (._indicator), ._volumeInput, ._remoteAccess (._indicator); statusArea.screenSharing
// (_stopSharing). ui/status/volume.js getMixerControl() is exported.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';

import { PanelLayout } from '../../core/panelLayout.js';
import { keepHidden } from '../../lib/keepHidden.js';
import { whenQuickSettingsReady } from '../../lib/quickSettings.js';
import { micApps, privacyDots } from './model.js';
import { LazyMenu, menuHeading, menuItem } from './menuItems.js';
import { MenuGlass } from '../../lib/menuGlass.js';

export const PRIVACY_ROLE = 'guava-menubar-privacy';
const KINDS = ['screen', 'camera', 'mic'];

const PrivacyButton = GObject.registerClass(
class GuavaPrivacyButton extends PanelMenu.Button {
    _init(name, fill) {
        super._init(0.5, name, true);
        // Filled as it opens (an empty PopupMenu refuses to open)
        this.setMenu(new LazyMenu(this, fill));
        this.add_style_class_name('guava-menubar-privacy');
        const box = new St.BoxLayout({ style_class: 'guava-privacy-dots', y_align: Clutter.ActorAlign.CENTER });
        this.add_child(box);
        this.dots = {};
        for (const kind of KINDS) {
            const dot = new St.Widget({ style_class: `guava-privacy-dot guava-privacy-${kind}`, visible: false, y_align: Clutter.ActorAlign.CENTER });
            box.add_child(dot);
            this.dots[kind] = dot;
        }
    }
});

export class PrivacyDots {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._state = { mic: false, camera: false, screen: false };
        this._button = null;
    }

    /** {mic, camera, screen} (tests, the harness) */
    get state() {
        return { ...this._state };
    }

    get button() {
        return this._button;
    }

    start() {
        const _ = this._ctx.gettext;
        const cleanup = this._cleanup;
        const button = new PrivacyButton(_('Privacy'), () => this._fillMenu());
        this._button = button;
        cleanup.add(() => {
            button.destroy();
            this._button = null;
        });
        Main.panel.addToStatusArea(PRIVACY_ROLE, button, 0, 'right');
        new MenuGlass(cleanup).add(button.menu);
        PanelLayout.claim(cleanup, {
            id: PRIVACY_ROLE, actor: button.container, box: 'right',
            anchor: { before: ['quickSettings'], fallback: 'last' },
        });

        // Microphone: the Shell's rule, on its own mixer control
        const sync = () => this._sync();
        this._mixer = getMixerControl();
        for (const signal of ['stream-added', 'stream-removed', 'stream-changed', 'default-source-changed', 'state-changed'])
            cleanup.connect(this._mixer, signal, sync);
        this._source = null;
        this._cameraIcon = this._recordingIcon = this._sharing = null;
        // Camera and screen: the stock indicators' own visibility, once Quick Settings is built
        whenQuickSettingsReady(cleanup, qs => this._adoptStock(qs), 'privacy dots');
        this._sync();
    }

    // GNOME's own privacy icons give way to the dots; the dots follow their state
    _adoptStock(qs) {
        const cleanup = this._cleanup;
        for (const indicator of [qs._camera, qs._volumeInput, qs._remoteAccess]) {
            if (indicator)
                cleanup.add(keepHidden(indicator));
        }
        const sharing = Main.panel.statusArea.screenSharing ?? null;
        if (sharing)
            PanelLayout.hide(cleanup, 'screenSharing');
        this._cameraIcon = qs._camera?._indicator ?? null;
        this._recordingIcon = qs._remoteAccess?._indicator ?? null;
        this._sharing = sharing;
        for (const actor of [this._cameraIcon, this._recordingIcon, this._sharing]) {
            if (actor)
                cleanup.connect(actor, 'notify::visible', () => this._sync());
        }
        this._sync();
    }

    _micOutputs() {
        if (this._mixer.get_state() !== Gvc.MixerControlState.READY)
            return [];
        const running = this._mixer.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING);
        if (!running)
            return [];
        return this._mixer.get_source_outputs().map(o => ({ appId: o.get_application_id(), name: o.get_name() }));
    }

    _sync() {
        const source = this._mixer.get_state() === Gvc.MixerControlState.READY
            ? this._mixer.get_default_source() : null;
        if (source !== this._source) {
            if (this._sourceToken)
                this._cleanup.release(this._sourceToken);
            this._sourceToken = source ? this._cleanup.connect(source, 'notify::is-muted', () => this._sync()) : 0;
            this._source = source;
        }
        const mic = !source?.is_muted && micApps(this._micOutputs()).length > 0;
        const camera = !!this._cameraIcon?.visible;
        const screen = !!this._recordingIcon?.visible || !!this._sharing?.visible;
        this._state = { mic, camera, screen };
        const shown = privacyDots(this._state);
        for (const kind of KINDS)
            this._button.dots[kind].visible = shown.includes(kind);
        this._button.visible = shown.length > 0;
        // The dots are told apart by colour: say which sensors are in use
        const _ = this._ctx.gettext;
        const inUse = { mic: _('Microphone'), camera: _('Camera'), screen: _('Screen Recording') };
        this._button.accessible_name = [_('Privacy Indicators'), ...shown.map(kind => inUse[kind])].join(', ');
        if (!shown.length)
            this._button.menu.close();
    }

    _fillMenu() {
        const _ = this._ctx.gettext;
        const menu = this._button.menu;
        menu.removeAll();
        if (this._state.mic) {
            menu.addMenuItem(menuHeading(_('Microphone')));
            const names = micApps(this._micOutputs());
            for (const name of names.length ? names : [_('An app is using the microphone')])
                menu.addMenuItem(menuItem(name, { enabled: false }));
        }
        if (this._state.camera) {
            menu.addMenuItem(menuHeading(_('Camera')));
            menu.addMenuItem(menuItem(_('An app is using the camera'), { enabled: false }));
        }
        if (this._state.screen) {
            menu.addMenuItem(menuHeading(_('Screen')));
            if (this._sharing?.visible) {
                menu.addMenuItem(menuItem(_('Stop Screen Sharing'), {
                    onActivate: () => this._sharing._stopSharing?.(),
                }));
            } else {
                menu.addMenuItem(menuItem(_('The screen is being recorded'), { enabled: false }));
            }
        }
        if (!menu.numMenuItems)
            menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Nothing is using the camera, microphone or screen'), { reactive: false }));
    }
}
