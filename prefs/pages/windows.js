// SPDX-License-Identifier: GPL-3.0-or-later
// Windows: the buttons of the apps' own titlebars, tiling and Hide,
// full screen Spaces, rounded corners and Show Desktop.

import Adw from 'gi://Adw';

import * as appButtonsPrefs from '../../features/appButtons/prefs.js';
import * as windowsPrefs from '../../features/windows/prefs.js';
import * as roundedCornersPrefs from '../../features/roundedCorners/prefs.js';
import * as showDesktopPrefs from '../../features/showDesktop/prefs.js';
import { addFeatureGroups, shortcutRow, switchRow } from '../widgets.js';

export const PAGE = { id: 'windows', icon: 'guava-buttons-symbolic' };

export function build(args) {
    const { settings, _ } = args;
    const page = new Adw.PreferencesPage({ title: _('Windows'), icon_name: PAGE.icon });

    addFeatureGroups(page, appButtonsPrefs, args);
    addFeatureGroups(page, windowsPrefs, args);

    const spaces = new Adw.PreferencesGroup({ title: _('Full Screen') });
    spaces.add(switchRow(settings, _('Full Screen in Its Own Space'),
        _('A window that goes full screen moves to a new workspace of its own, and back when it leaves full screen'),
        'move-window-to-new-workspace'));
    spaces.add(switchRow(settings, _('Split View'),
        _('Tile a full-screen window to the left or right of the screen with a shortcut, then pick the other window'),
        'split-view'));
    for (const [key, title, example] of [
        ['split-view-left-shortcut', _('Split View: Tile Left'), '<Control><Super><Alt>Left'],
        ['split-view-right-shortcut', _('Split View: Tile Right'), '<Control><Super><Alt>Right'],
    ])
        spaces.add(shortcutRow(settings, _, { key, title, example }));
    page.add(spaces);

    addFeatureGroups(page, roundedCornersPrefs, args);
    addFeatureGroups(page, showDesktopPrefs, args);
    return page;
}
