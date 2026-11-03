# Testing and debugging GNOME Shell extensions

Summary: how to run a nested or devkit shell on each version (`--nested` up to 49, `--devkit` from 49), read logs, use Looking Glass and the `gnome-extensions` CLI, and reload code.
It also covers unit-testing pure logic with gjs and Jasmine, linting with GNOME's ESLint config, and getting TypeScript types.
Verified against mutter `src/core/meta-context-main.c` (48.0, 49.0, 50.0, main), gnome-shell `src/main.c` and `tools/eslint.config.js` (main), the Fedora mutter-devkit packaging (bug 2418788), and gjs.guide debugging (search excerpt).

## Contents
1. Nested and devkit shells per version
2. Logs
3. Looking Glass
4. gnome-extensions CLI and reload loop
5. Unit tests (pure logic)
6. Lint and types
7. Crash and performance debugging
8. Sources

## 1. Nested and devkit shells per version
| GNOME | Command | Notes |
|---|---|---|
| 45 to 48 | `dbus-run-session -- gnome-shell --nested --wayland` | The nested backend ran on X11/Wayland as a client window. |
| 49 | `dbus-run-session gnome-shell --devkit --wayland` | Both `--nested` and `--devkit` exist in mutter 49's options, but the X11 backend is disabled by default, so use `--devkit`. |
| 50, 51 | `dbus-run-session gnome-shell --devkit --wayland` | `--nested` is gone. Also `--devkit-args`, `--virtual-monitor WxH[@R]` (persistent virtual monitor), `--headless`. |

- `--devkit` needs the **mutter-devkit** viewer. On Fedora:
  `sudo dnf install mutter-devkit`, or `dnf install /usr/libexec/mutter-devkit`.
  The binary used to come only with `mutter-devel` (Red Hat bug 2418788). On
  Ubuntu it is `mutter-dev-bin` (per a Discourse thread).
- Window size: `MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1000` only worked with
  `--nested` (read by `meta-monitor-manager-dummy.c` up to mutter 49; no mutter
  51.0 C code reads it). For devkit, use `--virtual-monitor 1600x1000`.
- The nested shell loads extensions from `~/.local/share/gnome-shell/extensions`.
  Enable Guava with `gnome-extensions enable guava-os@blueyzx64` from a terminal
  *inside* the same D-Bus session, or pre-enable it in the
  `org.gnome.shell enabled-extensions` gsettings (shared through dconf).
- It is not isolated: it shares your dconf and files, so it can change your
  real settings.
- Useful flags (gnome-shell `src/main.c`): `--mode`, `--list-modes`,
  `--force-animations`. Env: `SHELL_DEBUG=backtrace-warnings` (or `all`) prints
  JS backtraces for warnings.

## 2. Logs
```sh
journalctl -f -o cat /usr/bin/gnome-shell     # running session
journalctl -b -o cat /usr/bin/gnome-shell | grep -i -A5 guava
journalctl -f -o cat /usr/bin/gjs             # prefs (separate process)
```
The nested or devkit shell logs to the terminal: `src/main.c` sets
`GJS_DEBUG_OUTPUT=stderr`.

## 3. Looking Glass
- Open with Alt+F2 and `lg`. Tabs: Evaluator, Windows, Extensions, Actors
  (picker).
- In the evaluator you can type `Main.panel.statusArea`,
  `global.display.focus_window`, `Main.extensionManager.lookup('guava-os@blueyzx64')`.
  `r(n)` recalls result n. Use the picker icon to inspect actors and style
  classes.
- 51 exposes `slow-down-factor` in Looking Glass (NEWS 51.alpha), which slows
  animations for debugging.
- Don't leave Looking Glass references to actors around while testing
  disable. They keep the actors alive.

## 4. gnome-extensions CLI and reload loop
```sh
gnome-extensions list [--enabled|--disabled|--user]
gnome-extensions info guava-os@blueyzx64        # state: ACTIVE, INACTIVE, ERROR, OUT OF DATE
gnome-extensions enable|disable|reset guava-os@blueyzx64
gnome-extensions prefs guava-os@blueyzx64
gnome-extensions create --interactive   # scaffold
gnome-extensions pack … ; gnome-extensions install --force <zip> ; gnome-extensions uninstall guava-os@blueyzx64
gnome-extensions upload <zip>           # 49+
```
- **Reload:** the Shell caches imported ES modules, so editing files and doing
  disable/enable does **not** reload code. On Wayland you need a new shell:
  log out and back in, or restart the nested or devkit shell. X11
  `Alt+F2 r` is gone (X11 removed in 50).
- Quick loop: symlink the repo to `~/.local/share/gnome-shell/extensions/guava-os@blueyzx64`,
  compile schemas, then run the devkit shell. Restart it after each change.
- If the extension is in the ERROR state, `gnome-extensions info` shows the
  error. The Extensions app shows it too, with improved error UI in 49
  (NEWS 49.beta).

## 5. Unit tests (pure logic)
- Shell modules (`resource:///org/gnome/shell/...`) and `global` are not
  available outside the Shell. Keep pure logic (parsers, layout math, history
  ring buffers, state machines) in modules that import only `gi://GLib` and
  `gi://Gio`, and test those with plain gjs. See the clean-architecture skill
  `references/testing-strategy.md`.
- Runner: Jasmine for GJS (`jasmine-gjs`). gnome-shell vendors it as
  `subprojects/jasmine-gjs` and its ESLint config defines Jasmine globals for
  `tests/unit/**`. It is not packaged in Fedora or Debian: build it from
  https://github.com/ptomato/jasmine-gjs with meson, then run
  `jasmine --module tests/unit/` (`--module` runs specs as ES modules; gnome-shell
  `tests/meson.build` uses `--module --tap --no-config`).
- Minimal no-dependency alternative: `gjs -m tests/run.js`, where `run.js`
  imports modules and uses `console.assert`, exiting non-zero via
  `imports.system.exit(1)` or `import System from 'system'`.
- Smoke-test in CI: GitHub's `ubuntu-latest` has gnome-shell available (Guava's
  pack workflow installs it). Headless shell tests are possible with
  `gnome-shell --headless --virtual-monitor 1280x800` under
  `dbus-run-session` (unverified on CI runners: needs a real GitHub Actions run, not a source check).

## 6. Lint and types
- GNOME's own config: gnome-shell `tools/eslint.config.js` (flat config) uses
  `eslint-config-gnome` (`gnome.configs.recommended`, `gnome.configs.jsdoc`).
  That package is **not on npm**. Install it from git:
  `git+https://gitlab.gnome.org/World/javascript/eslint-config-gnome.git`
  (as in `tools/package.json`). Shell rules on top: `camelcase` (properties:
  never), `consistent-return`, `eqeqeq: smart`, `prefer-arrow-callback`,
  `prefer-const` (destructuring all), and `jsdoc/require-jsdoc` for public
  ESM exports. Globals: `global`, `_`, `C_`, `N_`, `ngettext`.
- gjs.guide's style guide (guides/gjs/style-guide.html) documents a standalone
  setup: a legacy `.eslintrc.yml` and a flat `eslint.config.js` built on
  `@eslint/js`, plus `npx eslint .` and GitLab/GitHub CI examples.
- Types for editor and LSP: `@girs/gnome-shell` (npm, 50.0.4 at the time of
  writing), `@girs/gjs` (5.x). These are TypeScript declarations. In JS,
  load them via an `ambient.d.ts` (`import "@girs/gjs"; import
  "@girs/gnome-shell/ambient"; …`) listed in `include` (gjs.guide "TypeScript
  and LSP").
- Guava has no ESLint config committed. If you add one, match the existing
  4-space, single-quote, semicolon style.

## 7. Crash and performance debugging
- Run under gdb: `dbus-run-session -- gdb --args gnome-shell --devkit --wayland`.
  Inside gdb, `call gjs_dumpstack()` prints the JS stack (public symbol,
  gjs `gjs/context.h`).
- Profiling: Sysprof captures gjs and Shell marks (gjs NEWS mentions sysprof
  integration and `System.dumpMemoryInfo`).
- Frame drops from blur: compare with the effect disabled. Watch paint counts
  by connecting `global.stage` `after-paint` temporarily (debug only).

## 8. Sources
- https://gjs.guide/extensions/development/debugging.html
- https://gjs.guide/extensions/upgrading/gnome-shell-49.html (devkit replaces nested)
- https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/core/meta-context-main.c (options; compare tags 49.0 and 50.0)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/main.c
- https://gjs.guide/guides/gjs/style-guide.html (ESLint) ; https://github.com/ptomato/jasmine-gjs (README, src/options.js)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/tools/eslint.config.js , tools/package.json
- https://bugzilla.redhat.com/show_bug.cgi?id=2418788 (mutter-devkit packaging)
- https://discourse.gnome.org/t/gnome-49-nested-sessions-no-longer-possible/30987
- https://www.npmjs.com/package/@girs/gnome-shell
