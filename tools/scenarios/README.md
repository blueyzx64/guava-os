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
| `perf-latency.sh` | D-021 response latency: `lat_all` drives real virtual input (Super tap, Ctrl+Up, Super+A, Super+Tab, panel clicks, menu-bar click, dock click, notch hover, titlebar press + move) and times input to the first stage `after-paint` where the response is visible. Prints `LAT label n= miss= min= median= p95= max=`. |
| `latency-cold.sh`, `latency-coldprobe.sh`, `overview-bisect.sh` | Investigation scenarios (L19): cold first opens (Notification Center, notch hover, Mission Control), sync vs first-paint time of a first open (`WARM=1` tries a full, visible warm-up: flickers the dock), and the overview / burst frame cost with each feature switched off in turn (`BISECT="dock notch"` picks the features). Not part of the suite. |
| `mission-control-warm.sh` | Q2 (B39): the invisible first-open warm-up of Mission Control (`missionControl/warm.js`): it ran, was invisible, emitted no `showing`/`hidden`, left nothing behind, and the first real open paints in < 250 ms. |
| `burst-handlers.sh`, `burst-handlers-profile.patch` | Investigation (Q3, B40): the suite's burst repeated in one login, per feature off (`BISECT`), and with the profiling patch applied locally (never committed into src) a per-handler time table. Env vars do not reach the chroot: prepend them to the bundled file. Not part of the suite. |
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
| `latency.<action>.p95_ms` | Response latency (D-021), 5 reps per action at rest, real input to first painted response frame | p95 ≤ 250 ms absolute and no miss (llvmpipe: pessimistic; stock's value is printed where stock has the action) |
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

`INFO degraded-under-load` counts how often Guava's `FrameBudget` reported `env.degraded` during the
overload (`b28.degraded_under_load` fails at 0). Live glass blur recaptures at most every 80 ms (500 ms while degraded). Graceful degradation: `core/motion.js` watches painted frame intervals. When 20 % of the last 30 frames
take more than 50 ms, `ctx.motion.env.degraded` turns true and `motion-changed` fires. Requests marked
`decorative: true` then become a crossfade, and features with costly ornaments drop them until it clears
(it clears when fewer than 10 % of the frames are slow). Core interactions never degrade.

## Login parse cost (B34)

| File | Role |
|---|---|
| `parse-cost.js` | `gjs -m tools/scenarios/parse-cost.js [--top N] [--graph entry.js ...]`: SpiderMonkey syntax-parse time per module (host, idle). All 2.7 MB of the extension parse in ~50 ms: syntax is not the login cost. |
| `login-modules.sh` | Real Shell: import cost of 76 pure model modules (re-import with `?query`), ~0.17 ms per KB (file read + compile + evaluate). The login path is ~1.5 MB, so ~250 ms. |

The login trace summary has `stallAt` (`ms@time`) to place each main-loop stall.

## Login first frame (B38)

Guava paints no frame before startup-complete (its enable chain keeps the main loop busy; stock paints
its panel ~0.5 s earlier), so `login.ready` = the enable chain + ONE heavy first frame with all the
chrome. In the harness that frame is dominated by cold shader compiles (llvmpipe JIT): ready minus
stock's startup-complete is 700-800 ms cold and 330-380 ms with a warm shader cache, which is what a
user's second login has. `GUAVA_MESA_SEED=$X2/mesa-seed` (built once by `tools/harness/seed-mesa.sh`)
starts a run, stock or Guava, from the same warm cache. The login trace summary also carries
`cpu` (main-thread CPU ms at the first frames), `featureRows` (id, loaded, started, enable ms),
`phases` (frame signals of the first 2 s) and, with `GUAVA_PRE="export GUAVA_TRACE_TASKS=1"`, `tasks`
(idle/timeout callbacks over 12 ms with the stack that registered them).
