# Testing strategy for Guava

Summary: most bugs in a Shell extension are lifecycle and integration bugs, but most
*logic* can be pulled into pure `model.js` files and tested in milliseconds. Layer the
tests: pure unit tests (gjs or node), D-Bus contract tests for helpers, and a scripted
manual matrix in a nested/devkit Shell.

## Contents
1. Test pyramid for an extension
2. Making code testable (what goes in model.js)
3. Running pure tests under gjs
4. Running pure tests under node
5. Fakes for ports
6. Lifecycle tests (enable/disable leaks)
7. D-Bus contract tests
8. Manual test matrix in a nested Shell
9. CI wiring

---

## 1. Pyramid

| Level | What | Tooling | Frequency |
|---|---|---|---|
| Unit | `model.js`, `lib/pure/*`, routing/visibility policies | `gjs -m` runner or `node --test` | every commit |
| Contract | helper D-Bus XML vs live service; `HistoryStore` adapters share one suite | `dbus-run-session`, gdbus, cargo test | every commit touching helpers |
| Integration (light) | `lib/` wrappers with real GLib (timeouts cleared, signals disconnected) | gjs | every commit |
| System (manual) | real Shell, nested/devkit session, matrix below | human, checklist | per release / per feature PR |

gnome-shell's own CI runs jasmine unit tests (`tests/unit/`) and
`gnome-shell-test-tool --headless` scripts (`tests/shell/`) from its build tree; neither
is packaged as a harness for third-party extensions, so for Guava the system level stays manual — which is exactly why the lower levels must carry the logic.

## 2. What goes in model.js

Pure candidates already in the repo:

- `features/appButtons/index.js:177-208` `_parseButtonLayout` — string → `{side, buttons}`.
- `features/appButtons/gtkTheme.js:38-…` `_stylesheetsFor(version)` — settings → list of CSS files
  (needs settings passed as a plain object instead of `this._settings.get_*`).
- `(Kiwi: apps/batteryPercentage.js; Guava equivalent not verified):93-126` — "show/hide/animate?" from `(percentage, state, last)`.
- `features/calendar/index.js` `checkForNotifications` logic once sources are passed as values.

Rule: model functions take plain values and return plain values or decision tags
(`'show' | 'hide' | 'animate-in'`). No `gi://` imports means they run anywhere.

## 3. Pure tests under gjs

Zero dependencies; GJS supports ESM with `-m`.

```js
// test/run.js — gjs -m test/run.js
import System from 'system';
import * as wc from './appButtons.model.test.js';
import * as ah from './autoHideBar.model.test.js';

let failed = 0, passed = 0;
for (const mod of [wc, ah]) {
    for (const [name, fn] of Object.entries(mod)) {
        try { await fn(); passed++; } catch (e) { failed++; printerr(`FAIL ${name}: ${e.message}`); }
    }
}
print(`${passed} passed, ${failed} failed`);
System.exit(failed ? 1 : 0);
```

```js
// test/appButtons.model.test.js
import { parseButtonLayout } from '../features/appButtons/model.js';

function eq(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

export function rightSideDefault() {
    eq(parseButtonLayout('appmenu:minimize,maximize,close'),
       { side: 'right', buttons: ['minimize', 'maximize', 'close'] });
}
export function leftWinsTie() {
    eq(parseButtonLayout('close:minimize').side, 'left');
}
export function emptyFallsBack() {
    eq(parseButtonLayout(':').buttons, ['minimize', 'maximize', 'close']);
}
```

Alternative: jasmine-gjs (`jasmine` runner for GJS — https://github.com/ptomato/jasmine-gjs)
if you want `describe/it/expect`; gnome-shell itself uses it (`find_program('jasmine')`
in its `meson.build`, specs in `tests/unit/`). Upstream repo activity: unverified (github.com blocked for this repo).

## 4. Pure tests under node

Because models have no GI imports, `node --test` also works and gives watch mode and
coverage (`--experimental-test-coverage`). Node must see `.js` as ESM: either Node
≥ 22.7 or ≥ 20.19 (ESM syntax detection on by default since then) or a
`package.json` with `"type": "module"` at the repo root (not packed: `gnome-extensions
pack` only includes listed sources).

```js
// test/appButtons.model.test.js (node flavour)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseButtonLayout } from '../features/appButtons/model.js';

test('dedupes buttons', () => {
    assert.deepEqual(parseButtonLayout(':close,close,minimize').buttons, ['close', 'minimize']);
});
```

Pick one runner for the repo; gjs is closer to production (same JS engine, SpiderMonkey).

## 5. Fakes for ports

```js
export class FakeClock {
    t = 0; #q = [];
    now() { return this.t; }
    after(ms, fn) { const job = { at: this.t + ms, fn }; this.#q.push(job); return { destroy: () => (job.fn = null) }; }
    advance(ms) { this.t += ms; for (const j of this.#q.filter(j => j.at <= this.t)) j.fn?.(); }
}

export class MemoryHistoryStore {        // also the production fallback when no helper
    #items = [];
    async add(e) { this.#items = [e, ...this.#items.filter(x => x.hash !== e.hash)]; }
    async list(n) { return this.#items.slice(0, n); }
}
```

Shared contract suite: write `historyStoreContract(makeStore)` once and run it against
`MemoryHistoryStore` (unit) and `HelperStore` (contract level, needs bus).

## 6. Lifecycle tests

The review guidelines make cleanup a MUST ("Any objects or widgets created by an
extension MUST be destroyed in disable()"); leaks are what reviewers check. Make
them visible:

- `lib/` wrappers count live resources in dev builds: `SignalTracker.live`,
  `Timeouts.live`. After `disable()` in a looking-glass session, assert all zero.
- Script: in Looking Glass (`Alt+F2`, `lg`) or `gnome-extensions disable/enable guava-os@blueyzx64`
  ×10, then check `journalctl --user -f /usr/bin/gnome-shell` for
  `disconnect`/`already disposed`/`Source ID … not found` warnings.

## 7. D-Bus contract tests

```sh
# test/contract-clipboard.sh — run in CI under dbus-run-session
set -eu
helpers/target/debug/kiwi-clipboardd & pid=$!; trap 'kill $pid' EXIT
gdbus wait --session --timeout 5 io.github.kem_a.Kiwi.Clipboard
gdbus introspect --session --dest io.github.kem_a.Kiwi.Clipboard \
  --object-path /io/github/kem_a/Guava/Clipboard --xml > /tmp/live.xml
xmllint --xpath '//interface[@name="io.github.kem_a.Kiwi.Clipboard1"]' /tmp/live.xml > /tmp/a
xmllint --xpath '//interface[@name="io.github.kem_a.Kiwi.Clipboard1"]' helpers/dbus/io.github.kem_a.Kiwi.Clipboard1.xml > /tmp/b
diff -u /tmp/b /tmp/a
gjs -m test/helperClient.contract.js      # calls ListAsync/AddTextAsync through the real adapter
```

Order-insensitive comparison may be needed (zbus may sort members differently).

## 8. Manual matrix (nested / devkit Shell)

Start a disposable Shell: GNOME ≤ 48 `dbus-run-session gnome-shell --nested --wayland`;
GNOME 49+ (X11 off, nested gone) `dbus-run-session gnome-shell --devkit --wayland`
(needs `mutter-devkit`). Run with `MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080`
for a fixed size.

| Scenario | Check |
|---|---|
| Toggle feature key on/off ×3 | no warnings, no duplicate actors |
| Disable/enable whole extension ×3 | stock Shell restored exactly (panel order, styles, overview) |
| Lock/unlock | features re-enable; helper state persists |
| Overview open/close, workspace switch | no stuck visibility state |
| Fullscreen, maximize, tiling | window controls, auto-hide bar, notch respond |
| Monitor hotplug / scale change | layout coordinator re-lays out |
| Dash-to-Dock enabled/disabled live | dock-dependent features follow (`extension.js:296-302`) |
| Helper absent / killed mid-use | degraded mode, no exceptions |
| GNOME 48, 49, 50, 51 (metadata.json) | each version-strategy branch exercised |
| Light/dark, high contrast, large text | glass/blur legible |

Keep the matrix in the PR template for features touching Shell internals.

## 9. CI wiring (sketch)

```yaml
unit:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: sudo apt-get install -y gjs
    - run: gjs -m test/run.js
```

Add the Rust job from `rust-gnome/references/error-handling-and-testing.md` when
helpers exist.

Sources: Bernhardt, "Boundaries" (isolated unit tests on values) —
https://www.destroyallsoftware.com/talks/boundaries ; Cockburn's test-driven ports —
https://alistair.cockburn.us/hexagonal-architecture/ ; GJS ESM (since GJS 1.68) —
https://gjs.guide/guides/gjs/intro.html ; Node test runner — https://nodejs.org/api/test.html ;
syntax detection — https://nodejs.org/api/packages.html#syntax-detection ; devkit/nested —
https://gjs.guide/extensions/development/debugging.html ; gnome-shell tests —
https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/tests/meson.build .
