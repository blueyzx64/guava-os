# EGO review guidelines, shexli rule IDs and common pitfalls

Summary: the extensions.gnome.org (EGO) review rules that reviewers enforce, mapped to the rule IDs that the shexli static analyzer prints (EGO-M/P/I/L/X/A/C*), with a pre-submission checklist.
It also lists the leak and lifecycle bugs reviewers reject most often and how to log properly. The rule IDs are shexli's (spec 2026-04-02), not part of gjs.guide.
Sources: https://gjs.guide/extensions/review-guidelines/review-guidelines.html (full page re-read 2026-10-25), the shexli 0.2.1 `spec.py` (PyPI), and gnome-shell main source.

## Contents
1. Rule table (guideline → shexli ID)
2. Version-gated rules (C45/C49/C50)
3. Policy rules (AI, legal, telemetry, clipboard)
4. Top rejection causes and fixes
5. Logging
6. Guava pre-submission checklist
7. Sources

## 1. Rule table
| Guideline section (gjs.guide anchor) | shexli IDs | Rule |
|---|---|---|
| metadata.json must be well-formed | M-001..M-007 | exists, valid JSON, uuid format/namespace, plausible `shell-version` (at most one dev release), no redundant `session-modes: ["user"]`, only `user`/`unlock-dialog`, `donations` keys allowed |
| Session Modes | M-008 | using `unlock-dialog` requires a comment in `disable()` explaining why |
| GSettings Schemas | P-001..P-004 | id `org.gnome.shell.extensions.*`, path `/org/gnome/shell/extensions/*`, XML shipped, filename = `<id>.gschema.xml` |
| Scripts and Binaries | P-005 | no bundled binaries or libraries. **Guava's `advanced/` native libs must stay out of the EGO zip** (CI already omits them) |
| Don't include unnecessary files | P-006, P-007 | no `gschemas.compiled` (45+), build or translation artifacts, or unreachable JS |
| Do not use deprecated modules | I-001 | for example `ByteArray`, `Lang`, `Mainloop`, legacy `imports.*` |
| Do not import GTK libraries in GNOME Shell | I-002 | no Gtk, Gdk or Adw in shell files |
| Do not import GNOME Shell libraries in Preferences | I-003 | no Clutter, Meta, St or Shell in prefs files |
| InjectionManager | I-004 | don't use `imports._gi` directly |
| Only use initialization for static resources | L-001 | nothing at import or in the constructor |
| Destroy all objects | L-002, L-005, L-006 | destroy in `disable()`, null the references, clean up prefs on `close-request` |
| Disconnect all signals | L-003 | |
| Remove main loop sources | L-004, L-007 | remove in `disable()`, and remove before re-adding to the same field |
| (Soup) | L-008 | `Soup.Session.abort()` on cleanup |
| Privileged Subprocess must not be user-writable | X-001 | `pkexec` only, on non-user-writable targets |
| (gjs.guide subprocess/file guides) | X-002, X-004 | no synchronous subprocess or file I/O in the Shell |
| (GObject docs) | X-003 | don't call `run_dispose()` |
| stylesheet.css | X-005 | don't load your own default stylesheet manually |
| extensionUtils (45 port) | X-006 | don't use `lookupByURL`/`lookupByUUID` for *your own* extension |
| Code must not be obfuscated | A-001 | no minified or obfuscated code |
| No excessive logging | A-002, A-004 | gate debug logs |
| Do not use telemetry tools | A-003 | |
| Clipboard Access must be declared | A-005 | every `St.Clipboard.get_default()` is flagged for manual review |

## 2. Version-gated rules
These only apply when `shell-version` lists the version:
- EGO-C45-001: prefs should implement `fillPreferencesWindow`.
- EGO-C49-001: no `DoNotDisturbSwitch` from calendar.js.
- EGO-C49-002: no `Clutter.ClickAction` or `Clutter.TapAction` (use `ClickGesture`).
- EGO-C49-003: no `Meta.MaximizeFlags` passed to `maximize()`/`unmaximize()`.
- EGO-C49-004: no `Meta.Window.get_maximized()`.
- EGO-C49-005: no `Meta.CursorTracker.set_pointer_visible()`.
- EGO-C50-001: no `global.display` `restart`/`show-restart-message` signals.
- EGO-C50-002: no `RunDialog._restart()`.

shexli has no C51 rules in 0.2.1. Apply `version-matrix.md` §GNOME 51
yourself: async `disable()`, `vertical`, `Shell.GLSLEffect`,
`set_shader_source`, PopupMenu `open`/`close` params, `pointerWatcher.js`.

**Detection caveat:** shexli matches call shapes. Guava's
`win.maximize(...MAXIMIZE_ARGS)` with `MAXIMIZE_ARGS = []` on 49+ is correct
at runtime, but a reviewer may still ask about it. A short comment helps. It
already has one.

## 3. Policy rules
- **Extensions must not be AI-generated.** AI as a learning aid or for code
  completion is allowed, but the developer must be able to explain the code.
  Submissions with lots of unnecessary code, inconsistent style, imaginary
  APIs, or comments that read like LLM prompts are rejected. For agents in
  this repo: match the existing Guava style, avoid speculative abstractions,
  never leave prompt-like comments, and only call APIs verified in the
  references.
- **Clipboard:** declare it in the description. No sharing with third parties
  without explicit user action. No default keyboard shortcuts for clipboard
  actions.
- **Legal:** follow the GNOME Code of Conduct. No political statements.
  Trademark use: Guava's description already disclaims any Apple affiliation.
  Avoid Apple logos or assets: "Extensions MUST NOT include copyrighted or
  trademarked content" (brand names, logos, artwork) without permission
  (review guidelines, "Copyrights and Trademarks").
- **Telemetry:** none.
- **Privileged helpers:** only via `pkexec` targeting root-owned files.

## 4. Top rejection causes and fixes
| Problem | Fix |
|---|---|
| A signal connected in `enable()` and never disconnected | `connectObject(…, this)` and `disconnectObject(this)`, or store the ids and disconnect them |
| `GLib.timeout_add` id lost or overwritten | Keep it in a field, `GLib.Source.remove(id)` before re-adding and in `disable()`, then null it |
| Actor added to `Main.panel`, `uiGroup` or chrome but only hidden on disable | `destroy()` it (and `removeChrome()`) |
| Monkey-patching prototypes by hand | `InjectionManager.overrideMethod` and `clear()` |
| `new Gio.Settings()` at module scope | Create it in `enable()` and null it in `disable()` |
| Sync `GLib.file_get_contents` or `Gio.File.load_contents` in the Shell | Async variant with `Gio._promisify` |
| Async work completing after `disable()` | `Gio.Cancellable` and an `_enabled` guard. Never make `disable()` async (51 throws) |
| `console.log` on every event | Remove it, or gate it behind a debug setting |
| Compiled schemas in the zip | Don't ship them. EGO and `gnome-extensions install` compile on install |
| Claiming an untested `shell-version` | Only list versions you have run, at most one dev version |

Memory leaks GJS can't collect:
- Closures captured by signals on long-lived Shell objects (`global.display`,
  `Main.panel`) keep your whole module graph alive.
- JS properties added to Shell objects (`Main.panel._guavaFoo = …`) must be
  `delete`d on disable.
- Destroyed actors you still reference: accessing them logs "Object … has been
  already disposed". Set references to null after `destroy()`.

## 5. Logging
- 48+: `const logger = this.getLogger(); logger.debug('…')` prefixes
  `[Guava (is not Apple)]`. Module code can receive the logger from
  `extension.js`.
- `console.debug` output only appears when the GLib debug domain is enabled
  (`G_MESSAGES_DEBUG=Gjs-Console`, the default domain in gjs
  modules/esm/console.js; `G_MESSAGES_DEBUG=all` also works). Use it for
  verbose output. `console.warn` and `console.error` are always visible.
  Guava uses `console.debug('[Guava] …')` (`(Kiwi: apps/mozillaThemeManager.js; Guava equivalent not verified)`).
- `logError(e, 'context')` prints the stack.

## 6. Guava pre-submission checklist
1. `gnome-extensions pack` with the same flags as CI. Check that the zip has
   no `advanced/`, no `*.compiled` and no `locale` duplicates.
2. Run `pipx run shexli guava-os@blueyzx64.shell-extension.zip`, or `pip install shexli`
   then `shexli <dir-or-zip> [--format json|text]` (cli.py 0.2.1). It also
   works on the source directory. The exit code is 0 even when it finds
   issues, so read the summary.
3. Run `git grep -nE "get_maximized|MaximizeFlags|ClickAction|TapAction|vertical: |GLSLEffect|set_shader_source|pointerWatcher|async disable"` and review every hit.
4. Lock and unlock the screen 3 times, then toggle every feature on and off.
   Watch `journalctl -f -o cat /usr/bin/gnome-shell` for errors and
   "already disposed" warnings.
5. Test in a nested or devkit shell for each supported version (48 to 51), or
   at least the oldest and newest.

## 7. Sources
- https://gjs.guide/extensions/review-guidelines/review-guidelines.html
- https://gjs.guide/extensions/review-guidelines/best-practices.html
- https://pypi.org/project/shexli/ (spec.py: RuleCode, RULES, SPEC_VERSION 2026-04-02)
- https://github.com/3v1n0/shexli-ci (CI wrapper)
- https://www.xda-developers.com/gnome-cracking-down-ai-generated-code-extensions-guidelines/
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/extensions/sharedInternals.js (getLogger)
