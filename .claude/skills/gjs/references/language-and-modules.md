# GJS language and modules (ESM, gi://, resource://, versions)

Summary: how GJS resolves ES module specifiers (relative `.js`, `gi://`, `resource:///`, `file:///`, built-ins), and how to use `import.meta.url`, dynamic `import()` and top-level await.
It also lists which JavaScript features are available on each GNOME version, and the paths used for GNOME Shell code vs prefs code.
Verified against gjs `doc/ESModules.md`, `doc/Modules.md` and NEWS (master, 1.90), and gnome-shell `js/` imports (main).

## Contents
1. Specifier types
2. `gi://` imports and versions
3. `resource://` (Shell modules)
4. `import.meta`, dynamic import, top-level await
5. Built-in modules and globals
6. Legacy `imports` (read-only knowledge)
7. Language features by GNOME version
8. Sources

## 1. Specifier types (ESModules.md)
- **Relative**: `'./features/clipboard/index.js'`. The file extension is **mandatory**,
  and there is no `index.js`/`__init__.js` resolution.
- **Bare**: `'gettext'`, `'system'`, `'cairo'`, `'console'`. These are only
  built-ins. There is no node_modules resolution.
- **Absolute URL**: `file:///…`, `resource:///…`, `gi://…`. `https:` is not
  supported.
- Modules are cached per URL. The same file with a different `?query` loads
  twice. Corollary: the Shell imports an extension once per session, so
  disable and re-enable do *not* re-run module top-level code.

## 2. `gi://` imports and versions
```js
import GLib from 'gi://GLib';                 // GLib, GObject, Gio need no version
import Gtk from 'gi://Gtk?version=4.0';       // prefs.js
import Adw from 'gi://Adw?version=1';         // optional; the extension prefs host already loads 1
import Clutter from 'gi://Clutter';           // inside Shell: the version is fixed by the running shell
```
- If several versions are installed and none is specified, resolution throws.
  The first version you specify is cached.
- In Shell code, don't specify versions for Clutter, Meta, St, Shell, Cogl
  or Mtk. The shell already loaded the right ones (each GNOME release bumps
  the mutter API version: 13 on 45, 16 on 48, 17 on 49, 18 on 50, then 51
  on 51, matching the major version (mutter meson.build `libmutter_api_version`)).
- Platform-specific APIs (46+): `import GioUnix from 'gi://GioUnix'`, for
  example `GioUnix.DesktopAppInfo` (gnome-shell remoteSearch.js uses it) and
  `GioUnix.InputStream`. The old `Gio.DesktopAppInfo` and `Gio.UnixInputStream`
  still work but log deprecation warnings (gjs 1.80 NEWS).

## 3. `resource://` (Shell modules)
- Shell process: `resource:///org/gnome/shell/ui/main.js`,
  `.../ui/panelMenu.js`, `.../ui/popupMenu.js`, `.../ui/quickSettings.js`,
  `.../ui/messageTray.js`, `.../ui/layout.js`, `.../misc/config.js`,
  `.../misc/util.js`, `.../extensions/extension.js`.
- Prefs process: `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`
  (capital `S` in `Shell`, and `/js/`). Shell `ui/*` modules are not
  available there.
- Shell modules export named bindings (`export const`, `export class`,
  `export function`). Use `import * as Main from …` for modules with many
  exports.
- `Config.PACKAGE_VERSION` (from `misc/config.js`) is the running shell
  version string, for example `"51.1"`.

## 4. `import.meta`, dynamic import, top-level await
```js
const here = Gio.File.new_for_uri(import.meta.url).get_parent();  // the module's directory
const css = here.get_child('css').get_child('glass.css');

const mod = await import('./optionalFeature.js');   // dynamic import (Promise)
```
- In extensions, prefer `this.dir`/`this.path` from the Extension object
  over `import.meta.url` for paths.
- Top-level `await` works in ES modules. Blur my Shell uses
  `const Clutter = await import_in_shell_only('gi://Clutter')` so that the
  same file can load in prefs. Don't do work with side effects at top level
  in an extension: static data only (EGO rule).
- Dynamic `import()` of Shell-only modules from code that is shared with
  prefs is the standard way to make one file load in both processes.

## 5. Built-in modules and globals
Globals (no import needed):
- `console` (WHATWG: `log`, `debug`, `info`, `warn`, `error`, `assert`,
  `trace`, `time`, …)
- `TextEncoder`, `TextDecoder`
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. These return
  a `GLib.Source`, not a number.
- `log()`, `logError(e, prefix)`, `print()`, `printerr()`
- `globalThis`, and in the Shell also `global` (Shell.Global) and the
  translation helpers `_`, `C_`, `N_`, `ngettext` (Shell-internal, see the
  shell ESLint globals)

Built-ins (`import x from 'name'`):
- `system`: `exit`, `gc`, `dumpHeap`, `dumpMemoryInfo`, `programInvocationName`
- `gettext`: `gettext`, `ngettext`, `pgettext`, `bindtextdomain`
- `cairo`: default export only
- `console`: `setConsoleLogDomain`, `getConsoleLogDomain`, `DEFAULT_LOG_DOMAIN`
  (`'Gjs-Console'`) (gjs modules/esm/console.js)

Deprecated (don't use; EGO-I-001): `ByteArray` (use `TextEncoder` and
`TextDecoder`), `Lang` (use classes and `GObject.registerClass`), `Mainloop`
(use GLib), `jsUnit` (use Jasmine), `Tweener` (use `ease()`).

## 6. Legacy `imports` (read-only knowledge)
Pre-45 extension code used `const {GLib, St} = imports.gi;`,
`imports.misc.extensionUtils`, `var` exports and `init()`. If you port such
snippets: `imports.gi.X` → `import X from 'gi://X'`,
`imports.ui.main` → `import * as Main from 'resource:///org/gnome/shell/ui/main.js'`,
and `ExtensionUtils.getSettings()` → `this.getSettings()`. `imports` still
exists as a global in ESM, but mixing styles is discouraged.

## 7. Language features by GNOME version
| From | SpiderMonkey | Safe to use |
|---|---|---|
| 45 (1.78) | 115 | class fields, `#private`, static blocks, `??=`/`||=`, `Array.prototype.at`, `Object.hasOwn`, `findLast`, top-level await. Not `structuredClone`: GJS does not provide it (absent from gjs source as of 1.90) |
| 47 (1.82) | 128 | `Object.groupBy`/`Map.groupBy`, `Promise.withResolvers`, `String.prototype.isWellFormed`, `ArrayBuffer.prototype.transfer`, `Array.fromAsync` (1.78+) |
| 49 (1.86) | 140 | Iterator helpers (`iter.map/filter/take/drop/toArray…`), `Float16Array`, `Math.f16round`, duplicate named capture groups |
Guava supports 48+, so anything in the first two rows is fine. Feature-test
before using 140-only features (`typeof Iterator !== 'undefined' && Iterator.prototype.map`).

## 8. Sources
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/ESModules.md
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Modules.md
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Timers.md , doc/Encoding.md , doc/Console.md
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/NEWS (1.78 to 1.90)
- https://gjs.guide/extensions/overview/imports-and-modules.html
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/modules/esm/console.js ; https://gitlab.gnome.org/GNOME/mutter/-/blob/51.0/meson.build (libmutter_api_version)
