# Wave 3 brief (orchestrator; read-only for agents)

## Common (every lane)
- FIRST: `git reset --hard claude/guavaos-codebase-refactor-qigqgw` in your worktree (it may be on an old commit).
- Read narrowly: shared/brief.md, decisions.md (D-004 tokens, D-017..D-021 = user decisions this wave),
  worktree CLAUDE.md, docs/agents/workflow.md ("Limits and tokenomics": obey), docs/agents/learnings.md,
  conventions.md, the feature page of your area, the skills in .claude/skills that match (apple-design for
  any visible UI; mutter-windows, gjs-clutter-motion, gnome-shell-extension, guava-harness, fedora-gnome-platform).
- Memory: /home/user/.swarm/guava-os/agents/<you>.md (STATUS line, ≤ 60 lines). Claim before edit with
  tools/agents/claim.sh; files, not whole folders, when your folder is shared with another lane (below).
  Hot spots (features.js, schema xml, core/events.js, stylesheet.css, code-map.md) by short claim only.
- Root cause in memory before any fix. Tests first: pure logic in *Model.js + tests/; a real-Shell scenario in
  tools/scenarios/<area>-*.sh for anything visible. Interaction bar: every action shows a visible response
  within 250 ms of input (D-021); animations smooth, interruptible; native resolution.
- Done: `make check` green; ONE final harness `GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 GUAVA_EXTRA=<bundle>
  tools/harness/run-f44.sh 3` -> Guava errors: 0, probes PASS, your scenarios PASS (grep, never dump logs).
  Docs and code-map rows match. LEARN: lines. Commit in worktree, never push, never write shared/.
- docs/agents/learnings.md is orchestrator-only: put lessons as LEARN: lines in your memory file, never edit it (edits collide on merge). stylesheet.css is generated: run make css, never hand-merge.
- Claim FILES in tools/scenarios/, never the whole folder (every lane adds scenarios there).
- Fail fast: same error twice -> STATUS: blocked, stop. Final report ≤ 150 words: STATUS, root causes,
  results (SUMMARY / ASSERT SUMMARY / PERF lines), SHAs, branch.

## L10 · Windows (B17, B23, B24)
Paths: features/menuBar/fullscreenReveal.js, features/windows/* EXCEPT drag.js (L15), features/minimizeEffect/**,
features/appButtons/**.
- B17: when the menu bar slides in over a full-screen window, show a green "exit full screen" control (macOS:
  the title bar slides in with the traffic lights). Click = leave full screen (same path as the green button).
- B23: tiling snaps (drag zones, shortcuts, Fill, halves) animate the move/resize like Tiling Shell does (study
  /home/user/.swarm/guava-os/refs/tilingshell if present, else shallow-clone domferr/tilingshell), through
  ctx.motion, interruptible; no blurry stretched frames (animate a clone or use Mutter's size-change effect).
- B24: minimizing a FULL-SCREEN window shows no Genie (restore does animate). Find the cause (L1 notes:
  grep -n -i full /home/user/.swarm/guava-os/agents/L1.md) and fix.

## L11 · Stage Manager (B31, D-017)
Paths: features/stageManager/**, tests/stageManager*.test.js, docs/features/stage-manager.md,
tools/scenarios/stage-manager-*.sh.
- D-017: remove the 400 ms grace (a clicked strip set takes the stage at once); the strip slides on workspace
  switch. Update the SM-n rules in the spec and the scenarios.
- B31: drag a strip thumbnail onto the stage (its windows join the current set) and drag a window onto a
  thumbnail (the window moves to that set), as macOS. Pointer drag, drop highlight, interruptible, Esc cancels.

## L12 · Typography (B19, B20)
Paths: features/typography/**, tests/typography*.test.js, docs/features/appearance.md (typography part).
Read /home/user/.swarm/guava-os/agents/R2/fonts.md first (the research) and /home/user/macos-font-rendering.
- B19: GNOME 50 `org.gnome.desktop.interface font-rendering` = 'automatic' makes GTK4 ignore font-hinting.
  Verify in the f44 root, then own `font-rendering 'manual'` with the other macOS-rendering keys (core/originals).
- B20 (D-019, ON by default): heavier text via FreeType stem darkening in a Guava-marked
  ~/.config/environment.d/ file (async IO via lib/fileOps.js, removed when the option is off, never touching
  files Guava didn't write). Verify it works: in the harness, render a GTK3 and a GTK4 app after a fresh
  session start with and without it, screenshot both, compare stem width by pixels (not by eye only). If it
  does not work, say so and do not ship it.

## L13 · Dock (B18, B22, B28-dock)
Paths: features/dock/**, tests/dock*.test.js, docs/features/dock.md.
- B18: magnification scales a 48 px icon bitmap up to 2x (features/dock/items.js:143, magnify.js:155): blurry.
  Render icons at the size they are shown (request the icon at max magnified size x monitor scale, or swap
  textures by size), keep magnification smooth (no texture reload per frame).
- B22 (unverified finding): removing Dash to Dock from enabled-extensions can make GNOME re-enable Guava at
  login (features/dock/dashToDock.js). Reproduce in the harness or prove it can't happen; fix if real.
- B28-dock: magnification turns off while ctx.motion.env.degraded (see core/motion.js, event motion-changed).

## L14 · Lock screen and login (B21, B27, login perf)
Paths: extension.js, metadata.json, lib/featureRegistry.js, features.js, features/notch/** (B27 only),
features/missionControl/** (overview flash only), docs/features/system-ui.md.
- B21 (D-018): Guava stays alive while locked: add 'unlock-dialog' to session-modes; on lock, every Guava
  surface hides and goes inert (no input, no keybindings, no popups, no notifications shown), and unlock
  restores it instantly. Follow the EGO rules for unlock-dialog (gnome-shell-extension skill + references).
  Measure lock and unlock cost before/after in the harness (the harness has no real lock screen: drive
  Main.sessionMode / screenShield as tools/harness/README.md "Limits" allows, or document what can't be done).
- B27: the notch moves once after it first shows at login (shown ~2660 ms, settles ~3020 ms when desktop icons
  appear). Make it appear in its final place.
- Login perf failures (tools/scenarios/run-perf.sh): login.ready_ms (2524 vs limit ~1802), login stall total,
  overview flash at login. Cut what Guava costs at login; GNOME 50 runs the overview animation before extensions
  enable (learnings), so find what Guava can still do (e.g. hide the overview at once when it is visible at
  enable). Re-run the suite at the end and paste the login.* lines.

## L15 · Responsiveness and performance (B11 fails, B26, B28, D-021)
Paths: tools/scenarios/perf-*.sh, tools/scenarios/run-perf.sh, tools/scenarios/perf-compare.py,
tools/scenarios/README.md, core/motion.js, core/motionModel.js, lib/glass*.js, features/windows/drag.js,
features/roundedCorners/**, features/menuBar/* (menu open cost; claim files, L10 holds fullscreenReveal.js),
features/controlCenter/** (Quick Settings open cost). Other folders: ASK O.
Fresh suite on the merged branch (2026-11-03 08:42, 21 PASS 8 FAIL; noisy: other agents ran harness at once):
  FAIL login.ready_ms guava=53685 limit=52213 (L14 owns login; menu-bar starts in 379 ms: share findings)
  FAIL login.overview_flash 1 (L14)
  FAIL idle.paints guava=1 limit=0
  FAIL overview.p95_ms 37.2 (stock 20.3, limit 31.4)
  FAIL menu.p95_ms 123.5 (stock 57.9, limit 80.3)       <- Quick Settings / Control Center open+close
  FAIL drag.p95_ms 69.8 (stock 21.7, limit 33.2)         <- B26 titlebar drag
  FAIL menu-load.p95_ms 233.5 (stock 88.1, limit 142.2)
  FAIL burst.stalls50 8 (limit 4.5)
  INFO degraded-under-load=false  <- the FrameBudget never trips under the overload: B28
1. D-021 first: add an absolute response-latency metric to the suite: input (real virtual key/pointer via
   lib.sh, not a JS call) -> first painted frame where the response is visible (stage after-paint / presented,
   condition on the target actor: mapped, opacity > 0, or overview progress > 0). Interactions: Super tap
   (Spotlight), F3 / Ctrl+Up (Mission Control), click Control Center button, click clock (Notification Center),
   click an app menu in the menu bar, dock icon click (time to bounce/feedback, not app start), notch hover,
   window titlebar press (drag start), Super+A (Launchpad), Super+Tab (switcher). PASS when p95 ≤ 250 ms
   absolute (llvmpipe makes this pessimistic: also print stock's value where stock has the same action).
   Commit the metric BEFORE optimising; record the baseline in memory.
2. Then fix in order of user impact: anything over 250 ms; menu.p95 and menu-load (profile what Guava adds to
   Quick Settings open: glass capture, layout, CSS); drag.p95 (B26: tiling drag zones per motion event?
   rounded-corners effect per frame?); overview.p95; idle.paints (find the paint: an ease left running, a
   blinking actor, a timer); burst.stalls50.
3. B28: make the FrameBudget trip under the suite's overload (it never did) and have liquid-glass live blur,
   Launchpad / Mission Control live previews and the Genie (fall back to scale) consume env.degraded
   (L13 does dock magnification). Each with a test.
Final: run the whole suite once when no other harness run is going (`pgrep -f run-real.sh` empty, wait for
it), paste the full summary.

## L16 · Lock screen like macOS (B32, D-022) — starts after L14 merges
Paths: features/lockScreen/** (new), tests/lockScreen*.test.js, docs/features/lock-screen.md, prefs page group,
schema keys `lockscreen-*`. Uses L14's opt-in hook (`lockScreen: true` entry; read docs/features/system-ui.md).
Restyle GNOME's own lock screen (ui/screenShield.js, unlockDialog.js, the clock: read them in
/home/user/.swarm/guava-os/refs/gnome-shell-50.6-js) the macOS Tahoe way; never replace GNOME's auth path
(gdm auth prompt, polkit): only style and arrange it. Defaults follow macOS System Settings > Lock Screen:
- Large clock: macOS Tahoe style (date above, big light time, centred upper third). Option: Show large clock:
  on the lock screen / never.
- Wallpaper: the desktop wallpaper, sharp (macOS) with an option for blurred (GNOME style).
- Bottom centre: user photo, name, and the password field as a glass capsule ("Enter Password"); show password
  hint option (off).
- Options: show user name and photo (on); show a message when the screen is locked (text, off); show Sleep,
  Restart and Shut Down buttons (off on lock, as macOS); Now Playing controls on the lock screen (on, media only:
  no app data); notification previews on the lock screen: never / when unlocked (default: count only).
- Privacy and safety: no notification bodies, clipboard, Spotlight, widgets with personal data or any Guava
  input surface while locked. Every element keyboard-accessible, screen-reader names, reduced motion honoured,
  contrast ≥ 4.5:1 over any wallpaper (glass rules from the apple-design skill). Unlock animation smooth and
  interruptible; response ≤ 250 ms (D-021).
- Prefs: a "Lock Screen" group (Preferences > General or Appearance; choose by prefs/pages/).
Tests: pure layout/options model + tests; harness scenario driving the shield (Main.screenShield.lock() /
activate as the harness allows; document limits), screenshots of each option state checked by reading them,
and assert no Guava actor other than the lock-screen ones is visible or reactive while locked.

## L18 · Login parse cost (B34)
Paths: lib/featureRegistry.js, features.js, and inside features (NOT notch, notificationCenter, missionControl, minimizeEffect: L19) ONLY the import structure (move heavy imports
behind first use): claim files one by one; L11 holds features/stageManager/**, L15 holds core/motion*, lib/glass*,
features/windows/drag.js, features/roundedCorners/**, features/menuBar/* files it claimed, features/controlCenter/**
(check `tools/agents/claim.sh list`; ASK O if you need one of those).
Facts (L14): login ready bound by Guava module parsing (~500 ms), not enable() (~270 ms). Perf suite
(tools/scenarios/run-perf.sh) last: login.ready_ms 2604 vs limit 2090, login.stall_total_ms 1357 vs 1256.
Start costs at login (ms): menu-bar 379, desktop-icons 132, typography 50, popup-menu-styling 40, mission-control 38,
liquid-glass 36, clipboard-history 33, dock 25.
1. Measure first: per-module import/parse time at login (wrap the registry's load() and each feature's own
   top-level imports; GJS has no import timer: time the dynamic import()s and bisect static ones). Record in memory.
2. Cut the login path: code a feature needs only on first use (menus, dialogs, prefs-like views, editors,
   galleries, calculators, parsers) moves behind a dynamic import at first use; avoid top-level work in modules;
   merge tiny always-needed modules only if parse cost proves it. No behaviour change; nothing visible may appear
   later than today (chrome at login stays immediate).
3. Re-run run-perf.sh when no other harness run is going; target login.ready_ms and login.stall_total_ms PASS.

## L19 · 250 ms misses (B35, D-021)
Paths: features/notch/**, features/notificationCenter/**, features/missionControl/**, features/minimizeEffect/**
(L18 must not touch these folders). Suite: tools/scenarios/run-perf.sh (perf-latency.sh = D-021 metric, real
input -> first painted response, p95 <= 250 ms). Last numbers (noisy run, other harnesses busy): latency.clock 366
(cold Notification Center build), latency.notch-hover 657 (300 ms dwell + open), latency.mission-control 495 (first
of 5 runs cold; median ~76), overview.p95 55 (stock 21), burst.stalls50 5 (limit 3). L15 notes:
/home/user/.swarm/guava-os/agents/L15.md.
- Cold first opens: build what the first open needs once after login at idle (low priority, in chunks so no frame
  pays > 8 ms), or show a cheap frame immediately and fill in after; never block input.
- Notch hover: the dwell stays (no accidental opens), but the user must SEE a response within 250 ms: the pill
  starts its expand (or a hover highlight) on the first frame of hover, the full open follows the dwell; leaving
  early retargets back smoothly.
- overview.p95 vs stock and burst stalls: profile what Guava adds to the overview open/close per frame
  (missionControl restyle, glass on the bar, Stage Manager strip, dock), fix the top cost.
- B28: Genie falls back to Scale while ctx.motion.env.degraded; Mission Control / App Exposé live previews go static
  (or lighter) while degraded. Tests for each.
Run the suite at the end when no other harness run is going; paste latency.* and overview/burst lines.
