// SPDX-License-Identifier: GPL-3.0-or-later
// Window tiling and Hide preferences, in macOS terms (System Settings › Desktop & Dock ›
// Windows). Adw/Gtk/Gio only: runs in the prefs process. Placed on the Windows page.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { shortcutRow, switchRow } from '../../prefs/widgets.js';

const N_ = s => s;

// Same order as model.js SHORTCUTS, with the labels the prefs show
const TILE_SHORTCUTS = [
    ['windows-tile-left-shortcut', N_('Left'), '<Control><Super>Left'],
    ['windows-tile-right-shortcut', N_('Right'), '<Control><Super>Right'],
    ['windows-tile-top-shortcut', N_('Top'), '<Control><Super>Up'],
    ['windows-tile-bottom-shortcut', N_('Bottom'), '<Control><Super>Down'],
    ['windows-fill-shortcut', N_('Fill'), '<Control><Super>f'],
    ['windows-center-shortcut', N_('Center'), '<Control><Super>c'],
    ['windows-restore-shortcut', N_('Return to Previous Size'), '<Control><Super>r'],
];
const ARRANGE_SHORTCUTS = [
    ['windows-arrange-left-right-shortcut', N_('Left & Right'), '<Control><Super><Shift>Left'],
    ['windows-arrange-right-left-shortcut', N_('Right & Left'), '<Control><Super><Shift>Right'],
    ['windows-arrange-top-bottom-shortcut', N_('Top & Bottom'), '<Control><Super><Shift>Up'],
    ['windows-arrange-bottom-top-shortcut', N_('Bottom & Top'), '<Control><Super><Shift>Down'],
    ['windows-arrange-left-quarters-shortcut', N_('Left & Quarters'), '<Control><Super><Alt><Shift>Left'],
    ['windows-arrange-right-quarters-shortcut', N_('Right & Quarters'), '<Control><Super><Alt><Shift>Right'],
    ['windows-arrange-top-quarters-shortcut', N_('Top & Quarters'), '<Control><Super><Alt><Shift>Up'],
    ['windows-arrange-bottom-quarters-shortcut', N_('Bottom & Quarters'), '<Control><Super><Alt><Shift>Down'],
];

function shortcutExpander(settings, _, title, subtitle, list) {
    const row = new Adw.ExpanderRow({ title, subtitle: subtitle ?? '' });
    for (const [key, label, example] of list)
        row.add_row(shortcutRow(settings, _, { key, title: _(label), example }));
    return row;
}

/**
 * @param {{settings: Gio.Settings, _: Function}} args
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildPrefs({ settings, _ }) {
    const tiling = new Adw.PreferencesGroup({
        title: _('Tiling'),
        description: _('Drag windows to the edges, corners or top bar (dragging to the top centre opens the snap layouts), or use the shortcuts. ' +
            'GNOME\'s own edge tiling is off while this is on and comes back when it is turned off.'),
    });
    tiling.add(switchRow(settings, _('Tile Windows'),
        _('Guava\'s macOS-style tiling: halves, quarters, Fill, arrangements'), 'windows-tiling'));
    const rows = [
        switchRow(settings, _('Drag windows to screen edges to tile'),
            _('Left or right edge for a half, a corner for a quarter'), 'windows-tile-drag-edges'),
        switchRow(settings, _('Drag windows to top bar to fill screen'),
            _('Fills the screen without going full screen'), 'windows-tile-drag-menubar'),
        switchRow(settings, _('Snap layouts at the top centre'),
            _('Drag to the middle of the top edge: a handle appears, move onto it for a bar of layouts (halves, thirds, quarters), then drop on a zone'),
            'windows-tile-drag-picker'),
        switchRow(settings, _('Hold Alt key while dragging windows to tile'),
            _('Shows the half outlines at once, without reaching the edge (the macOS Option key)'),
            'windows-tile-drag-modifier'),
        switchRow(settings, _('Tiled windows have margins'),
            _('A small gap around and between tiled windows'), 'windows-tile-margins'),
        shortcutExpander(settings, _, _('Move & Resize Shortcuts'),
            _('macOS uses Fn-Control; Guava uses Ctrl+Super. A shortcut GNOME or Stage Manager already uses is left unbound'),
            TILE_SHORTCUTS),
        shortcutExpander(settings, _, _('Arrange Shortcuts'),
            _('The focused window takes the first place, the windows used before it the others'),
            ARRANGE_SHORTCUTS),
    ];
    for (const row of rows) {
        settings.bind('windows-tiling', row, 'sensitive', Gio.SettingsBindFlags.GET);
        tiling.add(row);
    }

    const hide = new Adw.PreferencesGroup({ title: _('Hide') });
    hide.add(switchRow(settings, _('Hide and Hide Others'),
        _('Hide an app: its windows leave the screen without an animation and come back together when you switch to it'),
        'windows-app-hide'));
    for (const [key, title, example] of [
        ['windows-hide-shortcut', _('Hide shortcut'), '<Super>h'],
        ['windows-hide-others-shortcut', _('Hide Others shortcut'), '<Alt><Super>h'],
    ]) {
        const row = shortcutRow(settings, _, { key, title, example });
        settings.bind('windows-app-hide', row, 'sensitive', Gio.SettingsBindFlags.GET);
        hide.add(row);
    }
    hide.description = _('Super+H is GNOME\'s minimize shortcut: Guava borrows it while Hide uses it, and gives it back when Hide is off.');
    return [tiling, hide];
}
