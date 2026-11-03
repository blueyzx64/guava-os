// SPDX-License-Identifier: GPL-3.0-or-later
// Control Center: its layout and details (features/controlCenter/prefs.js) and Low Power
// Mode (features/lowPower/prefs.js), which has a control there and a row in the Battery item.

import Adw from 'gi://Adw';

import { addFeatureGroups } from '../widgets.js';
import * as controlCenterPrefs from '../../features/controlCenter/prefs.js';
import * as lowPowerPrefs from '../../features/lowPower/prefs.js';

export const PAGE = { id: 'control-center', icon: 'preferences-system-symbolic' };

export function build(args) {
    const page = new Adw.PreferencesPage({ title: args._('Control Center'), icon_name: PAGE.icon });
    addFeatureGroups(page, controlCenterPrefs, args);
    addFeatureGroups(page, lowPowerPrefs, args);
    return page;
}
