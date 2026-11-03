# Perf regression brief (orchestrator; read-only for agents)

Read first: CLAUDE.md (src/ layout), docs/agents/workflow.md (tokens/claims), docs/agents/learnings.md,
skills gjs-clutter-motion + guava-harness, tools/scenarios/README.md (the perf suite and thresholds).
FIRST: `git reset --hard claude/guavaos-codebase-refactor-qigqgw` in your worktree. Memory: agents/<you>.md.
Never weaken a threshold. Never undo a correctness fix (each has a test: keep them green).

Facts (two quiet full runs of tools/scenarios/run-perf.sh on HEAD, /tmp/claude-0/perf-final2.txt and 3.txt):
consistent FAILs: login.ready_ms 3015 / 3697 (limit ~2500), login.stall_total_ms 2117 / 2356 (~1800-1900),
login.max_stall_ms 771 / 839 (~700), menu.p95_ms 46.9 / 48.3 (stock 20, limit ~31), latency.mission-control
308 / 314 (limit 250, first open cold), burst.stalls50 6 / 6 (limit 4.5).
REGRESSIONS vs the end of wave 3 (commit 9c4425c, /tmp/claude-0/perf-final.txt): menu.p95 was 33.5 (PASS),
login.ready 2390, start costs at login were liquid-glass 35 ms (now 79-91), dock 18 (now 68-87), menu-bar 68
(now 96-100). Between 9c4425c and HEAD the audit merged: F1 glass (persistent backdrop texture + clip blit,
wallpaper/colour invalidation), F2 lock guard (SurfaceLedger.guard on notify::visible), F5 dock barrier/magnifier
guards, F6, F3, F4, the src/ restructure.

## P1 · Find and fix the regressions
1. Bisect, cheaply: write a focused scenario tools/scenarios/perf-menu.sh (just the suite's Quick Settings
   open/close step + PERF line, same warm-up) and use the login trace (GUAVA login STARTUP line, per-feature
   start times) to bisect 9c4425c..HEAD with `git checkout <sha> -- src` in a scratch worktree (never in the
   main tree), one harness run per step. Name the commit(s) that cost menu.p95 and login time.
2. Fix the cause in the code, keeping that commit's correctness test green (e.g. glass: capture only when the
   backdrop changed, not per paint; skip work for surfaces not visible; lock guard: connect per surface only
   while locked).
3. Then the remaining consistent FAILs: latency.mission-control (first open cold: warm up without visible
   animation side effects, or make the first paint cheaper) and burst.stalls50.
Done: run-perf.sh twice when no other harness run is going (pgrep -f run-real.sh must print nothing other than
your grep; wait on PIDs, never on a pgrep pattern), paste both summaries; every consistent FAIL above fixed
or explained with numbers. make check green; the scenarios of the areas you touch pass (run-all.sh <area>).
Report <= 200 words.
