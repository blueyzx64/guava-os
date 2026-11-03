# Resume: wave 5 (paused 2026-11-03)

Paused on the user's request. Nothing below is merged into `main`. `main` is still at `11b3750`
(the Genie-during-slide fix and the X11 green-button test fix).

Branch `claude/guavaos-codebase-refactor-qigqgw` holds everything below. Rules: `CLAUDE.md`,
`docs/agents/workflow.md`.

## Settings for this wave

- **Agent cap:** at most 3 Sonnet and 6 Haiku agents (the user lowered it from 6 and 12).
- **CPUs:** the harness machine has 4 CPUs. Run one harness run at a time per agent, and do the
  final perf numbers in one serial run by the orchestrator.
- **Agent brief:** the common brief is `/tmp/claude-0/brief-common.md`. It is lost if the
  container is reclaimed; rebuild it from `docs/agents/workflow.md` §1 and §4.

## Lanes

| Lane | Bug | Ask | State |
|---|---|---|---|
| Q4 | B41 | Liquid Glass off by default, plain Gaussian blur instead (user) | **Done**: `227d3ad`, `9a87632`. Verified (glass-frost 18/18, glass-* pass, `make check`). |
| Q2 | B39 | First Mission Control open ≤ 250 ms | **Merged, not verified**: `0b7df45` (merge `aca8004`). See the open questions below. |
| Q1 | B38 | Login ready within stock + 0.6 s (now ~2.5–2.9 s vs ~1.9 s) | **Stopped mid-work**, nothing committed. Diff saved in `docs/agents/resume/q1-login-wip.patch`. Not reviewed. |
| Q3 | B40 | Burst stalls > 50 ms under the limit (5–6 vs 4.5) | **Stopped at the start**, no fix. Its new scenario is saved in `docs/agents/resume/q3-burst-handlers.sh`. Step 1 is still to do: re-measure on the frosted default. |

### Q4: frosted blur default (done)

- `liquid-glass` now defaults to false. With it off, every surface in `liquid-glass-surfaces`
  gets a frosted blur.
  - It uses the same `GlassBlurEffect` with `look.style 'frost'` (`lib/glassParams.js` `FROST`).
  - It has no sheen, rim highlight, saturation boost, wallpaper tint or grain.
- Turning `liquid-glass` on gives the old look.
- There is no new settings key. Reduce Transparency, or an empty surfaces list, gives solid
  surfaces.
- Screenshots were in `/tmp/claude-0/q4-shots/` (ephemeral).

### Q2: Mission Control warm-up (`src/features/missionControl/warm.js`)

**What it does:** about 4 s after login, after 1.5 s idle, it paints the overview once and then
tears it down. The overview group is shown at opacity 1/255 and hidden from picks. It builds the
views and thumbnails in the WINDOW_PICKER state, waits for 2 painted frames, and tears down. It
never calls `Overview.show()`.

**Agent's numbers:** first paint 285 → ~145 ms. `latency-cold` reports a median of 98.6 ms and a
cold repetition of 189 ms.

**Problems found in review:**

1. **The bar glass fades during the warm-up.** The warm-up moves `controls._stateAdjustment`, and
   the menu-bar glass presence follows that adjustment (`features/liquidGlass/index.js`). So the
   bar glass would fade out for about 300 ms after login.
   - Fix written, **uncommitted when paused, now in the WIP commit**: follow the adjustment only
     while `Main.overview.visible` (also listen to `showing` / `hidden`).
   - This relies on `overview.js` (GNOME 50) setting `_visible = true` before the open animation
     and `false` only in `_hideDone`.
2. **The scenario's "invisible" check was vacuous.** `tools/scenarios/mission-control-warm.sh`
   attached its watchers after the login warm-up had already run, so it saw 0 frames.
   - It now loads a fresh copy of `warm.js` under another file name and runs a second warm-up
     while watching (`warm-observed`, `warm-bar-glass-stays`). GJS has no `?query` imports.
   - This version has **not had a clean run yet**.
3. **One Shell segfault.** One run (`/tmp/claude-0/x2/runs/20261103-205314-guava-os-f44b`)
   crashed during the standard probe `quick-settings-columns`, about 23 s after the warm-up.
   - There were Clutter warnings at the warm-up: "Can't update stage views actor overviewGroup …
     needs an allocation".
   - It is the only segfault among the last 150 runs, so the link to the warm-up is unproven. I
     was re-running when paused.

**Before merging Q2 to `main`:**

1. Run `mission-control-warm` and the probes 3 or more times; they need 0 crashes.
2. If it crashes again, compare against `9a87632` (no warm-up).
3. Consider allocating the overview group before painting (the "needs an allocation" warnings).
4. Get `warm-observed` and `warm-bar-glass-stays` passing.
5. Take a screenshot mid-warm-up to show it is invisible.

### Q1: login (stopped, unreviewed WIP patch)

The patch makes `later` accept a function of ctx (`lib/featureRegistry.js isLater`). It marks
`move-window-to-new-workspace`, `green-button`, `popup-menu-styling` and `rounded-corners` as
`later`, and extends the probe's `startupTrace.js`.

There are no numbers yet. **Review risk:** `rounded-corners` and `popup-menu-styling` change what
is on screen at login, and `features.js` forbids `later` for those. They would appear late.

Earlier findings (in `docs/agents/learnings.md`):

- Ready is the first frame of the notch and the desktop icons, after startup-complete.
- The notch and desktop icons' first render is a stall of about 285 ms.
- Startup-complete is about 2.3 s, against stock's 1.5 s.
- Parsing is not the bound.

## Pick up

```sh
cd guava-os && git log --oneline -6          # top: the WIP commit for Q2's review fixes
make check
X2=/tmp/claude-0/x2 tools/scenarios/run-all.sh mission-control-warm   # repeat; watch for "Segmentation"
X2=/tmp/claude-0/x2 tools/scenarios/run-all.sh glass
# Q1: git apply docs/agents/resume/q1-login-wip.patch  (in a fresh worktree), review, measure
# Q3: cp docs/agents/resume/q3-burst-handlers.sh tools/scenarios/ ; re-measure burst first
# Final: one serial tools/scenarios/run-perf.sh, then update docs/testing/real-machine-checklist.md §4,
# then merge to main. Delete resume.md and docs/agents/resume/ when done.
```

Live memory: `/home/user/.swarm/guava-os/shared/board.md` (rows W5, B38–B41).
