// SPDX-License-Identifier: GPL-3.0-or-later
// Control Center: its layout and details (features/controlCenter/prefs.js) and Low Power
// Mode (features/lowPower/prefs.js), which has a control there and a row in the Battery item.

import Adw from 'gi://Adw';

import { addFeatureGroups } from '../widgets.js';
import * as lowPowerPrefs from '../../features/lowPower/prefs.js';

export const PAGE = { id: 'control-center', icon: 'battery-symbolic' };

export function build(args) {
    const page = new Adw.PreferencesPage({ title: args._('Battery'), icon_name: PAGE.icon });
    // GNOME's own Quick Settings: Guava's Control Center (control-center) is off and has no rows,
    // nor have the options that only exist inside it (user row, battery percentage). Its code and
    // prefs module stay (features/controlCenter)
    addFeatureGroups(page, lowPowerPrefs, args);
    return page;
}
