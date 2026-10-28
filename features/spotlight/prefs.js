// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight preferences. Adw/Gtk/Gio only (runs in the prefs process, no Shell libs).
// buildPrefs() returns the Adw.PreferencesGroup[]; prefs/pages/ places them on a page.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ENGINES } from './model.js';
import { GUAVA_ACTIONS, actionChoices } from './actionsModel.js';
import { addQuickKey, parseQuickKeys, removeQuickKey, validAlias } from './queryModel.js';
import { shortcutRow, switchRow, watchKey } from '../../prefs/widgets.js';

const N_ = s => s;

const ENGINE_LABELS = {
    duckduckgo: N_('DuckDuckGo'),
    google: N_('Google'),
    bing: N_('Bing'),
    brave: N_('Brave Search'),
    startpage: N_('Startpage'),
    ecosia: N_('Ecosia'),
};

function engineRows(settings, _) {
    const key = 'spotlight-engine';
    const ids = Object.keys(ENGINES);
    const labels = [...ids.map(id => _(ENGINE_LABELS[id] ?? id)), _('Custom')];
    const combo = new Adw.ComboRow({
        title: _('Search engine'), subtitle: _('Used by the Web result'),
        model: Gtk.StringList.new(labels),
    });
    const custom = new Adw.EntryRow({ title: _('Custom address (https, with %s for the search)') });

    const sync = () => {
        const value = settings.get_string(key);
        const i = ids.indexOf(value);
        combo.selected = i < 0 ? ids.length : i;
        custom.visible = i < 0;
        if (i < 0 && custom.text !== value)
            custom.text = value;
    };
    sync();
    combo.connect('notify::selected', () => {
        if (combo.selected < ids.length) {
            if (settings.get_string(key) !== ids[combo.selected])
                settings.set_string(key, ids[combo.selected]);
        } else {
            custom.visible = true;
        }
    });
    custom.connect('changed', () => {
        const text = custom.text.trim();
        const valid = /^https:\/\/\S+$/.test(text) && text.includes('%s');
        custom.remove_css_class('error');
        if (!valid) {
            if (text)
                custom.add_css_class('error');
            return;
        }
        if (settings.get_string(key) !== text)
            settings.set_string(key, text);
    });
    const id = settings.connect(`changed::${key}`, sync);
    combo.connect('destroy', () => settings.disconnect(id));
    return [combo, custom];
}


/** The Quick Keys targets: Guava's actions, then the installed apps A to Z. */
function quickKeyTargets(_) {
    const actions = actionChoices(GUAVA_ACTIONS).map(a => ({ target: `action:${a.id}`, label: _(a.title) }));
    const apps = Gio.AppInfo.get_all()
        .filter(a => a.should_show() && a.get_id())
        .map(a => ({ target: `app:${a.get_id()}`, label: a.get_display_name() }))
        .sort((a, b) => a.label.localeCompare(b.label));
    return [...actions, ...apps];
}

/**
 * The Quick Keys editor: one row per alias, an alias field and a target list to add one, and
 * Reset (as macOS's "Reset quick keys").
 */
function quickKeysGroup(settings, _) {
    const key = 'spotlight-quick-keys';
    const group = new Adw.PreferencesGroup({
        title: _('Quick Keys'),
        description: _('Type a short alias in Spotlight to run an action or open an app. Words after it are the action’s value, as in “tm 5” for a 5-minute timer.'),
    });
    const targets = quickKeyTargets(_);
    const labelOf = t => targets.find(x => x.target === t)?.label ?? t;

    const alias = new Adw.EntryRow({ title: _('Alias (1–12 lowercase letters or digits)') });
    const target = new Adw.ComboRow({ title: _('Runs'), model: Gtk.StringList.new(targets.map(t => t.label)) });
    const add = new Gtk.Button({ label: _('Add'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action'], sensitive: false });
    target.add_suffix(add);
    alias.connect('changed', () => {
        const ok = validAlias(alias.text);
        add.sensitive = ok;
        if (ok || !alias.text)
            alias.remove_css_class('error');
        else
            alias.add_css_class('error');
    });
    add.connect('clicked', () => {
        const t = targets[target.selected];
        if (!t || !validAlias(alias.text))
            return;
        settings.set_strv(key, addQuickKey(settings.get_strv(key), alias.text, t.target));
        alias.text = '';
    });
    group.add(alias);
    group.add(target);

    let rows = [];
    const sync = () => {
        for (const r of rows)
            group.remove(r);
        rows = parseQuickKeys(settings.get_strv(key)).map(q => {
            const row = new Adw.ActionRow({ title: q.alias, subtitle: labelOf(q.target) });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                tooltip_text: _('Remove'),
            });
            remove.update_property([Gtk.AccessibleProperty.LABEL], [`${_('Remove')} ${q.alias}`]);
            remove.connect('clicked', () => settings.set_strv(key, removeQuickKey(settings.get_strv(key), q.alias, q.target)));
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
    };
    sync();
    watchKey(settings, key, group, sync);

    const reset = new Gtk.Button({ label: _('Reset Quick Keys'), valign: Gtk.Align.CENTER, css_classes: ['flat'] });
    reset.connect('clicked', () => settings.set_strv(key, []));
    group.set_header_suffix(reset);
    return group;
}

/** Search history: on like macOS, with Clear History. */
function historyGroup(settings, _) {
    const group = new Adw.PreferencesGroup({ title: _('History') });
    group.add(switchRow(settings, _('Search history'),
        _('Recent searches and opened results show in the empty field; Up recalls past searches. Turning it off clears them'),
        'spotlight-history'));
    const clear = new Adw.ButtonRow({ title: _('Clear History') });
    const syncClear = () => {
        clear.sensitive = settings.get_strv('spotlight-history-queries').length > 0 ||
            settings.get_strv('spotlight-recent-results').length > 0;
    };
    syncClear();
    watchKey(settings, 'spotlight-history-queries', clear, syncClear);
    watchKey(settings, 'spotlight-recent-results', clear, syncClear);
    clear.connect('activated', () => {
        settings.set_strv('spotlight-history-queries', []);
        settings.set_strv('spotlight-recent-results', []);
    });
    group.add(clear);
    return group;
}

/**
 * @param {{settings: Gio.Settings, window: Adw.PreferencesWindow, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);

    const main = new Adw.PreferencesGroup({
        title: _('Spotlight'),
        description: _('A search bar in the middle of the screen. Apps, settings, files, the clipboard, a calculator and the web.'),
    });
    const enable = switchRow(settings, _('Enable Spotlight'), _('Search from the keyboard'), 'spotlight');
    main.add(enable);
    main.add(switchRow(settings, _('Open with a tap of Super'),
        _('The Activities overview stays on the hot corner, the touchpad gesture, Super+A and the Activities button'),
        'spotlight-on-super'));
    main.add(shortcutRow(settings, _, { key: 'spotlight-shortcut', title: _('Extra shortcut'), example: '<Super>slash', onNote: note => {
        main.description = note || _('A search bar in the middle of the screen. Apps, settings, files, the clipboard, a calculator and the web.');
    } }));

    const what = new Adw.PreferencesGroup({ title: _('Results') });
    what.add(switchRow(settings, _('Files and documents'), _('Uses GNOME search, so nothing is indexed twice'), 'spotlight-files'));
    what.add(switchRow(settings, _('Settings'), _('GNOME Settings panels and Guava switches'), 'spotlight-settings'));
    what.add(switchRow(settings, _('Calculator'), _('Arithmetic and unit conversions such as 5 km in miles'), 'spotlight-calculator'));
    what.add(switchRow(settings, _('Clipboard'), _('Search your copies from Clipboard history'), 'spotlight-clipboard'));
    const recentClips = switchRow(settings, _('Show recent clipboard when the search is empty'),
        _('Anyone who can see the screen sees what you copied'), 'spotlight-recent-clipboard');
    settings.bind('spotlight-clipboard', recentClips, 'sensitive', Gio.SettingsBindFlags.GET);
    what.add(recentClips);

    what.add(switchRow(settings, _('Actions'),
        _('Show Desktop, Lock Screen, timers, Do Not Disturb, Dark Mode, Empty Trash, screenshots and the actions apps offer'),
        'spotlight-actions'));
    what.add(switchRow(settings, _('Menu items of the focused app'),
        _('From Guava’s menu bar. Tab scopes the search to them'), 'spotlight-menu-items'));

    const tahoe = new Adw.PreferencesGroup({ title: _('Browse and Preview') });
    tahoe.add(switchRow(settings, _('Browse views'),
        _('Applications, Files, Actions and Clipboard buttons next to the empty field; Super+1 to Super+4 open them'),
        'spotlight-views'));
    tahoe.add(switchRow(settings, _('Quick Look'),
        _('Space previews the selected file with GNOME’s previewer (install Sushi)'), 'spotlight-quick-look'));

    const web = new Adw.PreferencesGroup({ title: _('Web') });
    web.add(switchRow(settings, _('Web search'), _('Adds a row that opens your search engine. Nothing is sent until you press Return'), 'spotlight-web'));
    for (const row of engineRows(settings, _))
        web.add(row);

    return [main, what, tahoe, quickKeysGroup(settings, _), historyGroup(settings, _), web];
}
