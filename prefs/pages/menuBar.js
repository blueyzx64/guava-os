// SPDX-License-Identifier: GPL-3.0-or-later
// Menu Bar: the macOS menu bar (features/menuBar/prefs.js), what else the top bar holds, and
// where volume and brightness show (features/osd/prefs.js).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { addFeatureGroups, comboRow, switchRow, watchKey } from '../widgets.js';
import * as menuBarPrefs from '../../features/menuBar/prefs.js';
import * as osdPrefs from '../../features/osd/prefs.js';
import * as menuBarItemsPrefs from '../../features/menuBarItems/prefs.js';

export const PAGE = { id: 'menu-bar', icon: 'focus-top-bar-symbolic' };

export function build(args) {
    const { settings, _ } = args;
    const page = new Adw.PreferencesPage({ title: _('Menu Bar'), icon_name: PAGE.icon });
    addFeatureGroups(page, menuBarPrefs, args);

    const bar = new Adw.PreferencesGroup({ title: _('Top bar') });
    bar.add(switchRow(settings, _('Activities Button'),
        _("Show GNOME's Activities button at the left of the bar. macOS has none"), 'menubar-show-activities'));

    // The clock on the right, macOS-style; the notch forces it (it owns the centre)
    const calendar = new Adw.ExpanderRow({
        title: _('Clock on the Right'),
        subtitle: _('The clock and calendar move to the right end; notifications move to Quick Settings'),
        show_enable_switch: true,
    });
    settings.bind('move-calendar-right', calendar, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    const calendarSubtitle = calendar.subtitle;
    const syncNotch = () => {
        const notch = settings.get_boolean('notch');
        calendar.sensitive = !notch;
        calendar.subtitle = notch ? _('On while the notch is on') : calendarSubtitle;
    };
    syncNotch();
    watchKey(settings, 'notch', calendar, syncNotch);
    calendar.add_row(comboRow(settings, {
        title: _('Notification Dot'), subtitle: _('Colour of the dot that shows waiting notifications'),
        key: 'notification-indicator-style', values: ['default', 'accent', 'symbolic'],
        labels: [_('Red'), _('Accent'), _('Symbolic')],
    }));
    calendar.add_row(switchRow(settings, _('Keep GNOME Notification Panel'),
        _("Don't split notification and calendar layout"), 'keep-notification-panel'));
    bar.add(calendar);

    // The Control Center has a Do Not Disturb tile of its own and takes over while it is on
    const dnd = switchRow(settings, _('Do Not Disturb Button'),
        _("Guava's moon button in Quick Settings and the top bar, in place of GNOME's"), 'custom-dnd-button');
    const dndSubtitle = dnd.subtitle;
    const syncCc = () => {
        const cc = settings.get_boolean('control-center');
        dnd.sensitive = !cc;
        dnd.subtitle = cc ? _('The Control Center has its own Do Not Disturb tile') : dndSubtitle;
    };
    syncCc();
    watchKey(settings, 'control-center', dnd, syncCc);
    bar.add(dnd);
    page.add(bar);
    addFeatureGroups(page, osdPrefs, args);
    addFeatureGroups(page, menuBarItemsPrefs, args);
    return page;
}
