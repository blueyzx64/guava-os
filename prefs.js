// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// The preferences window of Guava OS. Runs in the separate prefs process (Adw/Gtk only, never
// Shell modules): builds the sidebar sections from prefs/pages/index.js, loads the shared CSS
// and icons, and offers the Setup Assistant on the first run.

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { buildNavigation } from './prefs/window.js';
import { watchWindowClose } from './prefs/widgets.js';
import { plainTextTree } from './prefs/plainText.js';
import { SECTIONS } from './prefs/pages/index.js';
import { presentAssistant } from './prefs/setupAssistant.js';
import { ONBOARDING_KEY, shouldPresent } from './features/onboarding/model.js';

const DEFAULT_WIDTH = 920;
const DEFAULT_HEIGHT = 720;

// Shared look: icons and CSS. A failure costs the styling, never the window.
function loadResources(path) {
    const display = Gdk.Display.get_default();
    if (!display)
        return;
    try {
        Gtk.IconTheme.get_for_display(display).add_search_path(`${path}/icons`);
    } catch (e) {
        console.error('[Guava] prefs icons failed to load:', e);
    }
    try {
        const provider = new Gtk.CssProvider();
        provider.load_from_path(`${path}/prefs/prefs.css`);
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    } catch (e) {
        console.error('[Guava] prefs CSS failed to load:', e);
    }
}

export default class GuavaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        watchWindowClose(window);
        const title = _('Guava OS');
        window.title = title;
        window.set_default_size(DEFAULT_WIDTH, DEFAULT_HEIGHT);
        window.set_search_enabled(false);
        loadResources(this.path);

        // Pages push the Adw.Breakpoints that reflow them into this list; the window measures
        // the page area, not itself.
        const breakpoints = [];
        const args = { settings, window, extension: this, _, breakpoints, title };

        const sections = SECTIONS.map(section => ({
            title: _(section.title),
            pages: section.pages.map(page => buildPage(page, args)).filter(Boolean),
        }));
        buildNavigation(window, { sections, pageBreakpoints: breakpoints, title, _ });
        // Titles such as "Left & Right" are plain text, not markup (else the row shows no text)
        plainTextTree(window);

        if (shouldPresent(settings.get_string(ONBOARDING_KEY))) {
            const id = window.connect('map', () => {
                window.disconnect(id);
                presentAssistant(args);
            });
        }
    }
}

// A page that fails to build is logged and skipped; the rest of the window still opens.
function buildPage(page, args) {
    try {
        return page.build(args);
    } catch (e) {
        console.error(`[Guava] prefs page '${page.PAGE?.id}' failed to build:`, e);
        return null;
    }
}
