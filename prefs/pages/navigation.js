// SPDX-License-Identifier: GPL-3.0-or-later
// Switcher, Gestures & Corners: the macOS app switcher, trackpad gestures and hot corners.

import Adw from 'gi://Adw';

import * as switcherPrefs from '../../features/switcher/prefs.js';
import * as gesturesPrefs from '../../features/gestures/prefs.js';
import * as hotCornersPrefs from '../../features/hotCorners/prefs.js';
import { addFeatureGroups } from '../widgets.js';

export const PAGE = { id: 'navigation', icon: 'input-touchpad-symbolic' };

export function build(args) {
    const page = new Adw.PreferencesPage({ title: args._('Gestures & Corners'), icon_name: PAGE.icon });
    addFeatureGroups(page, switcherPrefs, args);
    addFeatureGroups(page, gesturesPrefs, args);
    addFeatureGroups(page, hotCornersPrefs, args);
    return page;
}
