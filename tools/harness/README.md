# Real GNOME Shell test harness

Guava is tested in a real GNOME Shell 50.6 (Fedora 44 packages), headless, inside chroot test roots. A run:
- starts the Shell on a 1280x800 virtual monitor;
- opens real apps;
- enables Guava;
- runs the standard probes and your scenario, driven by a virtual pointer and keyboard;
- toggles Guava off and on N times;
- reports every Guava error from the Shell log.

Screenshots and logs land in a run folder.

It needs a Linux host where you are root: it uses chroot, mounts and a private `/dev` per root. It renders in software (llvmpipe), so timings are pessimistic; compare them against the stock baseline you record in the same run.

## Files
| File | What it does |
|---|---|
| `build-f44-root.sh` | Builds test roots from the Fedora 44 container image plus the packages the probes use. |
| `run-f44.sh` | Picks a free root and runs one test. Runs queue when all roots are busy. |
| `run-real.sh` | Copies Guava into the root, runs `inner-real.sh`, and summarises Guava errors. Writes the run folder. |
| `inner-real.sh` | Runs inside the root. Starts the session (D-Bus, PipeWire, Shell), the apps, the standard probes, your scenario, and the enable/disable cycles. |
| `enter.sh` | Enters a root with private `/proc`, `/sys`, `/dev` and `/tmp` mounts. |
| `killroot.sh`, `safe-rm.sh` | Stop everything in a root; unmount and delete a root safely. |
| `probe/probe@x2` | A tiny helper extension that evaluates JS in the Shell for the probes. |
| `lib/` | The scenario library. `lib.sh`: launch, focus, click, drag, keys, wait, assert, screenshots. `pre-lib.sh`: D-Bus mocks for NM, BlueZ, UPower, PPD, polkit; fixtures; PipeWire sinks. `perf-lib.sh` + `classify.js`: frame time, stalls, jitter. `bundle.sh`. Examples. See `lib/README.md`. |

## Setup (once)
```sh
sudo X2=/tmp/x2 tools/harness/build-f44-root.sh f44 4   # 4 roots for parallel runs (up to 8)
```
- `X2` (default `/tmp/x2`) holds the roots, locks and `runs/`.
- Behind a TLS-intercepting proxy, also pass `CA_BUNDLE=/path/to/ca.pem` and `HTTPS_PROXY`.
- A root is about 2 GB. Delete one with `safe-rm.sh $X2/f44`.

## Run
```sh
GUAVA_SRC=$PWD tools/harness/run-f44.sh 20       # standard probes + 20 enable/disable cycles
```
- It prints `PROBE PASS|FAIL …`, `== SUMMARY Guava errors: N` and `RUN DIR: $X2/runs/<time>-<name>-<root>`. That folder holds `last-run.txt`, `shell.log` and `shots/*.png`.
- **The bar to pass:** 0 Guava errors and every probe passing. A run marked INVALID means the Shell never started; re-run once.
- **Options:**
  - `GUAVA_EXTRA=file`: your scenario.
  - `GUAVA_PRE=file`: setup before the Shell starts (mocks).
  - `GUAVA_ONLY="notch spotlight"`: enable only these feature switches.
  - `run-f44.sh 0`: no cycles.

## Write a scenario
Scenarios are bash, run inside the session. They can't see your home folder, so bundle the library with your script first:
```sh
K=tools/harness/lib; S=$(mktemp -d)
cat > $S/s.sh <<'EOF'
launch_app "gnome-text-editor" org.gnome.TextEditor 40
drag 640 300 640 2                       # real pointer drag, 24 steps
perf_start; key super+a; sleep 1; key Escape; perf_stop launchpad
assert launchpad-closed "!inst('launchpad')?.isOpen"
shot after
assert_summary
EOF
$K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js $S/s.sh
GUAVA_SRC=$PWD GUAVA_EXTRA=$S/extra.sh tools/harness/run-f44.sh 0
```
- **Available in a scenario:**
  - `P '<js>'` evaluates async JS in the Shell. `Main`, `St`, `Clutter`, `Meta`, `Gio`, `GLib` and `Shell` are in scope.
  - `inst('<feature-id>')` is a running Guava feature.
  - `kwin('<wm_class>')` is a mapped window.
  - `gs key value` sets a Guava setting.
- **Measure smoothness:** use `perf_start`/`perf_stop` and `track_actor`/`track_stop`. They print `PERF` and `JITTER` lines.
- **What counts as smooth:** 0 jumps, 0 reversals (one settling spring overshoot is fine) and 0 flickers. p95 should be no worse than a stock overview open/close measured in the same run.
- **Warm-up:** warm up an animation once first; the first frame pays about 290 ms of shader setup.
- **gdbus gotcha:** gdbus expands `\n` and `\s` in the JS you pass, so use `String.fromCharCode(10)`.

## Limits
- Software rendering only, one monitor and no GPU timings.
- No real lock screen.
- Touchpad gestures can't be generated.
- Xwayland is off in the standard run. Copy `run-real.sh` and drop `--no-x11` to test X11 apps.
