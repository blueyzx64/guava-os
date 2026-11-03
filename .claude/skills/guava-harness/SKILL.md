---
name: guava-harness
description: Run and extend Guava OS's real GNOME Shell 50.6 test harness (Fedora 44 chroot roots under X2=/tmp/claude-0/x2). Use to verify a change in the real Shell, write a GUAVA_EXTRA scenario, probe Shell JS with P '<js>', take screenshots, measure frame times and jitter (perf_start, track_actor), read last-run.txt / shell.log, count "Guava errors", spike an API before coding, or introspect Mutter/Shell typelibs with gjs inside a root.
---

# The real-Shell harness

Canonical docs: `tools/harness/README.md`, `tools/harness/lib/README.md`. Scripts:
`tools/harness/run-f44.sh` → `run-real.sh` (host) → `inner-real.sh` (inside the root).

## 1. Run

```sh
cd <your worktree>
GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 tools/harness/run-f44.sh 3      # probes + 3 disable/enable cycles
```
- Picks a free root among `$X2/f44 f44b … f44h` (flock `pick-<root>.lock`); **queues** (sleep 5
  loop) when all are busy. Six leads share 4 roots: batch your checks into one run, use
  `run_in_background`, never poll with sleep.
- Hard timeout 600 s per run (`run-real.sh`, `timeout -k 5 600`); the session itself 400 s.
- stdout shows only the `== SUMMARY Guava errors: N` block, `PROBE PASS|FAIL` lines and
  `RUN DIR: $X2/runs/<ts>-<srcdir>-<root>`. **Your scenario's output is only in
  `$RUN_DIR/last-run.txt`**; also `shell.log`, `shots/*.png`.
- Pass bar: `Guava errors: 0` and every PROBE PASS. "INVALID RUN" = Shell never started: rerun once.
- Error count = CRITICAL / JS ERROR blocks whose stack has a `guava-os@blueyzx64/` frame or a
  `[Guava]` message (python in `run-real.sh`). `Gjs-WARNING` lines (e.g. unhandled promise
  rejections) are **not** counted: grep `shell.log` for them yourself.
- Only these are copied into the root: the repo **minus** `.git docs tests po tools`.

## 2. Scenario (GUAVA_EXTRA)

```sh
K=tools/harness/lib; S=<scratch dir>
cat > $S/s.sh <<'EOF'
force_animations on                       # REQUIRED for anything animated, see §4
launch_app "gnome-text-editor" org.gnome.TextEditor 40
P "$SL"'const d=inst("dock"); await sl(300); return JSON.stringify({ok:!!d})'
assert dock-up "!!inst('dock')"
perf_start; key super+a; sleep 1; key Escape; perf_stop launchpad
shot after
assert_summary
EOF
$K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js $S/s.sh
GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 GUAVA_EXTRA=$S/extra.sh tools/harness/run-f44.sh 0
grep -A40 '== EXTRA' /tmp/claude-0/x2/runs/<run>/last-run.txt
```
In scope inside a scenario: `P`, `T name js`, `$SL`, `gs key value`, `$W` (=/tmp/w),
`$W/shell.log` (live log), `$WD` (Wayland display), plus `lib.sh` helpers (`launch_app`,
`focus_app`, `click_at`, `click_actor`, `drag`, `key`, `wait_for`, `assert`, `assert_summary`,
`shot`, `force_animations`) and `perf-lib.sh` (`perf_start/stop`, `track_actor/stop`).

`P '<js>'` gotchas (verified 2026-11-03):
- The body runs as an **async function** with `Main St Clutter Meta Gio GLib Shell` in scope;
  return a value (it comes back as a GVariant tuple string `('"..."',)`).
- **`P` does not include `sl`/`inst`/`reg`.** Prefix `"$SL"'...'` (as `T` does). `$SL` declares
  `const sl, reg, inst`: declaring your own `reg` → `SyntaxError: redeclaration of const reg`.
- `lib.sh` helpers (`assert`, `wait_for`) already prefix `sl/inst/kwin`.
- gdbus mangles `\n`/`\s` in the JS: use `String.fromCharCode(10)`; keep quotes single inside.
- `JSON.stringify` your result; return strings containing PASS/FAIL for `T`.
- Probe extension: `tools/harness/probe/probe@x2` (`org.x2.Probe.Eval`).

`tools/harness/lib/README.md` still mentions `/home/user/guava-swarm-tools` and `/tmp/x2`:
the library is `tools/harness/lib/`, X2 is `/tmp/claude-0/x2`.

## 3. Reading Guava from a probe

- Registry: `Main.extensionManager.lookup('guava-os@blueyzx64').stateObj._features`;
  `inst(id)` = `reg._state.get(id)?.instance`; `reg.status(id)` = active|paused|loading|off.
- Wait for every lazy feature: `await ext.stateObj._features.settled()`.
- Default run turns on `notch liquid-glass control-center stage-manager clipboard-history
  spotlight …` (`inner-real.sh` `ALL`); `GUAVA_ONLY="notch dock"` turns those off except the list.
- Windows present at probe time: Text Editor (`org.gnome.TextEditor`) and a GTK4 test app
  (`org.x2.TestB`, from `$W/x2app.js`). Stage Manager hides one of them (opacity 0).
- Mock system services (NM, BlueZ, UPower, PPD, polkit), PipeWire sinks: `GUAVA_PRE` with
  `pre-lib.sh` `pre_all` (`tools/harness/lib/README.md` "Pre library").

## 4. Environment facts that change results

- Software rendering (llvmpipe) ⇒ the Shell **inhibits animations** at start
  (`ui/main.js:1027-1056`): `St.Settings.get().enable_animations === false`, every `ease()`
  completes instantly, Genie never runs. Call `force_animations on` first (it uninhibits).
- 1280×800 virtual monitor, scale 1, one monitor, `MetaBackendNative` headless, no Xwayland
  (`--no-x11`), no GPU timings, no real lock screen, no touchpad gestures.
- `org.gnome.desktop.a11y.interface reduced-motion` exists ('no-preference'); `St.Settings`
  has no `reduced_motion` on 50.
- First frame of a new shader/offscreen costs ~290 ms: warm up once before `perf_start`.
- Frame times are 2–3× worse than real hardware; compare against the stock overview baseline in
  the same run (`lib/perf-example.sh`). Trust jitter counts (jumps/reversals/flickers) more.

## 5. Perf and jitter

`perf_start` hooks stage `after-paint` + a 10 ms heartbeat; `perf_stop LABEL` prints
`PERF label frames mean p95 max over16 over33 stalls50 maxStall`. `track_actor 'JS' LABEL` samples
x,y,w,h,opacity,scale per painted frame (CSV in `shots/<label>.samples.csv`); `track_stop` prints
`JITTER label samples jumps reversals flickers`. Smooth = 0/0/0 (one settling spring overshoot ≤35% ok).
Track one direction per series. Thresholds: `tools/harness/lib/README.md` §Performance.
Startup cost: time `ext.stateObj.disable()` / `await ext.stateObj.enable()` /
`await _features.settled()` with `GLib.get_monotonic_time()` (bypasses the extension manager;
state stays ACTIVE). Baseline 2026-11-03 (llvmpipe, all default features): disable 233–270 ms
(one synchronous main-loop block), enable 3–5 ms sync, all features settled 274–556 ms.

## 6. gjs introspection inside a root (API spikes without a Shell)

```sh
cat > /tmp/claude-0/x2/f44d/opt/my.js <<'EOF'      # NOT the root's /tmp: enter.sh mounts a tmpfs there
imports.gi.versions.Meta='18'; const Meta=imports.gi.Meta;
print(Object.getOwnPropertyNames(Meta.Window.prototype).filter(n=>/maxim/.test(n)));
EOF
/tmp/claude-0/x2/f44d.enter.sh /usr/bin/env GI_TYPELIB_PATH=/usr/lib64/mutter-18:/usr/lib64/gnome-shell \
  LD_LIBRARY_PATH=/usr/lib64/mutter-18:/usr/lib64/gnome-shell gjs /opt/my.js
```
Signals: `GObject.signal_list_ids(T.$gtype).map(GObject.signal_name)`; props:
`GObject.Object.list_properties.call(T)`. A full dump for 50.6 is at
`/home/user/.swarm/guava-os/agents/R1/introspect-50.txt`. Do not enter a root another run is
using if you can avoid it: `killroot.sh` at the end of that run kills processes in the root.

## 7. Rules

- Never edit `$X2/*.sh` or the roots; never commit screenshots.
- Unique scenario/shot names per run. A scenario that changes settings should restore them.
- A failing probe you did not touch: rerun once, then compare with the baseline run of
  `main` (`ls -t $X2/runs`), then ASK O.
