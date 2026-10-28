/*
 * Guava OS – macOS-inspired enhancements for GNOME Shell.
 * Copyright (C) 2025  Arnis Kemlers
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Guava preferences: the window shell (prefs/window.js) and its pages (prefs/pages/). Each
// page builds from the feature prefs in features/<name>/prefs.js. Runs in its own process
// (Adw/Gtk only; never Shell modules).

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { buildNavigation } from './prefs/window.js';
import { SECTIONS } from './prefs/pages/index.js';
import { presentAssistant } from './prefs/setupAssistant.js';
import { ONBOARDING_KEY, shouldPresent } from './features/onboarding/model.js';

export default class GuavaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const title = _('Guava OS');
        window.title = title;
        // Wide enough for the sidebar and a page side by side; narrower windows collapse to a
        // list of pages (prefs/window.js).
        window.set_default_size(920, 720);
        // The sidebar has its own search, which also finds rows inside expanders
        window.set_search_enabled(false);

        const display = Gdk.Display.get_default();
        Gtk.IconTheme.get_for_display(display).add_search_path(GLib.build_filenamev([this.path, 'icons']));
        const css = new Gtk.CssProvider();
        css.load_from_path(GLib.build_filenamev([this.path, 'prefs', 'prefs.css']));
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        // Breakpoints that measure the page area, not the whole window
        const breakpoints = [];
        const args = { settings, window, extension: this, _, breakpoints, title };
        const sections = SECTIONS.map(section => ({
            title: _(section.title),
            pages: section.pages.map(mod => mod.build(args)),
        }));
        buildNavigation(window, { sections, pageBreakpoints: breakpoints, title, _ });

        // The Shell opened the preferences for the first-run Setup Assistant
        if (shouldPresent(settings.get_string(ONBOARDING_KEY))) {
            const id = window.connect('map', () => {
                window.disconnect(id);
                presentAssistant(args);
            });
        }
    }
}
