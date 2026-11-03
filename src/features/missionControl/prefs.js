// SPDX-License-Identifier: GPL-3.0-or-later
// Mission Control preferences (macOS: Desktop & Dock ▸ Mission Control). Adw/Gtk/Gio only.
// buildPrefs() returns the Adw.PreferencesGroup[]; prefs/pages/index.js places them on a page.

import Adw from 'gi://Adw';

import { addSwitchRows, shortcutRow, switchRow } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);

    const main = new Adw.PreferencesGroup({
        title: _('Mission Control'),
        description: _('Mission Control shows the windows of the current Space side by side, with your Spaces along the top. Swipe up with three fingers, or press F3 or Control+Up.'),
    });
    main.add(switchRow(settings, _('Mission Control'),
        _('Replaces the Activities overview. The app grid stays on Launchpad and Super+A.'), 'mission-control'));
    addSwitchRows(settings, main, [
        { key: 'mc-rearrange-spaces', title: _('Automatically rearrange Spaces based on most recent use') },
        { key: 'mc-switch-to-app-space', title: _('When switching to an application, switch to a Space with open windows for the application'),
            subtitle: _('Off: the app switcher lists only the windows of the current Space') },
        { key: 'mc-group-by-app', title: _('Group windows by application') },
        { key: 'mc-static-spaces', title: _('Keep Spaces until you remove them'),
            subtitle: _('Empty Spaces stay, and the Spaces bar has + and × buttons. Off: GNOME adds and removes workspaces by itself.') },
        { key: 'mc-start-on-desktop', title: _('Start on the desktop'),
            subtitle: _('Show the desktop after you log in, not the overview') },
    ]);

    const keys = new Adw.PreferencesGroup({
        title: _('Shortcuts'),
        description: _('App Exposé shows all windows of the front app; its minimized windows wait along the bottom. The dock\'s "Show All Windows" opens it too.'),
    });
    keys.add(shortcutRow(settings, _, { key: 'mission-control-shortcut', title: _('Mission Control'), example: 'F3' }));
    keys.add(shortcutRow(settings, _, { key: 'app-expose-shortcut', title: _('App Exposé'), example: '<Control>Down' }));

    return [main, keys];
}
