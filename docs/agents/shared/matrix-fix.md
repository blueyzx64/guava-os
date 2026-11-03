# Display-matrix fix brief (orchestrator; read-only for agents)

Context: final verification found failures that only appear on two monitors or at 1.25x / 2x scale. The user
cares most that rendering is crisp and animations smooth at the display's native resolution (principles §2).
Harness display options: GUAVA_MONITORS="1280x800 1280x800" (two monitors), GUAVA_MONITORS="1600x1000"
GUAVA_SCALE=1.25, GUAVA_MONITORS="2560x1600" GUAVA_SCALE=2 (logical size stays 1280x800). A scenario can put
`# harness-env: ...` in its first lines; tools/scenarios/run-all.sh <name> passes outer GUAVA_* env through.
Results from the matrix: /tmp/claude-0/matrix.txt (logs /tmp/claude-0/matrix-*.log and /tmp/guava-all.*).

## Common
- FIRST: `git reset --hard claude/guavaos-codebase-refactor-qigqgw` in your worktree. The extension is in src/
  (code paths in docs are relative to src/; tests import ../src/...).
- Read CLAUDE.md, docs/agents/workflow.md (tokens, claims: obey), docs/agents/learnings.md, the skills
  gjs-clutter-motion, guava-harness, mutter-windows. Memory: agents/<you>.md. Never edit learnings.md.
- First decide, with evidence, whether each failure is (a) a Guava bug or (b) an artefact of software rendering
  at 4x pixels (llvmpipe): measure frame rate / frame times at scale 1 vs 2 in the same scenario; check the
  effect's own state (did it start? texture size? errors?) independent of timing. (b) is fixed in the TEST
  (sample by animation progress / actor state, not by wall-clock frames), (a) in the code. Never weaken an
  assert just to pass: if you change an assert, the commit message says why and what it now proves.
- Done: the scenario passes at scale 1, 1.25 and 2 (and on two monitors where relevant), Guava errors 0;
  make check green. Commit in worktree; never push. Report <= 150 words: cause (a or b, with the evidence
  numbers), fix, results at each display, SHAs, branch.

## G1 · Genie on HiDPI
tools/scenarios/minimize-genie.sh: 16/16 at scale 1; 11/16 at 1.25 (genie-maximized, genie-fullscreen,
genie-restore-turns-back-in-place, genie-restore-turn-smooth, genie-minimize-during-restore fail); 7/16 at 2
(even genie-minimize-runs, genie-restore-runs, genie-texture-native-1to1 fail). Paths: src/features/minimizeEffect/**,
tests/minimizeEffect*.test.js, tools/scenarios/minimize-genie.sh. Check texture size vs monitor scale (resource
scale, paint box), max texture size, the effect's start conditions, and timing.

## G2 · Stage Manager strip slide on HiDPI
tools/scenarios/stage-manager-strip.sh: "SM-27 the strip moved over several frames (slid), not in one jump" fails
at 1.25 and 2 (passes at 1). Paths: src/features/stageManager/**, tools/scenarios/stage-manager-*.sh.

## G3 · Lock screen on two monitors
tools/scenarios/lock-screen-style.sh with GUAVA_MONITORS="1280x800 1280x800": "clock centred in the upper half",
"password capsule at the bottom centre", "prompt ends where the teaser did, centred" fail (pass on one monitor
and at 1.25/2). Expected (macOS): the lock UI centred on the PRIMARY monitor; other monitors show the wallpaper
only. Paths: src/features/lockScreen/**, tools/scenarios/lock-screen-style*.sh. Also check monitor hot-plug while
locked (add/remove a monitor: harness DisplayConfig) if cheap.
