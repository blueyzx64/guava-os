// SPDX-License-Identifier: GPL-3.0-or-later
// Volume and brightness OSD, macOS 26 style: a compact glass pill that drops from under the
// menu bar at the Control Center button, in place of GNOME's centred OSD.
//
// core/osd.js decides who shows a change (osd-location; the notch while it runs and the
// setting is 'notch'); this feature registers as its 'pill' sink and only draws. The pill is
// built on the first change and is never reactive, so clicks go through to what is under it.
//
// Shell API: status/volume.js getMixerControl() (the Shell's shared Gvc.MixerControl) for the
// output's name and mute state; Main.panel.statusArea.quickSettings (the Control Center
// button) and Main.layoutManager.panelBox for the place.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { PILL, TRACK_WIDTH, VISIBLE_MS, deviceLabel, pillContent, pillPosition } from './model.js';

const DROP_PX = 14;     // the pill drops this far from under the bar

export class OsdPill {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._view = null;
        this._hideToken = 0;
        this._anim = null;       // CleanupRegistry of the running show / hide animations
        this._hiding = false;
    }

    enable() {
        this._ctx.osd.setSink(this._cleanup, 'pill', osd => this._show(osd));
        this._cleanup.add(() => this._destroyView());
    }

    disable() {
        // Everything is in the cleanup registry
    }

    // ---- the default output, read when a change arrives -----------------------------------

    _audio() {
        const sink = getMixerControl()?.get_default_sink?.() ?? null;
        if (!sink)
            return { device: null, deviceMuted: false };
        // get_port() asserts on a stream without ports (a virtual or null sink)
        const port = sink.get_ports?.()?.length ? sink.get_port() : null;
        return {
            device: deviceLabel(sink.description, port?.human_port),
            deviceMuted: !!sink.is_muted,
        };
    }

    // ---- view -----------------------------------------------------------------------------

    _build() {
        const reg = new CleanupRegistry();
        const root = new St.Widget({ style_class: 'guava-osd-shadow', reactive: false, visible: false });
        const pill = new St.BoxLayout({ style_class: 'guava-osd-pill', reactive: false });
        pill.set_size(PILL.width, PILL.height);
        root.add_child(pill);
        const icon = new St.Icon({ style_class: 'guava-osd-icon', icon_size: PILL.icon, y_align: Clutter.ActorAlign.CENTER });
        pill.add_child(icon);
        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, style_class: 'guava-osd-column',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const caption = new St.Label({ style_class: 'guava-osd-caption' });
        const track = new St.Widget({ style_class: 'guava-osd-track' });
        track.set_width(TRACK_WIDTH);
        const fill = new St.Widget({ style_class: 'guava-osd-fill' });
        track.add_child(fill);
        column.add_child(caption);
        column.add_child(track);
        pill.add_child(column);
        // The OSD sits above the bar and every window, like the stock one
        Main.uiGroup.add_child(root);
        reg.actor(root);
        const glass = Glass.attach(pill, { surface: 'overlays', role: 'content', shadow: root });
        reg.add(() => glass.destroy());
        this._view = { reg, root, pill, icon, caption, track, fill };
    }

    _destroyView() {
        this._anim?.dispose();
        this._anim = null;
        this._view?.reg.dispose();
        this._view = null;
        this._hideToken = 0;
    }

    _place() {
        const { root } = this._view;
        const monitor = Main.layoutManager.primaryMonitor;
        const box = Main.layoutManager.panelBox;
        const button = Main.panel.statusArea.quickSettings;
        let anchor = null;
        if (button?.mapped) {
            const [x] = button.get_transformed_position();
            anchor = { x, width: button.width };
        }
        const { x, y } = pillPosition(monitor, box.y + box.height, anchor);
        root.set_position(x, y);
        root.set_size(PILL.width, PILL.height);
    }

    _show(osd) {
        if (!this._view)
            this._build();
        const v = this._view;
        const content = pillContent(osd, osd.kind === 'volume' ? this._audio() : { device: null, deviceMuted: false },
            this._ctx.gettext);
        if (osd.kind === 'volume' || !osd.icon)
            v.icon.icon_name = content.iconName;
        else
            v.icon.gicon = osd.icon;
        v.caption.text = content.caption;
        // An alert: a screen reader speaks the new level without the focus moving
        A11y.name(v.pill, content.accessibleName, A11y.Role.ALERT);
        v.pill.set_style_class_name(content.muted ? 'guava-osd-pill guava-osd-muted' : 'guava-osd-pill');
        const width = Math.round(TRACK_WIDTH * content.fill);
        const { motion } = this._ctx;

        if (!v.root.visible || this._hiding) {
            this._anim?.dispose();
            this._anim = new CleanupRegistry();
            this._hiding = false;
            this._place();
            Main.uiGroup.set_child_above_sibling(v.root, null);
            v.fill.width = width;
            if (!v.root.visible) {
                v.root.opacity = 0;
                v.root.translation_y = -DROP_PX;
                v.root.show();
            }
            motion.ease(v.root, { opacity: 255 }, { duration: 'short', curve: 'enter' }, this._anim);
            motion.spring(v.root, 'translation_y', 0, { spring: 'snappy' }, this._anim);
        } else {
            motion.ease(v.fill, { width }, { duration: 'micro', curve: 'standard' }, this._cleanup);
        }

        if (this._hideToken)
            this._cleanup.release(this._hideToken);
        this._hideToken = this._cleanup.timeout(VISIBLE_MS, () => {
            this._hideToken = 0;
            this._hide();
        }, { name: 'osd pill hide' });
    }

    _hide() {
        const v = this._view;
        if (!v?.root.visible)
            return;
        this._anim?.dispose();
        this._anim = new CleanupRegistry();
        this._hiding = true;
        this._ctx.motion.ease(v.root, { opacity: 0, translation_y: -DROP_PX / 2 }, {
            duration: 'short', curve: 'exit',
            onDone: finished => {
                if (!finished || !this._hiding)
                    return;
                this._hiding = false;
                v.root.hide();
            },
        }, this._anim);
    }
}
