# Extension anatomy: metadata, classes, schemas, gettext, packaging

Summary: the files an extension ships, how the Extension and ExtensionPreferences classes work (45+ ESM), how GSettings schemas are compiled, and how translations are set up.
It also covers packing and installing with `gnome-extensions`. Guava-specific values are given inline.
Verified against `js/extensions/{extension,sharedInternals,prefs}.js`, `js/ui/extensionDownloader.js` and `subprojects/extensions-tool` in gnome-shell main (51).

## Contents
1. File layout
2. metadata.json
3. Extension class (shell process)
4. ExtensionPreferences class (prefs process)
5. GSettings schemas and compilation
6. Translations (gettext)
7. Stylesheets
8. Packing, installing, uploading
9. Sources

## 1. File layout (Guava)
```
metadata.json   extension.js   prefs.js   stylesheet.css
schemas/org.gnome.shell.extensions.guava-os.gschema.xml
features/*/index.js  css/*.css  icons/  po/*.po   advanced/ (native libs, not packed by CI)
```
Only `metadata.json` and `extension.js` are required. Any other JS file must be
reachable through imports from `extension.js` or `prefs.js`. Otherwise shexli
reports EGO-P-007 (unreachable JS) or EGO-P-006 (unnecessary files).

## 2. metadata.json
| key | Notes |
|---|---|
| `uuid` | `name@namespace`. Must match the install directory name. Guava: `guava-os@blueyzx64`. |
| `name`, `description` | The description must declare clipboard access if the extension uses the clipboard. It may use `\n` paragraphs and `*` bullets. |
| `shell-version` | Major versions as strings, for example `["48","49","50","51"]`. Only stable releases plus at most one development release (EGO-M-004). |
| `url` | Repository URL. |
| `settings-schema` | Default schema for `getSettings()`. Must start with `org.gnome.shell.extensions.` (EGO-P-001). |
| `gettext-domain` | Default domain for `initTranslations()`. Falls back to the UUID (45+). |
| `version-name` | Free-form string, 46+ (NEWS 46.alpha). Guava: `"2.3.1"`. |
| `session-modes` | Only `user` and `unlock-dialog` are allowed. Omit it if the only value would be `user` (EGO-M-005, EGO-M-006). With `unlock-dialog`, `disable()` must carry a comment explaining why (EGO-M-008). |
| `donations` | Only the allowed keys, for example `github`, `kofi` (EGO-M-007). |
| `version` | Integer assigned by EGO on upload. "SHOULD NOT be set by extension developers"; EGO overrides it (gjs.guide anatomy). |

## 3. Extension class (shell process)
```js
import {Extension, gettext as _, InjectionManager} from
    'resource:///org/gnome/shell/extensions/extension.js';

export default class GuavaExtension extends Extension {
    // constructor(metadata) is optional. If you define it, call super(metadata)
    // and do NOTHING else that touches the Shell.
    enable() {
        this._settings = this.getSettings();          // uses metadata['settings-schema']
        this._injections = new InjectionManager();
    }
    disable() {
        this._injections.clear();  this._injections = null;
        this._settings = null;
    }
}
```
`ExtensionBase` members (sharedInternals.js):
- `metadata`, `uuid`, `dir` (Gio.File), `path`
- `getSettings(schema?)` looks in `<dir>/schemas` first, then the system schema
  source. It throws if the schema is missing.
- `getLogger()` (48+) returns a console that prefixes `[<name>]`, with `log`,
  `warn`, `error`, `info`, `debug`, `assert`, `trace` and `group`.
- `initTranslations(domain?)`, `gettext`, `ngettext`, `pgettext`
- `static lookupByURL(url)` and `lookupByUUID(uuid)`. Don't use them to find
  your *own* extension: use `this` (EGO-X-006).
- `Extension.openPreferences()` opens the prefs window.

The module-level `gettext`, `ngettext` and `pgettext` exports from
`extension.js` resolve the calling extension from the import URL.

Lifecycle (`js/ui/extensionSystem.js`, main):
- The module is imported once per session. The constructor runs once.
- `enable()` runs when the user enables the extension, on login, and after
  unlock. On 51 it is awaited.
- `disable()` runs on user disable, on lock (unless `unlock-dialog` is in
  `session-modes`), and on uninstall or update. It must be synchronous: since
  51 it throws if it returns a Promise.
- When extension A is disabled, extensions enabled after it are disabled and
  re-enabled ("rebase"), so they must survive repeated enable/disable cycles.

## 4. ExtensionPreferences class (prefs process)
```js
import Adw from 'gi://Adw';
import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GuavaPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {   // awaited since 47
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: _('General')});
        window.add(page);
        window.connect('close-request', () => { /* drop refs */ });
    }
}
```
- `window` is an `Adw.PreferencesWindow` (`extensionPrefsDialog.js`).
- The default `fillPreferencesWindow()` wraps `getPreferencesWidget()`. From 45
  on, prefer `fillPreferencesWindow` (EGO-C45-001).
- Don't keep window-scoped objects on `this` without cleaning them up in
  `close-request` (EGO-L-006). See `prefs-adwaita.md`.

## 5. GSettings schemas and compilation
- File: `schemas/<schema-id>.gschema.xml`. The id and path must be
  `org.gnome.shell.extensions.*` and `/org/gnome/shell/extensions/*/`, and the
  filename must match the id (EGO-P-001, P-002, P-004).
- **Do not ship `gschemas.compiled` for 45+.** Since GNOME 44, gnome-shell
  compiles schemas itself when it installs a zip: `extensionDownloader.js`
  runs `glib-compile-schemas --strict <dir>/schemas` (that code is in tag 44.0
  but not 43.0). `gnome-extensions install` does the same
  (`command-install.c`). `gnome-extensions pack` copies only `*.gschema.xml`
  (`command-pack.c`). Shipping the compiled file triggers EGO-P-006. Guava's
  `.gitignore` already ignores `*.compiled`.
- For a dev checkout symlinked into `~/.local/share/gnome-shell/extensions/`,
  run `glib-compile-schemas schemas/` yourself.
- Adding a key: add it to the XML in prefs order (Guava's file is grouped by
  prefs page), give it a `<default>` and a `<summary>`, then reinstall or
  recompile. A key that is used but missing makes `get_*()` abort the shell
  with a GLib-GIO error.
- Keybinding keys use type `as`, for example `<default>['<Super>space']</default>`.
  See `input-keybindings-and-modals.md`.

## 6. Translations
- `po/<lang>.po` files and the `gettext-domain` metadata key. `gnome-extensions pack --podir=po`
  compiles them into `locale/<lang>/LC_MESSAGES/<domain>.mo` (msgfmt in command-pack.c).
- `initTranslations()` binds `<dir>/locale` if it exists, otherwise the system
  `LOCALEDIR`. With 45+ ESM, translation functions come from the module imports.
  Guava passes `this.gettext.bind(this)` into feature modules.
- Extract strings with xgettext. See `translating/` in the repo for Guava's flow.

## 7. Stylesheets
The shell loads the first one that exists from
`<sessionMode>-<dark|light>.css`, `stylesheet-<dark|light>.css`,
`<sessionMode>.css`, `stylesheet.css`, and reloads it when the color scheme
changes (extensionSystem.js `_loadExtensionStylesheet`). Never load
`stylesheet.css` manually (EGO-X-005). See `styling-st-css.md`.

## 8. Packing, installing, uploading
```sh
gnome-extensions pack --force --extra-source=icons --extra-source=apps \
    --extra-source=css --podir=po .       # -> guava-os@blueyzx64.shell-extension.zip
gnome-extensions install --force guava-os@blueyzx64.shell-extension.zip
gnome-extensions enable guava-os@blueyzx64        # on Wayland a new extension needs re-login first
gnome-extensions upload guava-os@blueyzx64.shell-extension.zip   # 49+ (NEWS 49.alpha.1)
```
`pack` options (command-pack.c): `--extra-source`, `--schema`, `--podir`,
`--gettext-domain`, `--force`, `--out-dir`. `pack` automatically adds
`extension.js`, `metadata.json`, `stylesheet-dark.css`, `stylesheet-light.css`,
`stylesheet.css` and `prefs.js`, plus `schemas/*.gschema.xml` and the compiled
`po/` (command-pack.c lines 376-381). Every other file or folder, such as
`apps/`, `css/` or `icons/`, needs `--extra-source`. Session-mode stylesheets
such as `unlock-dialog.css` also need `--extra-source`.

User install path: `~/.local/share/gnome-shell/extensions/guava-os@blueyzx64/`.
On Wayland, newly installed code loads only after you log out and back in, or
inside a nested or devkit shell.

## 9. Sources
- https://gjs.guide/extensions/overview/anatomy.html
- https://gjs.guide/extensions/topics/extension.html
- https://gjs.guide/extensions/upgrading/gnome-shell-45.html
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/extensions/sharedInternals.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/extensionDownloader.js (schema compile; also present in 44.0, absent in 43.0)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/subprojects/extensions-tool/src (command-pack.c, command-install.c)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/extensionSystem.js
- shexli spec: https://pypi.org/project/shexli/
