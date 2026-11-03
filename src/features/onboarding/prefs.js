// SPDX-License-Identifier: GPL-3.0-or-later
// Setup Assistant preferences: the "run it again" row on the About page. Adw/Gtk only.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { presentAssistant } from '../../prefs/setupAssistant.js';

/**
 * @param {{settings, window, extension, _}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs(args) {
    const { _ } = args;
    const group = new Adw.PreferencesGroup();
    const row = new Adw.ActionRow({
        title: _('Setup Assistant'),
        subtitle: _('Choose your look, Dock, menu bar and privacy options again'),
        activatable: true,
    });
    const run = new Gtk.Button({ label: _('Run Again…'), valign: Gtk.Align.CENTER });
    run.connect('clicked', () => presentAssistant(args));
    row.add_suffix(run);
    row.set_activatable_widget(run);
    group.add(row);
    return [group];
}
