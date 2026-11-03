# Preferences with libadwaita (prefs.js)

Summary: how to build `prefs.js` pages with Adw (PreferencesPage, Group, ActionRow, SwitchRow, ExpanderRow, ComboRow, SpinRow, ButtonRow) and bind them to GSettings.
It also covers enums and string lists, keyboard-shortcut capture, prefs-side CSS, and cleanup on `close-request`.
Prefs run in a separate GTK4 process (`gjs`), so Shell libraries must not be imported here. Widget availability is taken from libadwaita NEWS; class shapes from gnome-shell `js/extensions/prefs.js` and `js/dbusServices/extensions/extensionPrefsDialog.js` (main).

## Contents
1. Process model and entry point
2. Widget cheat sheet with Adw versions
3. Binding settings
4. Enum, choice and string rows
5. Shortcut capture row (for Spotlight/clipboard keys)
6. Styling and assets in prefs
7. Cleanup and EGO rules
8. Sources

## 1. Process model and entry point
- `prefs.js` is imported by `org.gnome.Shell.Extensions` (the extensions app
  or prefs service). `fillPreferencesWindow(window)` receives an
  `Adw.PreferencesWindow` and is awaited (47+).
- Imports: `gi://Adw`, `gi://Gtk` (4.0), `gi://Gdk`, `gi://Gio`, `gi://GLib`, and
  `ExtensionPreferences, gettext as _` from
  `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`.
  **Never** import `Clutter`, `Meta`, `St`, `Shell` or `resource:///org/gnome/shell/ui/*`
  (EGO-I-003). Talking to the running Shell has to go through D-Bus or
  GSettings. Guava asks `org.gnome.Shell.Extensions` via `Gio.DBus.session`
  (`prefs.js` top).
- Guava organises prefs as pages (Panel, Dock, Buttons, Options), and the schema
  keys follow the same order.

## 2. Widget cheat sheet
| Widget | Since Adw | Notes |
|---|---|---|
| `Adw.PreferencesPage({title, icon_name})` | 1.0 | `window.add(page)` |
| `Adw.PreferencesGroup({title, description})` | 1.0 | `page.add(group)`, `group.add(row)`, `header_suffix` |
| `Adw.ActionRow({title, subtitle, activatable})` | 1.0 | `add_prefix`, `add_suffix`, signal `activated` |
| `Adw.SwitchRow({title, subtitle})` | 1.4 | property `active` |
| `Adw.SpinRow({adjustment, digits})` / `Adw.SpinRow.new_with_range(min, max, step)` | 1.4 | property `value` |
| `Adw.ExpanderRow({title, show_enable_switch})` | 1.0 | `add_row()`, `enable-expansion` (bind a boolean key to it) |
| `Adw.ComboRow({model: Gtk.StringList.new(labels)})` | 1.0 | `selected` (uint index) |
| `Adw.EntryRow({title})` / `Adw.PasswordEntryRow` | 1.2 | `text`, `apply` signal with `show_apply_button` |
| `Adw.ButtonRow({title, start_icon_name})` | 1.6 | `activated` |
| `Adw.AlertDialog`, `Adw.Dialog` | 1.5 | `dialog.present(window)` (Guava uses both) |
| `Adw.ToggleGroup` / `Adw.Toggle` | 1.7 | segmented control |
| `Adw.ShortcutsDialog`, `Adw.ShortcutLabel` | 1.8 | GNOME 49+ only; Guava's floor is 48, so gate it or avoid it |

Adw ↔ GNOME: 1.7 = 48, 1.8 = 49, 1.9 = 50, 1.10 = 51 (confirmed for Fedora
42–45 via Bodhi/mdapi: libadwaita 1.7.x, 1.8.x, 1.9.x, 1.10.0). On 48, avoid anything newer than 1.7, or
feature-test it (`if (Adw.ShortcutLabel)`).

## 3. Binding settings
```js
const settings = this.getSettings();
settings.bind('clipboard-history', switchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
settings.bind('clipboard-size', spinRow, 'value', Gio.SettingsBindFlags.DEFAULT);
settings.bind('clipboard-history', spinRow, 'sensitive', Gio.SettingsBindFlags.GET);
settings.bind('panel-transparency', expander, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
```
- `Gio.SettingsBindFlags`: `DEFAULT`, `GET`, `SET`, `NO_SENSITIVITY`,
  `GET_NO_CHANGES`, `INVERT_BOOLEAN`.
- Number keys: bind `i` or `d` keys to `SpinRow.value` (a double). Ranges come
  from the schema `<range>`, so mirror them in the adjustment.
- Guava helpers already exist: `_addSwitchRows(settings, group, items)` and
  `_createEnumComboRow(settings, title, subtitle, key, values, labels)`. Reuse
  them.

## 4. Enum, choice and string rows
```js
const values = ['glass', 'tinted', 'opaque'];
const row = new Adw.ComboRow({title: _('Material'),
    model: Gtk.StringList.new([_('Glass'), _('Tinted'), _('Opaque')])});
row.selected = Math.max(0, values.indexOf(settings.get_string('material')));
row.connect('notify::selected', () => settings.set_string('material', values[row.selected]));
settings.connect('changed::material', () => {               // keep in sync if changed elsewhere
    const i = values.indexOf(settings.get_string('material'));
    if (i >= 0 && row.selected !== i) row.selected = i;
});
```
For a schema `<enum>` you can use `settings.get_enum()` and `set_enum()`.

## 5. Shortcut capture row (for `as` keybinding keys)
```js
const row = new Adw.ActionRow({title: _('Spotlight shortcut'), activatable: true});
const label = new Gtk.ShortcutLabel({accelerator: settings.get_strv('spotlight-shortcut')[0] ?? '',
    disabled_text: _('Disabled'), valign: Gtk.Align.CENTER});
row.add_suffix(label);
row.connect('activated', () => {
    const ctl = new Gtk.EventControllerKey();
    const dlg = new Adw.AlertDialog({heading: _('Press a shortcut'), body: _('Backspace clears, Esc cancels')});
    dlg.add_response('cancel', _('Cancel'));
    ctl.connect('key-pressed', (_c, keyval, keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (keyval === Gdk.KEY_Escape) { dlg.close(); return Gdk.EVENT_STOP; }
        if (keyval === Gdk.KEY_BackSpace) { settings.set_strv('spotlight-shortcut', []); dlg.close(); return Gdk.EVENT_STOP; }
        if (!Gtk.accelerator_valid(keyval, mods)) return Gdk.EVENT_STOP;
        const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
        settings.set_strv('spotlight-shortcut', [accel]); label.accelerator = accel; dlg.close();
        return Gdk.EVENT_STOP;
    });
    dlg.add_controller(ctl); dlg.present(row.get_root());
});
```
`Gtk.ShortcutLabel` is GTK 4, not Adw, and is not deprecated (GTK main
gtkshortcutlabel.h). GTK 4.18 deprecated only `GtkShortcutsWindow` (gtk NEWS
4.17.3); `Adw.ShortcutLabel` and `Adw.ShortcutsDialog` arrived in Adw 1.8
(libadwaita NEWS 1.8.alpha). Feature-test `Adw.ShortcutLabel` before using it. Clipboard shortcuts must default to
empty (`[]`) because of the EGO guideline.

## 6. Styling and assets in prefs
- Load prefs CSS with `Gtk.CssProvider` +
  `Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)`
  (Guava `css/prefs.css`). Remove the provider on `close-request`
  (`Gtk.StyleContext.remove_provider_for_display`).
- Icons: `Gio.FileIcon.new(this.dir.get_child('icons/foo.svg'))`, or add
  `this.dir.get_child('icons').get_path()` to
  `Gtk.IconTheme.get_for_display(...).add_search_path()`.

## 7. Cleanup and EGO rules
- Don't store window-scoped objects (rows, settings, providers) on `this`
  without clearing them in `window.connect('close-request', ...)` (EGO-L-006).
  The `ExtensionPreferences` instance can outlive the window. Prefer local
  variables captured by closures.
- Disconnect `settings.connect('changed::…')` handlers and D-Bus subscriptions
  on `close-request` (Guava does this for the dock state at `prefs.js:820`).
- Use `fillPreferencesWindow`, not only `getPreferencesWidget` (EGO-C45-001).

## 8. Sources
- https://gjs.guide/extensions/development/preferences.html
- https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/ (API reference)
- https://gitlab.gnome.org/GNOME/libadwaita/-/blob/main/NEWS (widget introduction versions)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/extensions/prefs.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/dbusServices/extensions/extensionPrefsDialog.js
- https://docs.gtk.org/gtk4/func.accelerator_name_with_keycode.html
