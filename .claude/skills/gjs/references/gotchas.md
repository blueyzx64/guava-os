# GJS gotchas (memory, disposal, this, bytes, int64, destroyed actors)

Summary: the runtime traps that cause leaks, crashes, "already disposed" warnings and subtle bugs in GJS and GNOME Shell code, with fixes.
It covers GC vs GObject lifetimes, `destroy()` vs dispose, `this` binding, `GLib.Bytes` and strings, 64-bit integers and BigInt, out-args and arrays, and API changes in recent gjs releases.
Sources: gjs NEWS and docs (master), gnome-shell sources (main), and the shexli rule spec.

## Contents
1. Lifetimes: GC, toggle refs and why leaks happen
2. Destroying actors and disposed wrappers
3. `this` binding and closures
4. Strings, bytes, TextDecoder
5. Numbers: int64, BigInt, unsigned, enums
6. Out-args, arrays and multiple returns
7. Recent breaking changes to remember
8. Misc traps
9. Sources

## 1. Lifetimes
- A GObject wrapper is kept alive while JS references it **or** C holds a
  reference (toggle refs). Signal handlers are JS closures owned by the
  emitter, so `global.display.connect('x', () => this.foo())` keeps `this`
  alive as long as `global.display` lives (forever) until you disconnect.
  That is the #1 extension leak.
- JS properties attached to GObjects (`actor._guavaData = …`) keep JS
  objects alive with the wrapper. Delete them on disable.
- `WeakRef` and `FinalizationRegistry` work correctly from gjs 1.80
  (GNOME 46). Before that they never collected (NEWS 1.79.90).
- `System.gc()` exists for debugging only. Don't call it in shipped code.
- The "Big Hammer" (forced GC after some operations) still exists. gjs 1.89
  work is preparing its removal (NEWS 1.89.1), so don't rely on GC timing.

## 2. Destroying actors and disposed wrappers
- `actor.destroy()` disposes the C object, emits `destroy`, removes it from
  its parent and destroys its children. The **JS wrapper survives**, and any
  method or property access then logs a critical/warning that the object has
  already been disposed: a critical `Object Gjs_Foo (0x…), has been already
  disposed — impossible to access it. This might be caused by the object
  having been destroyed from C code…` ("finalized"/"set any property on" vary;
  gjs gi/object.cpp `check_gobject_disposed_or_finalized`).
  Always null the reference after destroy.
- Destroy order: disconnect signals on *other* objects first, then destroy
  your actors (children go with the parent), then set references to null.
- `Clutter.Clone`: if its source is destroyed, `clone.source` becomes null.
  Listen to the source's `destroy` signal and drop the clone.
- `run_dispose()`: don't call it in extensions (shexli EGO-X-003). Use
  `destroy()` for actors, and simply drop the reference for plain GObjects
  such as `Gio.Settings`. The Shell's darkMode toggle calls
  `this._settings.run_dispose()` internally, but that is Shell code, not a
  model for extensions.
- Removing a child without destroying it (`remove_child`) leaves it orphaned
  but alive. Destroy it or re-add it.

## 3. `this` binding and closures
```js
// WRONG: `this` is undefined or the emitter inside a plain function
obj.connect('changed', function () { this._sync(); });
// RIGHT
obj.connect('changed', () => this._sync());
obj.connect('changed', this._sync.bind(this));   // note: a new function each bind; store it if you need to disconnect by func
```
- Signal callbacks receive the emitter first: `(emitter, ...signalArgs)`.
- A loop with `var` captures the last value. Use `let` or `const` (gjs style
  guide example).
- `InjectionManager.overrideMethod(proto, name, orig => function (...args) { … orig.call(this, ...args) })`
  must return a **function**, not an arrow, so that `this` is the instance.

## 4. Strings, bytes, TextDecoder
- C `gchar*` maps to a JS string automatically. Byte buffers come back as
  `Uint8Array` (for example `load_contents` → `[Uint8Array, etag]`) or as a
  `GLib.Bytes`.
- Decode with `new TextDecoder().decode(u8)`. For `GLib.Bytes`, use
  `bytes.toArray()` first (GJS override) or `bytes.get_data()`. Encode with
  `new TextEncoder().encode(str)` and wrap in `new GLib.Bytes(u8)` where
  GBytes is expected.
- `ByteArray` (`imports.byteArray`) is deprecated. Reviewers reject it
  (EGO-I-001).
- Invalid UTF-8: `new TextDecoder('utf-8', {fatal: true})` throws instead of
  inserting U+FFFD.
- Markup: escape user text with `GLib.markup_escape_text(text, -1)` before
  putting it in `use_markup` labels or notification bodies with markup. This
  matters for clipboard contents.

## 5. Numbers: int64, BigInt, unsigned, enums
- JS Numbers are doubles. 64-bit integers above 2^53 lose precision when
  returned from C. You can **pass** BigInt to 64-bit parameters
  (`GLib.Variant.new_int64(2n ** 62n)`), and `GLib.MAXINT64_BIGINT` and
  friends exist (gjs NEWS 1.71.1, GNOME 42 cycle). 64-bit *return* values still
  come back as Number, and GJS logs "Value … cannot be safely stored in a JS
  Number and may be rounded" past 2^53 (gi/arg-inl.h). Treat file sizes and
  timestamps as Numbers, which is fine below 9 PB.
- `GLib.get_monotonic_time()` returns microseconds as a Number. Clutter event
  times (`event.get_time()`) are 32-bit ms. `global.get_current_time()` for
  the X/Wayland server time.
- Enums and flags are plain numbers: `Meta.MaximizeFlags.BOTH`. Combine with
  `|` and test with `&`. Comparing an enum to a string is always false.
- Out-of-range integer arguments throw a plain `Error` (not a TypeError):
  `value 300 is out of range for … (type …)` (gjs gi/arg.cpp,
  `gjs_throw` = JSEXN_ERR). Clamp before passing (for example `opacity` 0-255).

## 6. Out-args, arrays and multiple returns
- Functions with out-params return an array: `const [ok, value] = settings.get_value(...)`,
  `const [x, y, mods] = global.get_pointer()`, `const [minW, natW] = actor.get_preferred_width(-1)`.
  If the C function also returns a value, it comes first.
- `GList` and `GSList` become JS arrays. `GHashTable` becomes an object (keys
  are stringified).
- `caller-allocates` structs (for example `Clutter.ActorBox`, `Graphene.Point`)
  may need constructing first. See gjs Mapping.md "Return Values and
  caller-allocates".
- `GObject.Object.prototype.set({a, b})` is an override that replaces the
  non-introspectable `g_object_set`.

## 7. Recent breaking changes to remember
| gjs (GNOME) | Change |
|---|---|
| 1.80 (46) | `Gio.Unix*` / `GLib.unix_*` → `GioUnix` / `GLibUnix` (old names deprecated) |
| 1.82 (47) | `new GObjectType(x)` takes only one property bag; `get_data`, `set_data`, `ref`, `unref`, `ref_sink`, `force_floating` throw |
| 1.85.2 (49) | SpiderMonkey 140 |
| 1.88 (50) | `GLib.idle_add_once`, `timeout_add_once`, `timeout_add_seconds_once` are usable |
| 1.89.1 (51) | `GObject.Interface` methods are no longer static on the constructor |
| 1.89.90 (51) | `Gio.DBus.makeProxyWrapper()` must be called with `new` (warns otherwise) |
GNOME Shell-side breaking changes (Clutter, St, Meta) are in the
gnome-shell-extension skill's `references/version-matrix.md`.

## 8. Misc traps
- `Object.prototype.toString` is overridden in the Shell (environment.js) to
  print GObject info. Don't rely on its exact output.
- `JSON.stringify` of a GObject gives `{}`. Serialize explicit fields instead.
- Exceptions inside signal handlers are logged and swallowed. They don't
  propagate to the emitter, so check the journal.
- An unhandled Promise rejection is logged as "Unhandled promise rejection".
  Always `.catch()` fire-and-forget async calls (Shell code uses
  `.catch(logError)`).
- `setTimeout` without `clearTimeout` in `disable()` counts as a leaked main
  loop source.
- `Gio.Settings` for a missing schema aborts the process. In extensions use
  `this.getSettings()`, which throws a JS error instead.

## 9. Sources
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/NEWS
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Mapping.md , doc/Encoding.md , doc/Overrides.md , doc/Style_Guide.md
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/gi/object.cpp (disposed critical) , gi/arg.cpp , gi/arg-inl.h (range errors, rounding warning)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/environment.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/extensions/extension.js (InjectionManager)
- shexli spec (EGO-X-003 run_dispose, EGO-I-001 deprecated modules): https://pypi.org/project/shexli/
