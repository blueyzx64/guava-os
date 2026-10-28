// SPDX-License-Identifier: GPL-3.0-or-later
// Menu Bar preferences: the logo menu, the app menus, the transparent bar, full screen,
// privacy dots and the keyboard. Adw/Gtk/Gio only (the prefs process).
// prefs/pages/menuBar.js puts these groups on the Menu Bar page.

import Adw from 'gi://Adw';

import { comboRow, shortcutRow, switchRow } from '../../prefs/widgets.js';

/**
 * @param {{settings: Gio.Settings, extension: object}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, extension }) {
    const _ = s => extension.gettext(s);

    const bar = new Adw.PreferencesGroup({
        title: _('Menu Bar'),
        description: _('The logo menu, the app’s name and menus, then the status items, the Control Center and the clock, as on macOS.'),
    });
    bar.add(comboRow(settings, {
        title: _('Logo Menu'), subtitle: _('About This PC, System Settings, Force Quit, Sleep, Restart, Shut Down, Lock Screen and Log Out'),
        key: 'menubar-logo', values: ['fedora', 'guava', 'none'],
        labels: [_('System Logo'), _('Guava Logo'), _('None')],
    }));
    bar.add(switchRow(settings, _('App Menus'),
        _('The focused app’s name in bold and its menus: App, File, Edit, Window and Help'), 'menubar-app-menu'));
    bar.add(switchRow(settings, _('Apps’ Own Menus'),
        _('Show the menus apps export (GTK menu bars, and Qt, Electron or LibreOffice under Xwayland) in place of the generic File, Edit and View'),
        'menubar-native-menus'));
    bar.add(switchRow(settings, _('Transparent Menu Bar'),
        _('No background over the wallpaper, with text that follows its brightness'),
        'menubar-transparent'));
    bar.add(switchRow(settings, _('Solid When a Window Touches It'),
        _('Off: the bar stays transparent over maximized windows. On: it turns solid while a window touches it'),
        'menubar-solid-on-window'));
    bar.add(switchRow(settings, _('Always Show Menu Bar in Full Screen'),
        _('Off: the menu bar hides in full screen and slides in when the pointer touches the top edge'),
        'menubar-fullscreen-visible'));
    bar.add(switchRow(settings, _('Privacy Dots'),
        _('Orange for the microphone, green for the camera, purple for screen sharing. Click to see which app'),
        'menubar-privacy-dots'));
    bar.add(switchRow(settings, _('Alt-Click the Clock for Do Not Disturb'),
        _('Clicking the clock opens the calendar and notifications'), 'menubar-clock-option-dnd'));

    const lab = new Adw.PreferencesGroup({
        title: _('Experimental'),
        description: _('Menus read from the accessibility tree. Apps must expose it (GTK always does; Firefox, Chromium and Qt only with accessibility turned on).'),
    });
    lab.add(switchRow(settings, _('Read Menus Through Accessibility'),
        _('Mirror the menu bar inside windows of apps that do not export their menus'), 'menubar-atspi-menus'));
    lab.add(switchRow(settings, _('Read Primary Menus'),
        _('For apps without a menu bar, open the ☰ menu out of sight, read it into the app menu and remember it. The app sees its menu open and close'),
        'menubar-atspi-popovers'));

    const keys = new Adw.PreferencesGroup({ title: _('Keyboard') });
    keys.add(switchRow(settings, _('Shortcut Symbols'),
        _('Write shortcuts in menus as ⌘ ⌥ ⌃ ⇧ (Super is ⌘). Off writes them in words'), 'menubar-command-glyphs'));
    keys.add(shortcutRow(settings, _, { key: 'menubar-focus-shortcut', title: _('Use the Menu Bar with the Keyboard'), example: '<Control>F2' }));
    keys.add(shortcutRow(settings, _, { key: 'menubar-force-quit-shortcut', title: _('Force Quit Applications'), example: '<Super><Alt>Escape' }));

    return [bar, keys, lab];
}
