# perf-lib.sh: frame-timing and jitter probes. Bundle AFTER lib.sh and WITH classify.js:
#   bundle.sh OUT lib.sh perf-lib.sh classify.js scenario.sh
#
#   perf_start                   hook stage after-paint + a 10 ms main-loop heartbeat
#   perf_stop LABEL              PERF LABEL frames=N mean=..ms p95=..ms max=..ms over16=N over33=N stalls50=N maxStall=..ms
#   track_actor JS_EXPR LABEL    sample the actor on every painted frame (JS_EXPR is evaluated per frame, may be null)
#   track_stop                   JITTER LABEL samples=N jumps=N reversals=N flickers=N   (+ detail={frame indexes} when non-zero)
#                                raw samples: shots/LABEL.samples.csv in the run dir
# The harness renders in software (llvmpipe): absolute numbers are pessimistic. Compare against the
# GNOME baseline (perf-example.sh prints one), not against 60 fps.

_kperf_clean() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' _; }

perf_start() {
  _kjs '
if (globalThis.__kperf) { try { global.stage.disconnect(globalThis.__kperf.id); } catch (e) {} GLib.source_remove(globalThis.__kperf.hb); }
const st = {ts: [], stalls: 0, maxStall: 0, id: 0, hb: 0};
const cb = () => st.ts.push(GLib.get_monotonic_time());
try { st.id = global.stage.connect("after-paint", cb); } catch (e) { st.id = global.stage.connect("after-update", cb); }
let exp = GLib.get_monotonic_time() + 10000;
st.hb = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
  const n = GLib.get_monotonic_time(), late = (n - exp) / 1000;
  if (late > 50) st.stalls++;
  if (late > st.maxStall) st.maxStall = late;
  exp = n + 10000; return GLib.SOURCE_CONTINUE; });
globalThis.__kperf = st;
global.stage.queue_redraw();
return "ok";' >/dev/null
  echo "PERF_START"
}

# Frame intervals longer than 500 ms are idle gaps (nothing was animating), not hiccups: they are left
# out of mean/p95/max/over*. A real 500 ms freeze still shows up in stalls50/maxStall.
perf_stop() {
  local label r; label=$(_kperf_clean "${1:-run}")
  r=$(_kjs '
const st = globalThis.__kperf; if (!st) return "PERF '"$label"' NOT_STARTED";
global.stage.disconnect(st.id); GLib.source_remove(st.hb); globalThis.__kperf = null;
const iv = []; for (let i = 1; i < st.ts.length; i++) { const d = (st.ts[i] - st.ts[i-1]) / 1000; if (d <= 500) iv.push(d); }
const s = [...iv].sort((a, b) => a - b);
const mean = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : 0;
const p95 = s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : 0;
const f = v => v.toFixed(1);
return "PERF '"$label"' frames=" + st.ts.length + " mean=" + f(mean) + "ms p95=" + f(p95) + "ms max=" + f(s.length ? s[s.length-1] : 0) + "ms over16=" + iv.filter(d => d > 16.7).length + " over33=" + iv.filter(d => d > 33).length + " stalls50=" + st.stalls + " maxStall=" + f(st.maxStall) + "ms";')
  printf '%s\n' "$r" | grep -o "PERF [^'\"]*" | head -1 || echo "PERF $label FAIL $r"
}

# track_actor JS_EXPR LABEL: JS_EXPR is an expression evaluated on every frame, e.g.
#   track_actor "inst('spotlight')._modal?.frame" spotlight-open
# Track one animation per series (open, then close separately): a fade in plus a fade out is not jitter.
track_actor() {
  local expr=$1 label; label=$(_kperf_clean "${2:-actor}")
  _kjs '
if (globalThis.__ktrack) { try { global.stage.disconnect(globalThis.__ktrack.id); } catch (e) {} }
const f = () => ('"$expr"');
const st = {label: "'"$label"'", samples: [], id: 0, t0: GLib.get_monotonic_time(), err: null};
const rec = () => { let a = null; try { a = f(); } catch (e) { st.err = String(e); }
  const t = (GLib.get_monotonic_time() - st.t0) / 1000;
  if (!a) { st.samples.push({t, x: 0, y: 0, w: 0, h: 0, op: 0, sx: 1, sy: 1, vis: false}); return; }
  const [x, y] = a.get_transformed_position(), [w, h] = a.get_transformed_size();
  let vis = false; try { vis = a.get_paint_visibility(); } catch (e) { vis = a.visible; }
  let op = a.opacity; try { op = a.get_paint_opacity(); } catch (e) {}
  st.samples.push({t, x, y, w, h, op, sx: a.scale_x, sy: a.scale_y, vis}); };
try { st.id = global.stage.connect("after-paint", rec); } catch (e) { st.id = global.stage.connect("after-update", rec); }
st.rec = rec; rec();
globalThis.__ktrack = st;
global.stage.queue_redraw();
return "ok";' >/dev/null
  echo "TRACK_START $label"
}

track_stop() {
  [ -n "${_K_CLASSIFY_JS:-}" ] || { echo "JITTER FAIL classify.js not bundled (bundle.sh OUT lib.sh perf-lib.sh classify.js ...)"; return 1; }
  printf '%s\n' "$_K_CLASSIFY_JS" > "$W/kclassify.js"
  local r
  r=$(_kjs '
const st = globalThis.__ktrack; if (!st) return "JITTER none NOT_STARTED";
st.rec(); global.stage.disconnect(st.id); globalThis.__ktrack = null;
const src = new TextDecoder().decode(GLib.file_get_contents("'"$W"'/kclassify.js")[1]);
const c = new Function(src + "; return guavaClassify;")()(st.samples);
const NL = String.fromCharCode(10);
const csv = "t_ms,x,y,w,h,opacity,sx,sy,vis" + NL + st.samples.map(s => [s.t.toFixed(2), s.x.toFixed(2), s.y.toFixed(2), s.w.toFixed(2), s.h.toFixed(2), s.op, s.sx.toFixed(4), s.sy.toFixed(4), s.vis ? 1 : 0].join(",")).join(NL) + NL;
Gio.File.new_for_path("/opt/shots/" + st.label + ".samples.csv").replace_contents(csv, null, false, Gio.FileCreateFlags.NONE, null);
let out = "JITTER " + st.label + " samples=" + c.samples + " jumps=" + c.jumps + " reversals=" + c.reversals + " flickers=" + c.flickers;
if (st.err) out += " exprError=" + st.err.split(" ").join("_").slice(0, 80);
if (c.jumps + c.reversals + c.flickers) out += " detail=" + JSON.stringify(c.detail).split(String.fromCharCode(34)).join("");
return out;')
  printf '%s\n' "$r" | grep -o "JITTER [^'\"]*" | head -1 || echo "JITTER FAIL $r"
}
