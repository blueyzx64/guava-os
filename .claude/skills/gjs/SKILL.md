---
name: gjs
description: Use when writing or reviewing JavaScript that runs on GJS (GNOME's SpiderMonkey-based JS runtime with GObject Introspection), whether GNOME Shell extension code or prefs in this repo (Guava OS: extension.js, features/*/index.js, core/motion.js, lib/glass.js). Covers ES modules and gi:// imports, GObject subclassing, signals and properties, async Gio and main-loop sources, GNOME lint style, and GJS-specific gotchas.
---

# GJS: GNOME's JavaScript runtime

GNOME Shell and its extensions are written in **JavaScript running on GJS**,
not Vala or Python. GJS embeds Mozilla SpiderMonkey and exposes every
GObject-Introspection library (GLib, Gio, GObject, Clutter, Meta, St, Shell,
Gtk, Adw…) as JS modules. Guava's shell code (`extension.js`, `features/*/index.js`) runs
inside the gnome-shell process. `prefs.js` runs in a separate GJS process with
GTK4 and libadwaita. For Shell APIs, load the `gnome-shell-extension` skill.

Read this index first, then open only the reference you need.

## Versions (gjs ↔ GNOME ↔ SpiderMonkey)
| GNOME | gjs | SpiderMonkey | Notable |
|---|---|---|---|
| 45 | 1.78 | 115 | ESM-only Shell extensions |
| 46 | 1.80 | 115 | `GLibUnix`/`GioUnix` split; WeakRef/FinalizationRegistry fixed |
| 47 | 1.82 | 128 | `new GObjectClass(x)` takes only a property bag; `get_data`/`ref`/`unref` throw |
| 48 | 1.84 | 128 | async REPL, source maps |
| 49 | 1.86 | 140 | iterator helpers, Float16Array; girepository-2.0 |
| 50 | 1.88 | 140 | `GLib.idle_add_once`/`timeout_add_once` introspectable; Gtk.Builder sugar |
| 51 | 1.90 | 140 | `new Gio.DBus.makeProxyWrapper(...)`: calling it without `new` warns; Interface methods not static |

Source: gjs NEWS (https://gitlab.gnome.org/GNOME/gjs/-/blob/master/NEWS). Guava
targets 48 to 51, so assume SpiderMonkey 128+: private `#fields`, static
blocks, `??=`, `Array.prototype.at`, `Object.hasOwn`, top-level `await` in ESM
(gjs NEWS: "Enable top-level await").

## Rules of thumb
1. **ES modules only.** Use `import X from 'gi://X'`. A relative import
   needs the `.js` extension. Shell modules come from
   `resource:///org/gnome/shell/...`. Never use `imports.*` in new code.
2. **GObject subclasses** go through `GObject.registerClass`. Use
   `constructor()` with `super(params)`; `_init` is legacy but used across
   Shell classes. Never give a ParamSpec name an underscore.
3. **Every connect has a disconnect.** Every `GLib.timeout_add` or `idle_add`
   has a `GLib.Source.remove`. Every `destroy()` is followed by setting the
   reference to `null`.
4. **No blocking I/O in the Shell.** Use `Gio._promisify` with `async`/`await`
   and pass a `Gio.Cancellable` to cancel.
5. **Bytes ≠ strings.** Use `new TextDecoder().decode(bytes)`. `GLib.Bytes`
   has `.toArray()`.
6. **`this` is not captured.** Use arrow functions or `.bind(this)` for
   callbacks.
7. **Don't touch disposed objects.** After `actor.destroy()` the JS wrapper
   still exists, but calling methods logs "already disposed".

## Decision table
| I need to... | Read |
|---|---|
| Write imports, use `import.meta.url`, `resource://`, versioned `gi://`, built-in modules | `references/language-and-modules.md` |
| Subclass a GObject or St widget, add properties or signals, implement an interface, set GTypeName | `references/gobject-in-gjs.md` |
| Read files, run subprocesses, call D-Bus, use timers or idle callbacks, async/await | `references/async-and-gio.md` |
| Match GNOME's ESLint config and naming conventions | `references/style-and-lint.md` |
| Debug leaks, `this` bugs, int64/BigInt, bytes vs strings, destroyed actors | `references/gotchas.md` |

## Ten-line refresher
```js
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');   // finish name inferred (_async → _finish)

export const Counter = GObject.registerClass({
    Properties: {'count': GObject.ParamSpec.int('count', null, null,
        GObject.ParamFlags.READWRITE, 0, GLib.MAXINT32, 0)},
    Signals: {'overflow': {param_types: [GObject.TYPE_INT]}},
}, class Counter extends GObject.Object {});
```

## Quick commands
```sh
gjs --version
gjs -m script.js                  # run an ES module
gjs -c "print(imports.gi.GLib.get_user_cache_dir())"   # quick legacy one-liner
journalctl -f -o cat /usr/bin/gjs # prefs process logs
```
API docs: https://gjs-docs.gnome.org (pick the library version matching the
target GNOME). GJS guides: https://gjs.guide/guides/.
