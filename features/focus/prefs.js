// SPDX-License-Identifier: GPL-3.0-or-later
// Prefs for Focus modes: the switches, then one expander per mode with its allowed apps,
// time-sensitive rule, schedules and "turn on when this app opens". Adw/Gtk/Gio only.
// The modes are one JSON key (focus-profiles), read and written through model.js.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { switchRow, watchKey } from '../../prefs/widgets.js';
import {
    EVERY_DAY, customId, minutesToText, normalizeAppId, parseProfiles, serializeProfiles,
    textToMinutes, toggleApp,
} from './model.js';

const DAY_PRESETS = [
    { days: EVERY_DAY, label: 'Every day' },
    { days: [1, 2, 3, 4, 5], label: 'Weekdays' },
    { days: [0, 6], label: 'Weekends' },
];

function installedApps() {
    return Gio.AppInfo.get_all()
        .filter(a => a.should_show() && a.get_id())
        .map(a => ({ id: normalizeAppId(a.get_id()), name: a.get_display_name() }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function daysText(_, days) {
    const preset = DAY_PRESETS.find(p => JSON.stringify(p.days) === JSON.stringify(days));
    if (preset)
        return _(preset.label);
    // A known Sunday gives the localized short names
    return days.map(d => new Date(2026, 0, 4 + d).toLocaleDateString(undefined, { weekday: 'short' })).join(', ');
}

/** @returns {Adw.PreferencesGroup[]} */
export function buildPrefs({ settings, _ }) {
    const main = new Adw.PreferencesGroup({
        title: _('Focus'),
        description: _('Silence notifications from all but the apps you choose. Silenced notifications still go to the Notification Center; time-sensitive ones break through.'),
    });
    main.add(switchRow(settings, _('Focus Modes'),
        _('Do Not Disturb, Sleep, Work, Personal and your own modes, in the Control Center'), 'focus-modes'));
    main.add(switchRow(settings, _('Show Focus in the Menu Bar'),
        _('The active mode’s icon in the top bar'), 'focus-menubar-icon'));

    const modes = new Adw.PreferencesGroup({ title: _('Modes') });
    const apps = installedApps();
    const appName = id => apps.find(a => a.id === id)?.name ?? id;
    let rows = [];

    const load = () => parseProfiles(settings.get_string('focus-profiles'));
    const save = profiles => settings.set_string('focus-profiles', serializeProfiles(profiles));
    const edit = (id, fn) => {
        const profiles = load();
        const profile = profiles.find(p => p.id === id);
        if (profile) {
            fn(profile, profiles);
            save(profiles);
        }
    };

    const appPicker = (title, onAdd) => {
        const row = new Adw.ComboRow({
            title, model: Gtk.StringList.new(apps.map(a => a.name)), enable_search: true,
        });
        const add = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Add') });
        add.add_css_class('flat');
        add.connect('clicked', () => apps[row.selected] && onAdd(apps[row.selected].id));
        row.add_suffix(add);
        return row;
    };
    const removable = (title, subtitle, onRemove) => {
        const row = new Adw.ActionRow({ title, subtitle: subtitle ?? '' });
        const remove = new Gtk.Button({ icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Remove') });
        remove.add_css_class('flat');
        remove.connect('clicked', onRemove);
        row.add_suffix(remove);
        return row;
    };

    const modeRow = profile => {
        const row = new Adw.ExpanderRow({
            title: profile.builtIn ? _(profile.name) : profile.name,
            subtitle: [
                profile.allowedApps.length ? _('%d allowed apps').replace('%d', profile.allowedApps.length) : _('No apps allowed'),
                profile.schedules.length ? _('scheduled') : '',
                profile.appTriggers.length ? _('turns on with an app') : '',
            ].filter(Boolean).join(' · '),
        });
        row.add_prefix(new Gtk.Image({ icon_name: profile.icon }));

        const ts = new Adw.SwitchRow({
            title: _('Time-Sensitive Notifications'), subtitle: _('Urgent notifications break through'),
            active: profile.allowTimeSensitive,
        });
        ts.connect('notify::active', () => edit(profile.id, p => (p.allowTimeSensitive = ts.active)));
        row.add_row(ts);

        for (const id of profile.allowedApps)
            row.add_row(removable(appName(id), _('Allowed'), () => edit(profile.id, p => (p.allowedApps = toggleApp(p.allowedApps, id)))));
        row.add_row(appPicker(_('Allow Notifications From'), id => edit(profile.id, p => {
            if (!p.allowedApps.includes(id))
                p.allowedApps = toggleApp(p.allowedApps, id);
        })));

        profile.schedules.forEach((s, index) => {
            row.add_row(removable(`${minutesToText(s.start)} – ${minutesToText(s.end)}`, daysText(_, s.days),
                () => edit(profile.id, p => p.schedules.splice(index, 1))));
        });
        const schedule = new Adw.ActionRow({ title: _('Add Schedule'), subtitle: _('From – to, e.g. 22:00 – 07:00') });
        const from = new Gtk.Entry({ text: '22:00', width_chars: 5, valign: Gtk.Align.CENTER });
        const to = new Gtk.Entry({ text: '07:00', width_chars: 5, valign: Gtk.Align.CENTER });
        const days = new Gtk.DropDown({ model: Gtk.StringList.new(DAY_PRESETS.map(p => _(p.label))), valign: Gtk.Align.CENTER });
        const addSchedule = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Add') });
        addSchedule.add_css_class('flat');
        addSchedule.connect('clicked', () => {
            const start = textToMinutes(from.text);
            const end = textToMinutes(to.text);
            if (start === null || end === null || start === end) {
                schedule.subtitle = _('Use 24-hour times such as 09:00 and 17:30');
                return;
            }
            edit(profile.id, p => p.schedules.push({ days: [...DAY_PRESETS[days.selected].days], start, end }));
        });
        for (const w of [from, to, days, addSchedule])
            schedule.add_suffix(w);
        row.add_row(schedule);

        for (const id of profile.appTriggers)
            row.add_row(removable(appName(id), _('Turns on while open'), () => edit(profile.id, p => (p.appTriggers = toggleApp(p.appTriggers, id)))));
        row.add_row(appPicker(_('Turn On When This App Opens'), id => edit(profile.id, p => {
            if (!p.appTriggers.includes(id))
                p.appTriggers = toggleApp(p.appTriggers, id);
        })));

        if (!profile.builtIn) {
            const del = new Adw.ActionRow({ title: _('Delete This Focus') });
            const button = new Gtk.Button({ label: _('Delete'), valign: Gtk.Align.CENTER });
            button.add_css_class('destructive-action');
            button.connect('clicked', () => save(load().filter(p => p.id !== profile.id)));
            del.add_suffix(button);
            row.add_row(del);
        }
        return row;
    };

    const addRow = new Adw.EntryRow({ title: _('New Focus name'), show_apply_button: true });
    addRow.connect('apply', () => {
        const name = addRow.text.trim();
        if (!name)
            return;
        const profiles = load();
        profiles.push({
            id: customId(profiles, name), name, icon: 'starred-symbolic', builtIn: false,
            allowedApps: [], schedules: [], appTriggers: [], allowTimeSensitive: true,
        });
        save(profiles);
        addRow.text = '';
    });

    const fill = () => {
        rows.forEach(r => modes.remove(r));
        rows = load().map(modeRow);
        rows.forEach(r => modes.add(r));
        // The new-mode row stays last
        modes.remove(addRow);
        modes.add(addRow);
    };
    modes.add(addRow);
    fill();
    watchKey(settings, 'focus-profiles', modes, fill);

    const sync = () => (modes.sensitive = settings.get_boolean('focus-modes'));
    sync();
    watchKey(settings, 'focus-modes', modes, sync);
    return [main, modes];
}
