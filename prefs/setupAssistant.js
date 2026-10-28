// SPDX-License-Identifier: GPL-3.0-or-later
// The Setup Assistant UI (prefs process: Adw/Gtk only). It renders the steps of
// features/onboarding/model.js as a carousel of macOS-style cards in an Adw.Dialog over the
// preferences window: a large icon, a title, two lines of text, the step's controls, Continue,
// and Back / Not Now. Every control writes its key at once (like macOS), so Not Now or closing
// keeps what was chosen so far and the defaults for the rest.
//
// Why the preferences window and not a glass modal in the Shell: docs/architecture/onboarding.md.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { switchRow } from './widgets.js';
import { ACCENTS, ONBOARDING_KEY, STEPS, appearanceChoice, appearanceWrites } from '../features/onboarding/model.js';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

/** A toggle group over a string key with fixed values. */
function choiceGroup(settings, key, values, labels, _) {
    const group = new Adw.ToggleGroup({ halign: Gtk.Align.CENTER, homogeneous: true });
    values.forEach((value, i) => group.add(new Adw.Toggle({ name: value, label: _(labels[i]) })));
    const sync = () => (group.active_name = settings.get_string(key));
    sync();
    group.connect('notify::active-name', () => {
        if (group.active_name && settings.get_string(key) !== group.active_name)
            settings.set_string(key, group.active_name);
    });
    const id = settings.connect(`changed::${key}`, sync);
    group.connect('destroy', () => settings.disconnect(id));
    return group;
}

/** Light / Dark / Auto: GNOME's own color-scheme, or Guava's Auto. */
function appearanceGroup(settings, _) {
    const iface = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE_SCHEMA, true)
        ? new Gio.Settings({ schema_id: INTERFACE_SCHEMA }) : null;
    const group = new Adw.ToggleGroup({ halign: Gtk.Align.CENTER, homogeneous: true });
    for (const [name, label, icon] of [['light', _('Light'), 'weather-clear-symbolic'],
        ['dark', _('Dark'), 'weather-clear-night-symbolic'], ['auto', _('Auto'), 'emblem-synchronizing-symbolic']])
        group.add(new Adw.Toggle({ name, label, icon_name: icon, tooltip: label }));
    let syncing = false;
    const sync = () => {
        syncing = true;
        group.active_name = appearanceChoice({
            auto: settings.get_boolean('appearance-auto'),
            colorScheme: iface?.get_string('color-scheme') ?? 'default',
        });
        syncing = false;
    };
    sync();
    group.connect('notify::active-name', () => {
        if (syncing || !group.active_name)
            return;
        for (const w of appearanceWrites(group.active_name)) {
            if (w.schema === 'gnome')
                iface?.set_string(w.key, w.value);
            else
                settings.set_boolean(w.key, w.value);
        }
    });
    const ids = [settings.connect('changed::appearance-auto', sync)];
    const ifaceId = iface?.connect('changed::color-scheme', sync);
    group.connect('destroy', () => {
        ids.forEach(id => settings.disconnect(id));
        if (ifaceId)
            iface.disconnect(ifaceId);
    });
    return group;
}

/** Round colour swatches over a string key (macOS Appearance's accent row). */
function accentRow(settings, key, title, _) {
    const box = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER });
    const buttons = new Map();
    let first = null;
    for (const [value, label] of ACCENTS) {
        const button = new Gtk.ToggleButton({
            tooltip_text: _(label), css_classes: ['guava-accent-swatch', `guava-accent-${value}`],
            group: first, valign: Gtk.Align.CENTER,
        });
        button.update_property([Gtk.AccessibleProperty.LABEL], [`${_(title)}: ${_(label)}`]);
        first ??= button;
        button.connect('toggled', () => {
            if (button.active && settings.get_string(key) !== value)
                settings.set_string(key, value);
        });
        buttons.set(value, button);
        box.append(button);
    }
    const sync = () => {
        const b = buttons.get(settings.get_string(key));
        if (b && !b.active)
            b.active = true;
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    box.connect('destroy', () => settings.disconnect(id));
    const wrap = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    wrap.append(new Gtk.Label({ label: _(title), css_classes: ['heading'] }));
    wrap.append(box);
    return wrap;
}

/** A slider over an integer key, with Small / Large at its ends (macOS Dock Size). */
function sizeRow(settings, { key, title, lower, upper, step }, _) {
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step, page_increment: step * 4 }),
        hexpand: true, draw_value: false, round_digits: 0,
    });
    scale.update_property([Gtk.AccessibleProperty.LABEL], [_(title)]);
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const box = new Gtk.Box({ spacing: 12 });
    box.append(new Gtk.Label({ label: _('Small'), css_classes: ['dim-label', 'caption'] }));
    box.append(scale);
    box.append(new Gtk.Label({ label: _('Large'), css_classes: ['dim-label', 'caption'] }));
    const wrap = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    wrap.append(new Gtk.Label({ label: _(title), css_classes: ['heading'] }));
    wrap.append(box);
    return wrap;
}

function controlWidget(settings, control, _) {
    switch (control.type) {
    case 'appearance':
        return appearanceGroup(settings, _);
    case 'accent':
        return accentRow(settings, control.key, control.title, _);
    case 'choice': {
        const wrap = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        wrap.append(new Gtk.Label({ label: _(control.title), css_classes: ['heading'] }));
        wrap.append(choiceGroup(settings, control.key, control.values, control.labels, _));
        return wrap;
    }
    case 'size':
        return sizeRow(settings, control, _);
    case 'switch': {
        const list = new Gtk.ListBox({ css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE });
        list.append(switchRow(settings, _(control.title), null, control.key));
        return list;
    }
    default:
        return null;
    }
}

function stepPage(step, { settings, extension, _ }) {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 18, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true, margin_start: 36, margin_end: 36, margin_top: 12, margin_bottom: 12,
    });
    if (step.icon === 'guava-logo') {
        page.append(new Gtk.Picture({
            file: Gio.File.new_for_path(GLib.build_filenamev([extension.path, 'icons', 'guava_logo.png'])),
            width_request: 112, height_request: 112, content_fit: Gtk.ContentFit.CONTAIN, halign: Gtk.Align.CENTER,
            alternative_text: 'Guava',
        }));
    } else {
        page.append(new Gtk.Image({ icon_name: step.icon, pixel_size: 80, css_classes: ['guava-setup-icon'] }));
    }
    page.append(new Gtk.Label({ label: _(step.title), css_classes: ['title-1'], wrap: true, justify: Gtk.Justification.CENTER }));
    page.append(new Gtk.Label({
        label: _(step.body), wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 52,
        css_classes: ['body', 'dim-label'],
    }));
    for (const control of step.controls) {
        const widget = controlWidget(settings, control, _);
        if (widget)
            page.append(widget);
    }
    return page;
}

/**
 * Present the assistant over the preferences window.
 *
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object, _: Function}} args
 * @returns {Adw.Dialog}
 */
export function presentAssistant(args) {
    const { settings, window, _ } = args;
    const carousel = new Adw.Carousel({ interactive: false, allow_long_swipes: false, vexpand: true });
    for (const step of STEPS)
        carousel.append(stepPage(step, args));
    const dots = new Adw.CarouselIndicatorDots({ carousel });

    const back = new Gtk.Button({ label: _('Back'), css_classes: ['flat'] });
    const notNow = new Gtk.Button({ label: _('Not Now'), css_classes: ['flat'] });
    const next = new Gtk.Button({ label: _('Continue'), css_classes: ['suggested-action', 'pill'] });
    const header = new Adw.HeaderBar({ show_title: false, show_end_title_buttons: false });
    header.pack_start(back);
    header.pack_end(notNow);

    const footer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_bottom: 18, halign: Gtk.Align.CENTER });
    footer.append(next);
    footer.append(dots);

    const view = new Adw.ToolbarView({ content: carousel });
    view.add_top_bar(header);
    view.add_bottom_bar(footer);

    const dialog = new Adw.Dialog({
        title: _('Guava Setup Assistant'), content_width: 560, content_height: 640, child: view,
        can_close: true,
    });
    dialog.add_css_class('guava-setup');

    const index = () => Math.round(carousel.position);
    const sync = () => {
        const i = index();
        const last = i === STEPS.length - 1;
        back.visible = i > 0;
        notNow.visible = !last;
        next.label = last ? _('Get Started') : _('Continue');
    };
    carousel.connect('page-changed', sync);
    back.connect('clicked', () => carousel.scroll_to(carousel.get_nth_page(Math.max(0, index() - 1)), true));
    next.connect('clicked', () => {
        const i = index();
        if (i >= STEPS.length - 1)
            dialog.close();
        else
            carousel.scroll_to(carousel.get_nth_page(i + 1), true);
    });
    notNow.connect('clicked', () => dialog.close());
    dialog.connect('closed', () => settings.set_string(ONBOARDING_KEY, 'done'));
    sync();

    if (settings.get_string(ONBOARDING_KEY) !== 'done')
        settings.set_string(ONBOARDING_KEY, 'shown');
    dialog.present(window);
    next.grab_focus();
    return dialog;
}
