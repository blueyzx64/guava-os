# Async, main loop and Gio (files, subprocesses, D-Bus, timers)

Summary: how to do non-blocking I/O in GJS. `Gio._promisify` plus `async`/`await` with `Gio.Cancellable`, main-loop sources (`GLib.timeout_add`/`idle_add`) and how to remove them, and Shell "laters".
It also has file, subprocess and D-Bus proxy recipes that pass EGO review (no sync I/O in the Shell). Includes the 51 `makeProxyWrapper` change.
Verified against gjs `doc/Overrides.md`, `modules/core/overrides/Gio.js` (`_promisify`), `doc/Timers.md` and NEWS (master), and gnome-shell `extensionDownloader.js` and `magnifier.js` (main).

## Contents
1. Promisify and async/await
2. Cancellation and the disable() problem
3. Main-loop sources (timeouts, idles) and laters
4. Files
5. Subprocesses
6. D-Bus
7. Sources

## 1. Promisify and async/await
```js
// Once per module (static, allowed at import): patches the prototype
Gio._promisify(Gio.File.prototype, 'load_contents_async');           // finish = load_contents_finish
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

const [contents] = await file.load_contents_async(cancellable);      // returns the finish() results
```
- `_promisify(proto, asyncName, finishName?)` derives the finish name by
  replacing `_async` or `_begin` with `_finish`. It is idempotent (it keeps
  `_original_<name>`). Calling with the callback argument still works.
- Finish functions that return `[ok, …]` have the success boolean stripped.
- Guava already promisifies several methods in `(Kiwi: apps/mediaPlayback.js; Guava equivalent not verified)`,
  `features/launchpad/index.js` and `features/appButtons/gtkTheme.js`. Promisifying the same
  method twice is harmless.
- It is still marked "tech preview" in the docs, but GNOME Shell itself uses
  it widely.

## 2. Cancellation and the disable() problem
`disable()` must be synchronous (GNOME 51 throws on async `disable`), but your
async work may still be running.
```js
enable() {
    this._cancellable = new Gio.Cancellable();
    this._load().catch(e => {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) logError(e, 'Guava');
    });
}
async _load() {
    const [bytes] = await this._file.load_contents_async(this._cancellable);
    if (this._cancellable?.is_cancelled()) return;   // disabled meanwhile
    this._apply(new TextDecoder().decode(bytes));
}
disable() {
    this._cancellable.cancel(); this._cancellable = null;
}
```
Always check after each `await` that you are still enabled before touching
actors.

## 3. Main-loop sources
```js
this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    this._timeoutId = 0;
    this._hide();
    return GLib.SOURCE_REMOVE;          // or GLib.SOURCE_CONTINUE to repeat
});
// before re-arming, and in disable():
if (this._timeoutId) { GLib.Source.remove(this._timeoutId); this._timeoutId = 0; }
```
- Variants: `GLib.timeout_add_seconds(prio, s, cb)` (coalesced wakeups, good
  for slow polling) and `GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, cb)`.
  Since gjs 1.88 (GNOME 50) there are also `GLib.idle_add_once`,
  `timeout_add_once` and `timeout_add_seconds_once`. Guava supports 48, so
  feature-test them or use the classic form.
- `GLib.Source.set_name_by_id(id, '[guava] hide panel')` helps when debugging
  stuck sources (the Shell does this).
- `setTimeout` and `setInterval` work too (WHATWG). They return a
  `GLib.Source` object. Clear them with `clearTimeout`/`clearInterval`. The
  EGO rule "Remove main loop sources" applies equally.
- **Laters** (Shell, once before the next redraw, coalesced):
  ```js
  const laters = global.compositor.get_laters();
  this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => { this._laterId = 0; this._relayout(); return GLib.SOURCE_REMOVE; });
  // disable(): if (this._laterId) laters.remove(this._laterId);
  ```
  Use laters for geometry and stacking work after allocation, for example
  coalescing `position-invalidated` (magnifier.js).

## 4. Files
```js
const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'guava']));
try { await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null); }
catch (e) { if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw e; }

const file = dir.get_child('clipboard.json');
const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(data)));
await file.replace_contents_bytes_async(bytes, null, false,
    Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
```
- Error matching: `e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)`.
- Enumerating directories: `for await (const info of enumerator)`.
  `Gio.FileEnumerator` supports `Symbol.asyncIterator` (Overrides.md).
- Reading streams: `Gio.InputStream.createAsyncIterator(count, priority)`.
- Paths: `GLib.get_user_cache_dir()`, `get_user_data_dir()`,
  `get_user_config_dir()`, `GLib.build_filenamev([...])`.
- Never use `GLib.file_get_contents`, `Gio.File.load_contents` (sync) or
  `GLib.spawn_command_line_sync` in the Shell process (EGO-X-002, X-004).
  Sync calls are acceptable in `prefs.js` for tiny files, but async is still
  preferred.

## 5. Subprocesses
```js
const proc = Gio.Subprocess.new(['gsettings', 'get', 'org.gnome.desktop.wm.preferences', 'button-layout'],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
if (!proc.get_successful()) throw new Error(stderr);
```
- Prefer native APIs (Gio.Settings, D-Bus) over spawning tools.
  `extensionDownloader.js` uses `Gio.Subprocess` with `wait_check_async` for
  `glib-compile-schemas`.
- Use `Gio.SubprocessLauncher` to set env or cwd. Kill on disable with
  `proc.force_exit()`. Privileged helpers only via `pkexec` (EGO-X-001).

## 6. D-Bus
```js
const IFACE = `<node><interface name="org.freedesktop.portal.Settings">
  <method name="ReadOne"><arg type="s" direction="in"/><arg type="s" direction="in"/>
  <arg type="v" direction="out"/></method></interface></node>`;
const SettingsProxy = Gio.DBusProxy.makeProxyWrapper(IFACE);
const proxy = await SettingsProxy.newAsync(Gio.DBus.session,
    'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', cancellable);
const [value] = await proxy.ReadOneAsync('org.gnome.desktop.interface', 'accent-color');
const id = proxy.connectSignal('SettingChanged', (_p, _sender, [ns, key, v]) => {});
// disable(): proxy.disconnectSignal(id);
```
- `makeProxyWrapper` returns a class. From gjs 1.90 (GNOME 51), calling the
  result **without `new`** prints a deprecation warning. Use
  `new Proxy(bus, name, path, cb)` or the static `newAsync()` (gjs 1.75.2+, which
  resolves after `initAsync`). Each D-Bus method becomes `<Name>Sync`, `<Name>Remote` (callback) and
  `<Name>Async` (Promise) (Gio.js override, lines 190-192).
- Low level: `Gio.DBus.session.call(name, path, iface, method, params, replyType, flags, timeout, cancellable, cb)`
  (promisify `call`), and `signal_subscribe()`/`signal_unsubscribe(id)`. Guava's
  prefs use `Gio.DBus.session.signal_unsubscribe(dockStateId)` on
  `close-request`.
- Exporting: `Gio.DBusExportedObject.wrapJSObject(xml, obj)`, then
  `.export(Gio.DBus.session, path)` and `.unexport()` on disable.
- Variants: `new GLib.Variant('(ss)', [a, b])`, `v.deepUnpack()`,
  `v.recursiveUnpack()`.

## 7. Sources
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Overrides.md (Gio._promisify, FileEnumerator iterators, makeProxyWrapper, wrapJSObject)
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/modules/core/overrides/Gio.js (_promisify finish-name inference)
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Timers.md
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/NEWS (1.88 *_once; 1.89.90 makeProxyWrapper; newAsync)
- https://gjs.guide/guides/gio/file-operations.html , https://gjs.guide/guides/gio/subprocesses.html , https://gjs.guide/guides/gio/dbus.html
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/extensionDownloader.js
