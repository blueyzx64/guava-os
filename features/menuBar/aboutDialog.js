// SPDX-License-Identifier: GPL-3.0-or-later
// About This PC: the compact Ventura-style window. The device
// picture is its chassis icon; then its name, its model, one row per fact, and "More Info…",
// which opens GNOME Settings › System › About. It opens at once and fills in as the async
// reads (systemInfo.js) arrive.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { ModalSurface } from '../../lib/modalSurface.js';
import { chassisIcon, fillPlaceholders, formatBytes } from './model.js';
import { readSystemInfo } from './systemInfo.js';

export class AboutThisPc {
    /**
     * @param {CleanupRegistry} cleanup
     * @param {Function} _ gettext
     */
    constructor(cleanup, _) {
        this._ = _;
        this._cancellable = null;
        cleanup.add(() => this._cancel());
        this._modal = new ModalSurface(cleanup, {
            id: 'about-this-pc', accessibleName: _('About This Computer'), width: 340, position: 'center', radius: 22,
            styleClass: 'guava-about',
            build: frame => this._build(frame),
            onClosed: () => this._cancel(),
        });
    }

    get isOpen() {
        return this._modal.isOpen;
    }

    open() {
        this._modal.open();
    }

    close() {
        this._modal.close();
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _build(frame) {
        const _ = this._;
        const icon = new St.Icon({ icon_name: 'computer-symbolic', icon_size: 96, style_class: 'guava-about-icon' });
        const name = new St.Label({ text: '', style_class: 'guava-about-name', x_align: Clutter.ActorAlign.CENTER });
        const model = new St.Label({ text: '', style_class: 'guava-about-model', x_align: Clutter.ActorAlign.CENTER });
        frame.add_child(icon);
        frame.add_child(name);
        frame.add_child(model);

        const grid = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'guava-about-rows' });
        frame.add_child(grid);
        const rows = {};
        for (const [key, title] of [
            ['cpu', _('Processor')], ['memory', _('Memory')], ['graphics', _('Graphics')],
            ['disk', _('Storage')], ['os', _('System')], ['gnome', _('GNOME')],
        ]) {
            const row = new St.BoxLayout({ style_class: 'guava-about-row', visible: false });
            row.add_child(new St.Label({ text: title, style_class: 'guava-about-key', y_align: Clutter.ActorAlign.START }));
            const value = new St.Label({ text: '', style_class: 'guava-about-value', x_expand: true });
            value.clutter_text.line_wrap = true;
            row.add_child(value);
            grid.add_child(row);
            rows[key] = { row, value };
        }

        const more = new St.Button({
            label: _('More Info…'), style_class: 'guava-about-button button',
            can_focus: true, x_align: Clutter.ActorAlign.CENTER,
        });
        more.connect('clicked', () => {
            this._modal.close();
            openSettingsAbout();
        });
        frame.add_child(more);

        this._cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        readSystemInfo(cancellable).then(info => {
            if (cancellable.is_cancelled() || this._modal.frame !== frame)
                return;
            icon.icon_name = chassisIcon(info.chassis);
            name.text = info.name ?? '';
            model.text = info.model ?? '';
            model.visible = !!info.model;
            const set = (key, text) => {
                rows[key].value.text = text ?? '';
                rows[key].row.visible = !!text;
            };
            set('cpu', info.cpu);
            set('memory', formatBytes(info.memory, { memory: true }));
            set('graphics', info.gpus.join('\n'));
            set('disk', info.disk
                ? fillPlaceholders(_('%s, %s available'), formatBytes(info.disk.size), formatBytes(info.disk.free))
                : null);
            set('os', info.os.name);
            set('gnome', info.gnome);
        }).catch(e => console.warn(`[Guava] About This PC: ${e.message}`));
        return more;
    }
}

// GNOME Settings › System › About, through Settings' own launch-panel action (as the Shell's
// network menu opens its panels)
function openSettingsAbout() {
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop');
    if (!app)
        return;
    const param = new GLib.Variant('av',
        [new GLib.Variant('(sav)', ['system', [new GLib.Variant('s', 'about')]])]);
    app.activate_action('launch-panel', param, 0, -1, null).catch(e =>
        console.warn(`[Guava] About This PC: cannot open Settings: ${e.message}`));
}
