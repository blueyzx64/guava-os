# Fix brief: hand-over audit (orchestrator; read-only for agents)

Context: the user asked that nothing we can test here be left for them to find. Six read-only reviewers
wrote findings in /home/user/.swarm/guava-os/agents/review/RV1..RV6.md. You fix the ones assigned to you.

## Common (every lane)
- FIRST: `git reset --hard claude/guavaos-codebase-refactor-qigqgw` in your worktree.
- Read: CLAUDE.md, docs/agents/workflow.md (memory, claims, tokens: obey), docs/agents/learnings.md, the
  review file(s) named for your lane, and the matching .claude/skills. Memory: agents/<you>.md.
- For EVERY finding assigned to you: (1) confirm it first: a failing unit test, or a real-Shell assert in a
  scenario (reviewers only read code; some findings may be wrong: then write why in memory and skip it);
  (2) fix the root cause; (3) the test passes. Severity high and medium: mandatory. Low: fix unless the fix
  is risky or large; then write the reason (it goes in the hand-over notes).
- Harness: `GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 GUAVA_EXTRA=<bundle> tools/harness/run-f44.sh 1`. The error
  counter now also counts errors whose stack follows a blank line, so "Guava errors" must be 0 for real.
  Display options now exist: GUAVA_MONITORS="1280x800 1280x800" (two monitors side by side),
  GUAVA_SCALE=2 or 1.25, GUAVA_X11=1 (Xwayland on). Use them where your findings involve them.
  Run all scenarios of your area at the end with `tools/scenarios/run-all.sh <filter>` (filter = a name part).
- Done: make check green (it now includes tools/check-refs.mjs), your scenarios 0 errors / 0 fail.
  Commit in your worktree, never push, never edit docs/agents/learnings.md (LEARN: lines in memory).
- Fail fast: same error twice -> STATUS: blocked. Report ≤ 150 words: per finding ID: fixed (test) /
  wrong (why) / skipped (why); harness lines; SHAs; branch.

## F1 · Glass (RV2 glass findings)
Paths: lib/glass.js, lib/glassBlur.js, lib/glassParams.js, lib/menuGlass.js, lib/wallpaper*.js,
features/liquidGlass/**, tests/glass*.test.js, tools/scenarios/glass-*.sh.
Findings: RV2-1 (capture ignores redraw clip: glass blurs its own previous frame, drifts dark/ghosted),
RV2-3 (static dock/bar blur stale when a window leaves), RV2-4 (color-scheme / XML wallpaper change not
detected), and every other glass/blur finding in RV2.md (gl-video-memory-purged unhandled, per-frame texture
reallocation, governor clock mismatch). Also check: does Guava decode the default GNOME 50 wallpaper (.jxl)?
Install it in a copy of the root (`dnf install gnome-backgrounds` inside /tmp/claude-0/x2/<root>.enter.sh is OK)
and assert the wallpaper tint is read. Prove "no drift": capture a glass surface's pixels, trigger 50 partial
redraws under it, compare (difference ~0). Run glass at GUAVA_SCALE=2 and 1.25 and check sharp edges.

## F2 · Lock and lifecycle (RV2 lock/lifecycle findings, RV4-2, RV4-3, RV4-5)
Paths: extension.js, lib/featureRegistry.js, lib/lockModel.js, lib/disposables.js, core/layout.js,
features/lockScreen/**, features/inputIndicator/**, features/osd/**, features/onboarding/**,
tests/lock*.test.js, tools/scenarios/lock-*.sh.
Findings: RV2-2 (trackFullscreen chrome re-shown while locked; dock pops over full-screen video after
unlock), lock suspension is one-shot (ease() re-shows hidden actors while locked), OSD while locked,
RV4-2 (lockScreen apply() no rollback on exception: half-styled lock screen), RV4-3 (hint counter counts
cancel/suspend/timeout), RV4-5 (inputIndicator and OSD pill show while locked), remaining RV2 lifecycle
items, every remaining RV4 item except RV4-1 (pointer: already fixed) and RV4-4 (Now Playing on the lock
screen is by design; keep it).
Also (O audit): at first login features/onboarding calls openPreferences(); in the harness the Shell's
OpenExtensionPrefs D-Bus call then times out (25 s, 'Timeout was reached', features/onboarding/index.js:46),
although the prefs window does open when asked later. Measure how long the prefs window takes to appear
when opened at login vs. later (tools/scenarios/prefs-smoke.sh shows how to open and find it); if the
prefs process is slow (sync work in prefs.js / prefs pages at build time, e.g. fc-list, file reads), make
it fast (the window must appear within 1 s on llvmpipe; build heavy pages lazily). The harness now counts
prefs-process errors (blank markup rows, JS errors) in "Guava errors".
Proof: a lock scenario with a full-screen window open, an ease running at lock time, a volume change while
locked: nothing of Guava visible or reactive while locked; after unlock the dock stays hidden over full screen.

## F3 · Windows (RV3 all) + sweep failure
Paths: features/fullscreenSpace/**, features/windows/**, features/appButtons/**, features/minimizeEffect/**,
features/missionControl/**, features/splitView/**, features/switcher/**, features/roundedCorners/**,
features/gestures/**, features/hotCorners/**, features/menuBar/fullscreenReveal.js, tests and scenarios of these.
Findings: everything in RV3.md (RV3-1 splitView after zoom+fullscreen, RV3-2 minimize _play not fully
guarded: window stuck, RV3-3 new window from a full-screen Space goes to workspace 0 unactivated, and the lows).
Sweep failure: tools/scenarios/menus-regress.sh "Ctrl+F2 over full screen opens an app menu" FAILS on the
current branch: find the cause (green button / fullscreenReveal / notch stacking changes are suspects) and fix.
Also run your scenarios with GUAVA_X11=1 (an X11 app: install xterm or use an Xwayland test window) and
GUAVA_MONITORS="1280x800 1280x800" (tiling and full screen on the second monitor).

## F4 · Stage Manager + Show Desktop (RV1 all)
Paths: features/stageManager/**, features/showDesktop/**, features/dock/ (only the Alt-click path: claim
the file briefly), features/launchpad/ (same), tests and scenarios of these.
Findings: RV1-1 (openIntoStage never called: implement Option/Alt-click on a dock or Launchpad app = open into
the current stage, as macOS, and test it), RV1-2 (Show Desktop does nothing when the stage has no managed
window: fall back), RV1-3 (strip slides on workspace add/remove: only on a real switch), RV1-4 (removing a
middle workspace loses stages on shifted workspaces: verify in the harness first), and the lows.

## F5 · Dock, bar, notch, tray (RV5 all) + sweep error
Paths: features/dock/** (except the Alt-click path while F4 holds it), features/menuBar/** except
fullscreenReveal.js, features/menuBarItems/**, features/notch/**, features/notificationCenter/**,
features/calendar/**, features/focus/**, core/appMenus/**.
Findings: RV5-1 (auto-hide barrier spans the whole primary edge, never released: blocks the pointer into a
neighbouring monitor: prove with GUAVA_MONITORS="1280x800 1280x800" and a left/right dock), RV5-2 (SNI pixmap
not validated: check byte length = w*h*4 and cap the size), RV5-3 (extension order on disable during the dock
shield), RV5-4 (fix only the stale atspi.js header: accessibility on by default is the user's choice).
Sweep error: features/dock/index.js:132 "St.Widget has been already disposed" (seen in dock-magnify.sh and
latency-cold.sh): find and fix.

## F6 · Clipboard, desktop icons, the rest (RV6 all)
Paths: lib/paste.js, features/clipboard/**, features/emoji/**, features/desktopIcons/**, features/spotlight/**,
features/controlCenter/**, features/launchpad/** (not the Alt-click path), features/widgets/**, core/widgets/**,
features/screenshots/**.
Findings: RV6-1 (paste fallback restores a password-manager secret without its hint mime: history records it),
RV6-2 (renaming an executable .desktop launcher drops the .desktop suffix), RV6-3 (history.json.bad-* left with
old text after Clear history), and the lows. Then the line-by-line pass RV6 did not do: features/controlCenter
layout code, features/launchpad/view.js, the widget views: read them for the review.md defect classes; fix
what you find (with tests).
Also (O audit, low): the prefs process logs ~18 Gjs-CRITICAL "Attempting to run a JS callback during
shutdown" when it exits: settings handlers disconnected from widget 'destroy' handlers (prefs/widgets.js:16
watchKey, prefs/setupAssistant.js, prefs/pages/loginItems.js, features/{clipboard,hotCorners,notch}/prefs.js).
Disconnect them when the window closes (close-request) instead, so no destroy handler runs at shutdown;
the run summary prints the count ("prefs process shutdown callbacks"): make it 0.
