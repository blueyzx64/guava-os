// SPDX-License-Identifier: GPL-3.0-or-later
// Hot corner preferences (Adw/Gtk/Gio only; prefs/pages/navigation.js places them).

import Adw from 'gi://Adw';

import { DESKTOP_ACTIONS } from '../../core/desktopActionsModel.js';
import { comboRow } from '../../prefs/widgets.js';
import { CORNERS, MODIFIERS, actionKey, modifierKey } from './model.js';

/** @returns {Adw.PreferencesGroup[]} */
export function buildPrefs({ settings, _ }) {
    const actionLabels = {
        'none': _('Nothing'),
        'mission-control': _('Mission Control'),
        'app-expose': _('Application Windows'),
        'desktop': _('Desktop'),
        'notification-center': _('Notification Center'),
        'launchpad': _('Launchpad'),
        'lock-screen': _('Lock Screen'),
        'display-sleep': _('Put Display to Sleep'),
    };
    const modifierLabels = {
        'none': _('No Key'), 'shift': _('Shift'), 'ctrl': _('Ctrl'), 'alt': _('Alt'), 'super': _('Super'),
    };
    const cornerTitles = {
        'top-left': _('Top Left'), 'top-right': _('Top Right'),
        'bottom-left': _('Bottom Left'), 'bottom-right': _('Bottom Right'),
    };
    const group = new Adw.PreferencesGroup({
        title: _('Hot Corners'),
        description: _('Push the pointer into a corner of the screen to start an action. Choose a key to hold so a corner never fires by accident.'),
    });
    for (const corner of CORNERS) {
        const row = new Adw.ExpanderRow({ title: cornerTitles[corner] });
        const action = comboRow(settings, {
            title: _('Action'), subtitle: _('What the corner does'), key: actionKey(corner),
            values: [...DESKTOP_ACTIONS], labels: DESKTOP_ACTIONS.map(a => actionLabels[a]),
        });
        const modifier = comboRow(settings, {
            title: _('Only While Holding'), subtitle: _('A key that must be down, so the corner never fires by accident'), key: modifierKey(corner),
            values: [...MODIFIERS], labels: MODIFIERS.map(m => modifierLabels[m]),
        });
        const sync = () => {
            row.subtitle = actionLabels[settings.get_string(actionKey(corner))] ?? actionLabels.none;
            modifier.sensitive = settings.get_string(actionKey(corner)) !== 'none';
        };
        sync();
        const id = settings.connect(`changed::${actionKey(corner)}`, sync);
        row.connect('destroy', () => settings.disconnect(id));
        row.add_row(action);
        row.add_row(modifier);
        group.add(row);
    }
    return [group];
}
