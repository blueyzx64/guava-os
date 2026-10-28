// SPDX-License-Identifier: GPL-3.0-or-later
// Rows every preferences page builds from: one implementation each, shared by prefs/pages/
// and features/<name>/prefs.js. Adw/Gtk/Gio only (the prefs process; never Shell modules).
// Every row cleans up its own settings handler when it is destroyed.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { KNOWN_DEFAULTS, findConflicts, normalizeAccel } from '../lib/keybindingsModel.js';

/** Connect `fn` to settings `changed::key` until `widget` is destroyed. */
export function watchKey(settings, key, widget, fn) {
    const id = settings.connect(`changed::${key}`, fn);
    widget.connect('destroy', () => settings.disconnect(id));
    return id;
}

/** A switch bound to a boolean key. */
export function switchRow(settings, title, subtitle, key) {
    const row = new Adw.SwitchRow({ title, subtitle: subtitle ?? '' });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** One switch row per {key, title, subtitle}, added to `group`. @returns {Adw.SwitchRow[]} */
export function addSwitchRows(settings, group, items) {
    return items.map(({ key, title, subtitle }) => {
        const row = switchRow(settings, title, subtitle, key);
        group.add(row);
        return row;
    });
}

/** A drop-down over a string key with fixed values (labels in the same order). */
export function comboRow(settings, { title, subtitle, key, values, labels }) {
    const row = new Adw.ComboRow({ title, model: Gtk.StringList.new(labels) });
    if (subtitle)
        row.subtitle = subtitle;
    const sync = () => {
        const i = values.indexOf(settings.get_string(key));
        row.selected = i < 0 ? 0 : i;
    };
    sync();
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value !== undefined && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    watchKey(settings, key, row, sync);
    return row;
}

/** A row that opens `url` in the browser. */
export function linkRow(title, url, subtitle = null, prefixGicon = null) {
    const row = new Adw.ActionRow({ title, activatable: true });
    if (subtitle)
        row.subtitle = subtitle;
    if (prefixGicon)
        row.add_prefix(new Gtk.Image({ gicon: prefixGicon }));
    row.add_suffix(new Gtk.Image({ icon_name: 'external-link-symbolic' }));
    row.connect('activated', () => Gtk.show_uri(null, url, Gdk.CURRENT_TIME));
    return row;
}

/** True for '' (shortcut off) and for an accelerator GTK and Guava both accept. */
export function isAccel(text) {
    if (!text)
        return true;
    if (!normalizeAccel(text))
        return false;
    const [ok] = Gtk.accelerator_parse(text);
    return ok;
}

/**
 * An entry for a one-accelerator `as` key: invalid text is marked and not saved, a clash with
 * a GNOME default is named, and an optional button fills in a suggested shortcut (offered only
 * while nothing known uses it).
 *
 * @param {Gio.Settings} settings
 * @param {Function} _ gettext
 * @param {object} opts
 * @param {string} opts.key
 * @param {string} opts.title
 * @param {string} opts.example shown in the "not valid" note, e.g. '<Super>d'
 * @param {{accel: string, label: string}} [opts.suggestion]
 * @param {(note: string) => void} [opts.onNote] where the note goes (default: the row title,
 *   as an EntryRow has no subtitle)
 * @returns {Adw.EntryRow}
 */
export function shortcutRow(settings, _, { key, title, example, suggestion = null, onNote = null }) {
    const row = new Adw.EntryRow({ title });
    const read = () => settings.get_strv(key)[0] ?? '';
    row.text = read();
    const base = row.title;
    const showNote = () => {
        const text = row.text.trim();
        row.remove_css_class('error');
        let note = '';
        if (!isAccel(text)) {
            row.add_css_class('error');
            note = _('Not a valid shortcut. Example: %s').replace('%s', example);
        } else if (text) {
            const hit = findConflicts([text], KNOWN_DEFAULTS)[0];
            if (hit)
                note = _('Also used by GNOME: %s').replace('%s', hit.with);
        }
        if (onNote)
            onNote(note);
        else
            row.title = note ? `${base}: ${note}` : base;
    };
    if (suggestion && findConflicts([suggestion.accel], KNOWN_DEFAULTS).length === 0) {
        const use = new Gtk.Button({ label: suggestion.label, valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        use.connect('clicked', () => {
            settings.set_strv(key, [suggestion.accel]);
            row.text = suggestion.accel;
        });
        row.add_suffix(use);
    }
    row.connect('changed', () => {
        const text = row.text.trim();
        showNote();
        if (isAccel(text) && text !== read())
            settings.set_strv(key, text ? [text] : []);
    });
    showNote();
    watchKey(settings, key, row, () => {
        if (read() !== row.text.trim())
            row.text = read();
    });
    return row;
}

/** A page section that says what is coming, for pages whose feature is not built yet. */
export function comingSoonGroup(title, description) {
    const group = new Adw.PreferencesGroup();
    group.add(new Adw.StatusPage({ title, description, icon_name: 'emblem-synchronizing-symbolic' }));
    return group;
}

/**
 * Add the groups a feature's prefs module builds (features/<name>/prefs.js buildPrefs) to a
 * page. One broken module must not take the whole window down: it shows an error row instead.
 *
 * @param {Adw.PreferencesPage} page
 * @param {{buildPrefs: Function}} mod
 * @param {{settings, window, extension, _}} args
 */
export function addFeatureGroups(page, mod, args) {
    try {
        for (const group of mod.buildPrefs(args))
            page.add(group);
    } catch (e) {
        console.error(`[Guava] prefs for '${page.title}' failed:`, e);
        const failed = new Adw.PreferencesGroup();
        failed.add(new Adw.ActionRow({ title: args._('This section failed to load'), subtitle: String(e?.message ?? e) }));
        page.add(failed);
    }
}
