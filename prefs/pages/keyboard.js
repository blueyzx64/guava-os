// SPDX-License-Identifier: GPL-3.0-or-later
// Keyboard: the text-cursor indicators and Emoji & Symbols (macOS System Settings > Keyboard).

import Adw from 'gi://Adw';

import * as inputIndicatorPrefs from '../../features/inputIndicator/prefs.js';
import * as emojiPrefs from '../../features/emoji/prefs.js';
import { addFeatureGroups } from '../widgets.js';

export const PAGE = { id: 'keyboard', icon: 'input-keyboard-symbolic' };

export function build(args) {
    const page = new Adw.PreferencesPage({ title: args._('Keyboard'), icon_name: PAGE.icon });
    addFeatureGroups(page, inputIndicatorPrefs, args);
    addFeatureGroups(page, emojiPrefs, args);
    return page;
}
