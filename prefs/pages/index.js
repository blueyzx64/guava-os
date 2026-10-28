// SPDX-License-Identifier: GPL-3.0-or-later
// The sidebar of the preferences window: sections and their pages, in macOS System Settings
// order. A page whose content is only one feature's groups is declared here; a page that
// combines several (or adds its own rows) has its own module in this folder.

import Adw from 'gi://Adw';

import * as general from './general.js';
import * as loginItems from './loginItems.js';
import * as menuBar from './menuBar.js';
import * as dock from './dock.js';
import * as windows from './windows.js';
import * as navigation from './navigation.js';
import * as appearance from './appearance.js';
import * as notifications from './notifications.js';
import * as keyboard from './keyboard.js';
import * as about from './about.js';
import * as controlCenter from './controlCenter.js';
import * as stageManagerPrefs from '../../features/stageManager/prefs.js';
import * as missionControlPrefs from '../../features/missionControl/prefs.js';
import * as notchPrefs from '../../features/notch/prefs.js';
import * as spotlightPrefs from '../../features/spotlight/prefs.js';
import * as clipboardPrefs from '../../features/clipboard/prefs.js';
import * as widgetsPrefs from '../../features/widgets/prefs.js';
import * as desktopIconsPrefs from '../../features/desktopIcons/prefs.js';
import * as screenshotsPrefs from '../../features/screenshots/prefs.js';
import { addFeatureGroups } from '../widgets.js';

const N_ = s => s;

/** A page made of one feature's prefs groups. */
function featurePage(id, title, icon, mod) {
    return {
        PAGE: { id, icon },
        build(args) {
            const page = new Adw.PreferencesPage({ title: args._(title), icon_name: icon });
            addFeatureGroups(page, mod, args);
            return page;
        },
    };
}

/** [{title, pages: [module with PAGE and build(args)]}] */
export const SECTIONS = [
    { title: N_('General'), pages: [general, loginItems] },
    { title: N_('Desktop'), pages: [menuBar, dock, windows, navigation,
        featurePage('mission-control', N_('Mission Control'), 'view-grid-symbolic', missionControlPrefs),
        featurePage('stage-manager', N_('Stage Manager'), 'view-app-grid-symbolic', stageManagerPrefs),
        featurePage('desktop-icons', N_('Desktop Icons'), 'user-desktop-symbolic', desktopIconsPrefs),
        featurePage('widgets', N_('Widgets'), 'preferences-desktop-apps-symbolic', widgetsPrefs)] },
    { title: N_('Features'), pages: [
        notifications,
        featurePage('notch', N_('Notch'), 'preferences-system-notifications-symbolic', notchPrefs),
        featurePage('spotlight', N_('Spotlight'), 'system-search-symbolic', spotlightPrefs),
        controlCenter,
        featurePage('clipboard', N_('Clipboard'), 'edit-paste-symbolic', clipboardPrefs),
        featurePage('screenshots', N_('Screenshots'), 'camera-photo-symbolic', screenshotsPrefs),
        keyboard,
    ] },
    { title: N_('Look'), pages: [appearance] },
    { title: N_('Guava'), pages: [about] },
];
