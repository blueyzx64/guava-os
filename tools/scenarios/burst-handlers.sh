# NOTE: env vars do not reach the chroot: prepend `BISECT=...; REPS=...;` lines to the bundled OUT file (or ext-off in BISECT = whole extension disabled).
# burst-handlers.sh: B40. The perf suite's burst (six windows open and close, overview spam) repeated
# REPS times (default 3) in one Guava login (a warm-up first): one PERF line per rep; BISECT="f1 f2" repeats it with each feature off. When the Shell has globalThis.__gprof
# (a local profiling patch of CleanupRegistry.connect), the per-handler table follows each rep (PROF lines).
# The profiling patch (tools/scenarios/burst-handlers-profile.patch, apply with `patch -p1`, never commit) times every cleanup.connect / events.on / idle / timeout handler into globalThis.__gprof.
# Bundle and run:
#   K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/burst-handlers.sh
#   GUAVA_SKIP_PROBES=1 GUAVA_EXTRA=OUT GUAVA_SRC=$PWD X2=... tools/harness/run-f44.sh 0
force_animations on >/dev/null
P "Main.overview.hide(); global.get_window_actors().forEach(a=>a.meta_window.delete(global.get_current_time())); return 1" >/dev/null
sleep 8
cat >$W/kperfwin.js <<'JSA'
imports.gi.versions.Gtk='4.0';
const {Gtk,Gio}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.Perf',flags:Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate',()=>{const w=new Gtk.ApplicationWindow({application:app,title:'perf',default_width:480,default_height:320});w.set_child(new Gtk.Label({label:'p'}));w.present();});
app.run([]);
JSA
_win() { (WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/kperfwin.js >/dev/null 2>&1 9>&- &); }
_win
wait_for "global.get_window_actors().some(a=>a.meta_window.get_wm_class()==='org.x2.Perf')" 40 >/dev/null
sleep 1
_burst() { # label
  P "globalThis.__gprof && globalThis.__gprof.reset(); return 1" >/dev/null
  perf_start
  for _ in 1 2 3 4 5 6; do _win; done
  wait_for "global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==='org.x2.Perf').length>=7" 40 >/dev/null
  P "global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==='org.x2.Perf').slice(1).forEach(a=>a.meta_window.delete(global.get_current_time())); return 1" >/dev/null
  sleep 2
  for _ in 1 2 3 4 5; do P "Main.overview.toggle(); return 1" >/dev/null; sleep 0.25; done
  P "Main.overview.hide(); return 1" >/dev/null; sleep 1.5
  perf_stop "$1"
  P "return globalThis.__gprof ? globalThis.__gprof.table() : 'noprof'" | sed "s/^/PROF $1 /"
  sleep 3
}
_burst warm
for rep in $(seq 1 "${REPS:-3}"); do _burst "all-on-$rep"; done
# BISECT="dock stage-manager": the same burst with each feature switched off in turn (gs = feature switch)
# a "+" joins features switched off together: BISECT="dock+notch stage-manager"
for f in ${BISECT:-}; do
  if [ "$f" = ext-off ]; then   # the whole extension disabled: the noise floor of this machine right now
    P "Main.extensionManager.disableExtension('guava-os@blueyzx64'); return 1" >/dev/null; sleep 4
    for rep in $(seq 1 "${REPS:-3}"); do _burst "no-extension-$rep"; done
    P "Main.extensionManager.enableExtension('guava-os@blueyzx64'); return 1" >/dev/null; sleep 6
    continue
  fi
  for one in ${f//+/ }; do gs "$one" false >/dev/null 2>&1; done; sleep 2
  for rep in $(seq 1 "${REPS:-3}"); do _burst "no-$f-$rep"; done
  for one in ${f//+/ }; do gs "$one" true >/dev/null 2>&1; done; sleep 3
done
# SETS="key=value=restore ...": the same with a Guava setting changed (e.g. glass-reduce-transparency=true=false)
for kv in ${SETS:-}; do
  k=${kv%%=*}; r=${kv#*=}; v=${r%%=*}; back=${r#*=}
  gs "$k" "$v" >/dev/null 2>&1; sleep 2
  for rep in $(seq 1 "${REPS:-3}"); do _burst "set-$k-$rep"; done
  gs "$k" "$back" >/dev/null 2>&1; sleep 3
done
assert_summary
