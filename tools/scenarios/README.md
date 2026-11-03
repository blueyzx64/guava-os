# Scenarios

Harness scenarios (`GUAVA_EXTRA`, see `tools/harness/README.md`). Each lane adds its own files here.

## Perf suite (B11)

One command, PASS/FAIL per metric, exit 0 only when all pass:

```sh
X2=/tmp/claude-0/x2 tools/scenarios/run-perf.sh
```

| File | Role |
|---|---|
| `run-perf.sh` | Runs the unit level, then two harness runs in parallel (stock GNOME login, Guava login), then the comparison. |
| `perf-suite.sh` | The real-Shell scenario, run in both logins: idle, core interactions, burst, CPU overload. |
| `perf-compare.py` | Reads both runs' `STARTUP`/`IDLE`/`PERF`/`JITTER` lines and applies the thresholds below. |
| `tests/motionSmoothness.test.js` | Unit level: the motion contract of `core/motionModel.js`. |
| `tools/harness/probe/probe@x2/startupTrace.js` | The login trace: frames, main-loop stalls, startup signals, work area, chrome geometry, Guava's per-feature start times (`FeatureRegistry.timings()`). |

**Unit level** (pure, `tests/motionSmoothness.test.js`): curves end exactly, are monotonic and have no
jump; named durations are 600 ms or less and springs settle within 1.5 s; animations off, reduced
motion and the load rule (`decorative` requests under `env.degraded`); a retarget mid-flight keeps the
position and the velocity (spring and ease handover); the `FrameBudget` enters and leaves the degraded state with
hysteresis.

**Real Shell.** The harness renders on llvmpipe, so absolute frame times mean little. Each threshold
is relative to the stock GNOME baseline from the same suite run:

| Metric | Section | PASS when (G = Guava, S = stock) |
|---|---|---|
| `login.ready_ms` | Login: Shell start until startup-complete, every feature started and the chrome settled | G ≤ S.startupComplete + 600 |
| `login.stall_total_ms`, `login.max_stall_ms` | Main-loop stalls (10 ms heartbeat late by > 50 ms) during login | G ≤ 1.5·S + 300; G ≤ S + 250 |
| `login.chrome_jumps` | Panel, dock, notch, Stage Manager, desktop icons, widgets: moves/hides after first shown | 0 |
| `login.workarea_changes` | Struts applied late (windows resize) | G ≤ S |
| `login.overview_flash` | The login overview shown, then hidden (Mission Control "start on desktop") | no `hiding` (`hiding~` = hidden before it painted: not a flash) |
| `idle.paints`, `idle.wakeups_per_s`, `idle.cpu_ms` | 10 s idle (and 5 s after the overload ends): stage paints, main-thread context switches, CPU | paints ≤ S (0); wakeups ≤ 1.2·S + 5; CPU ≤ S + 100 ms |
| `overview`, `menu`, `drag` `.p95_ms`, `.max_stall_ms` | Core interactions at rest: overview open/close, Quick Settings open/close, window titlebar drag | p95 ≤ 1.3·S + 5; stall ≤ 1.3·S + 100 |
| same with `-load` | One busy loop per core (nice 0) | p95 ≤ 1.5·S + 10; stall ≤ 1.5·S + 100 |
| `drag*.jumps+reversals+flickers` | The dragged window, tracked per frame (`classify.js`) | ≤ S |
| `burst.max_stall_ms`, `burst.stalls50` | Six windows open and close, five overview toggles | ≤ 1.5·S + 100; ≤ 1.5·S + 3 |
| `guava_errors` | The Guava run's log | 0 |

`INFO degraded-under-load` shows whether Guava's `FrameBudget` reported `env.degraded` during the
overload. Graceful degradation: `core/motion.js` watches painted frame intervals. When 40 % of the last 30 frames
take more than 50 ms, `ctx.motion.env.degraded` turns true and `motion-changed` fires. Requests marked
`decorative: true` then become a crossfade, and features with costly ornaments drop them until it clears
(it clears when fewer than 10 % of the frames are slow). Core interactions never degrade.
