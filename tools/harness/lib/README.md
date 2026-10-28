# guava-swarm-tools

Shared bash helpers for Guava scenario scripts that run in the real GNOME Shell harness
(`/tmp/x2/run-f44.sh`, Fedora 44 / GNOME Shell 50.6, headless, 1280x800 virtual monitor).

| File | What it is |
|---|---|
| `lib.sh` | Shell-side helpers: `launch_app`, `focus_app`, `click_at`, `click_actor`, `drag`, `key`, `wait_for`, `assert`, `assert_summary`, `shot`, `force_animations`. |
| `pre-lib.sh` | Mocks that run before the Shell starts: private system bus, dbusmock NM/BlueZ/UPower/PPD/polkit, mock fixtures, PipeWire null sinks, Nautilus getuid shim. Entry point `pre_all`. |
| `bundle.sh` | Joins library and scenario files into one script (see "Why bundle"). |
| `pre-example.sh` | Example pre script: calls `pre_all`. |
| `perf-lib.sh` | Performance and jitter probes: `perf_start`, `perf_stop`, `track_actor`, `track_stop` (see "Performance and jitter"). |
| `classify.js` | Pure jump, reversal and flicker classifier. Embedded by `bundle.sh`; tested by `test-classify.js`. |
| `test-classify.js` | Unit tests: `node test-classify.js` or `gjs test-classify.js`. |
| `perf-example.sh` | Spotlight open/close and stock overview baseline, with perf and tracking. |
| `example.sh` | Example scenario: launch Text Editor, assert its window exists, take a screenshot. |

## Why bundle

The harness copies one file into the chroot (`/opt/guava-extra.sh`, `/opt/guava-pre.sh`). `/home/user`
is not visible there, so a scenario cannot `source lib.sh` by path. Bundle first, then pass the bundle:

```sh
S=$PWD/out                       # a scratch dir, not the repo
K=/home/user/guava-swarm-tools
mkdir -p $S
$K/bundle.sh $S/pre.sh   $K/pre-lib.sh $K/pre-example.sh   # GUAVA_PRE: mocks
$K/bundle.sh $S/extra.sh $K/lib.sh     $K/example.sh       # GUAVA_EXTRA: scenario
GUAVA_SRC=/home/user/guava-os GUAVA_PRE=$S/pre.sh GUAVA_EXTRA=$S/extra.sh \
  /tmp/x2/run-f44.sh 0
```

`run-f44.sh 0` skips the enable/disable cycles. Use `N` (for example `2`) to add them.
The run prints `RUN DIR: /tmp/x2/runs/<ts>-...`. Results are in `last-run.txt` in that dir,
and screenshots are in `shots/`.

Scenario scripts run after the standard probes, in the same shell. These are available:
`P 'js'` (evaluate JS in the Shell), `$W` (`/tmp/w`), `$WD` (Wayland display), `$HOME`, and `gs key value`
(set a Guava gsetting). Do not use the harness's `SHOT` and `SL`. The library has its own
versions, so it does not depend on them.

## Library reference (`lib.sh`)

Each function prints one greppable line. Shell-side work is done with JS run via `P`.
The JS body is prefixed with `sl(ms)`, `inst(id)` (a running Guava feature), `kwin(wm_class)`
(first mapped normal window of that class), and a virtual pointer and keyboard.

| Function | Use | Output |
|---|---|---|
| `launch_app CMD WM_CLASS [TIMEOUT_S=40]` | Start `CMD` (a shell command line) and wait for a mapped window with that wm_class (case-insensitive). Logs go to `$W/app-<class>.log`. | `LAUNCH OK cls after Ns` or `LAUNCH FAIL`, with the log tail |
| `focus_app WM_CLASS` | Activate that window and check that it has focus. | `FOCUS OK` or `FOCUS FAIL` |
| `click_at X Y` | Virtual-pointer click at stage coordinates. | `CLICK x,y` |
| `click_actor "JS_EXPR"` | JS_EXPR returns an actor. Click its centre. | `CLICK x,y`, `NOACTOR`, or `CLICK FAIL` |
| `drag X1 Y1 X2 Y2` | Press, move in 24 steps, release. | `DRAG x1,y1->x2,y2` |
| `key COMBO` | Virtual keyboard. `key super+d`, `key ctrl+alt+t`, `key Escape`. Modifiers: super, ctrl, alt, shift. Other names are Clutter `KEY_*` names. | `KEY combo` |
| `wait_for "JS_EXPR" [TIMEOUT_S=10]` | Poll until JS_EXPR is truthy. | `WAIT OK ...` or `WAIT TIMEOUT` (returns 1) |
| `assert NAME "JS_EXPR"` | Truthy is PASS. Counts go to `GUAVA_ASSERT_PASS` and `GUAVA_ASSERT_FAIL`. | `ASSERT PASS|FAIL NAME DETAIL` (returns 0/1) |
| `assert_summary` | Totals. Call it last. | `ASSERT SUMMARY pass=N fail=M` |
| `shot NAME` | Full-screen PNG. | `SHOT NAME -> shots/NAME.png` |
| `force_animations on\|off` | Sets `org.gnome.desktop.interface enable-animations`. For `on`, also uninhibits St animations. Reads the value back. | `ANIMATIONS on\|off: enable_animations=<bool>` |

Notes:
- JS_EXPR is an expression, not statements. `assert` wraps it as `const __v=(EXPR)`. `wait_for` wraps it as `return !!(EXPR)`.
  Quote it with double quotes, and use single quotes inside it.
- `click_at` and `click_actor` do a priming move before the press: the pointer moves onto the target, wiggles
  1px, and moves back. This creates a pointer-enter so the first press is not dropped. They do not send a
  priming button event, because a press on an unknown spot would fire an action.
- `launch_app` and `focus_app` match the window by `get_wm_class()`. Use the class from `xprop` or the
  `desc` output of a previous run if the app's class is not obvious.
- `launch_app` closes fd 9 for the child process. The harness holds its lock on fd 9.
- Keep scenario names unique within a run. Screenshot and log names come from them.

## Performance and jitter (`perf-lib.sh`, `classify.js`)

Bundle with the classifier (a `.js` file is embedded as `$_K_<NAME>_JS`, since `/home/user` is not visible in the chroot):

```sh
$K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js $K/my-scenario.sh
```

| Function | Output |
|---|---|
| `perf_start` | Hooks `global.stage` `after-paint` (falls back to `after-update`) and a 10 ms main-loop heartbeat. `PERF_START` |
| `perf_stop LABEL` | `PERF <label> frames=N mean=..ms p95=..ms max=..ms over16=N over33=N stalls50=N maxStall=..ms` |
| `track_actor JS_EXPR LABEL` | Samples the actor on every painted frame. JS_EXPR is re-evaluated each frame, so it may be null at first (`inst('spotlight')?._modal?.frame`). `TRACK_START <label>` |
| `track_stop` | `JITTER <label> samples=N jumps=N reversals=N flickers=N` (plus ` detail={frame indexes}` when non-zero). Raw samples go to `shots/<label>.samples.csv` in the run dir (`t_ms,x,y,w,h,opacity,sx,sy,vis`). |

How to read the numbers:
- Frame stats only cover frames that were painted. Gaps over 500 ms are idle time (nothing animating) and are left out of mean/p95/max/over*. Real freezes show in `stalls50` (heartbeat later than 50 ms) and `maxStall`.
- `frames` includes the first slow frame of an animation (shader or texture setup). Do a warm-up open/close first (see `perf-example.sh`).
- Track one animation per series: call `track_actor`/`track_stop` for the open and again for the close. A fade in followed by a fade out reads as a reversal.
- Jump: a step over 3x the median step of its channel (position, size, scale, opacity), above a floor (2 px, 0.02 scale, 20 opacity), and more than 1.5x the larger neighbouring step, so a normal strong ease-out is not flagged. Needs 5 moving steps. A jump usually sits next to a slow frame: check `t_ms` in the csv. Geometry uses only frames where the actor is painted.
- Reversal: direction change on x, y, w, h, opacity or scale (hysteresis 0.5 px / 2 / 0.005). One overshoot that settles (return leg at most 35% of the first leg) is allowed; everything else counts.
- Flicker: visibility, or an opacity step of 64+ that is undone, within 2 frames.
- **llvmpipe warning.** The harness renders in software. Frame intervals here are 2-3x worse than on real hardware, so absolute numbers are pessimistic. Compare a feature against the stock-GNOME baseline from the same run (`perf-example.sh` runs a stock overview open/close), and treat jitter counts (jumps, reversals, flickers) as more trustworthy than frame times.
- Needs `force_animations on` for animated features, or the open/close has no motion.

Run the classifier tests: `node test-classify.js` (or `gjs test-classify.js`).

## Pre library (`pre-lib.sh`)

`pre_all` runs, in order:

| Function | What it does |
|---|---|
| `pre_bus` | Starts a permissive private system bus at `$W/sysbus` and exports `DBUS_SYSTEM_BUS_ADDRESS`. Starts `/opt/fake-logind.js` on it when present. |
| `pre_services` | dbusmock on that bus: `networkmanager`, `bluez5`, `upower`, `upower_power_profiles_daemon`, `polkitd`. Waits for each name. |
| `pre_mock_state` | Fixtures: a connected Wi-Fi link with three APs, a paired and connected BT headset, a paired keyboard, a nearby phone, a 60 % discharging battery, and polkit that allows everything. |
| `pre_audio` | PipeWire null sinks `guava-speakers` and `guava-headphones`, and a virtual mic `guava-mic`, with WirePlumber and pipewire-pulse. |
| `pre_uid_shim` | Writes `$W/uid.so` (embedded). Use it as `env LD_PRELOAD=$W/uid.so nautilus ...` so Nautilus accepts running as uid 1000. |

Not included: session-bus mocks (gsd_rfkill, `org.gnome.SettingsDaemon.Power` keyboard backlight). Those
need a session bus, and the harness starts its own with `dbus-run-session` after pre runs. Add them from a
scenario with `Gio` or `gdbus`, or in a separate pre that runs later, if a scenario needs them.

## Adding a function

Keep `lib.sh` to Shell-side helpers. Put each new Shell-side expression in `_kjs "BODY"`, where BODY is async
JS that returns a value, and return a value that the caller can grep. Keep detection on a substring.
Check your JS with `node --check` on an async-function wrapper before a real run. The harness queue is
shared, so batch scenarios into fewer runs.

## Changing the harness

Do not edit `/tmp/x2/*.sh` or the roots. Tools here only read and bundle.
