// SPDX-License-Identifier: GPL-3.0-or-later
// General: how the Shell itself behaves, and the reset.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { addSwitchRows } from '../widgets.js';

/**
 * Keys Reset Everything leaves alone, read from the schema so a new cache cannot be missed:
 * Guava's own bookkeeping (summary ends with "(internal)": it is what puts the user's GNOME
 * settings back) and the dropped 2.x keys (summary starts "(Deprecated, unused)": some hold
 * restore records a migration still needs).
 */
const keepOnReset = (schema, key) => {
    const summary = schema.get_key(key).get_summary() ?? '';
    return summary.endsWith('(internal)') || summary.startsWith('(Deprecated, unused)');
};

export const PAGE = { id: 'general', icon: 'preferences-system-symbolic' };

export function build({ settings, window, _ }) {
    const page = new Adw.PreferencesPage({ title: _('General'), icon_name: PAGE.icon });

    const gestures = new Adw.PreferencesGroup({ title: _('Overview and gestures') });
    addSwitchRows(settings, gestures, [
        { key: 'overview-gestures-workspace-only', title: _('Swipe Up to Workspaces Only'), subtitle: _('Swiping up opens the workspace overview and never the app grid. The apps button and Super+A still show it') },
        { key: 'disable-hot-corner', title: _('Disable Hot Corner'), subtitle: _('Pointing at the top-left corner does not open the overview') },
    ]);
    page.add(gestures);

    const reset = new Adw.PreferencesGroup();
    const button = new Gtk.Button({
        label: _('Reset Everything'),
        halign: Gtk.Align.CENTER,
        margin_top: 12,
        margin_bottom: 12,
        tooltip_text: _('Reset every Guava setting to its default value'),
        css_classes: ['pill', 'destructive-action'],
    });
    button.connect('clicked', () => {
        const dialog = new Adw.AlertDialog({
            heading: _('Reset Every Guava Setting?'),
            body: _('Every Guava setting goes back to its default, the macOS one. This cannot be undone.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset Everything'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response !== 'reset')
                return;
            // One write for all keys: the Shell then evaluates its features once
            const schema = settings.settings_schema;
            settings.delay();
            schema.list_keys()
                .filter(key => !keepOnReset(schema, key))
                .forEach(key => settings.reset(key));
            settings.apply();
        });
        dialog.present(window);
    });
    reset.add(button);
    page.add(reset);
    return page;
}
