// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications & Focus: the Notification Center column and the Focus modes, as macOS System
// Settings puts them side by side.

import Adw from 'gi://Adw';

import { addFeatureGroups } from '../widgets.js';
import * as notificationCenterPrefs from '../../features/notificationCenter/prefs.js';
import * as focusPrefs from '../../features/focus/prefs.js';

export const PAGE = { id: 'notifications', icon: 'preferences-system-notifications-symbolic' };

export function build(args) {
    const page = new Adw.PreferencesPage({ title: args._('Notifications & Focus'), icon_name: PAGE.icon });
    addFeatureGroups(page, notificationCenterPrefs, args);
    addFeatureGroups(page, focusPrefs, args);
    return page;
}
