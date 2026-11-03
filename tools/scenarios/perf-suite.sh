# perf-suite.sh: the real-Shell half of the perf suite (B11). Bundled by run-perf.sh with
# lib.sh, perf-lib.sh and classify.js, and run twice per suite: once logged in to stock GNOME
# (GUAVA_STOCK=1, the baseline) and once logged in with Guava. The STARTUP line (login) comes
# from inner-real.sh. Every line this prints starts with IDLE, PERF, JITTER or INFO;
# tools/scenarios/perf-compare.py turns the two runs into PASS/FAIL. Thresholds: README.md.
#
# Sections: idle (paints, CPU, wakeups of the Shell), core interactions at minimal load,
# burst (windows opening/closing, overview spam), the same interactions with every core busy.

force_animations on >/dev/null

# ---- idle: an idle Shell must not wake up ------------------------------------------------------
# Main-thread context switches approximate wakeups (timers, idles, D-Bus); paints must be 0.
_idle() { # label seconds
  local s0 c0 s1 c1
  P "globalThis.__kidle={n:0,id:global.stage.connect('after-paint',()=>globalThis.__kidle.n++)}; return 1" >/dev/null
  s0=$(awk '{print $14+$15}' /proc/$SP/stat); c0=$(awk '/ctxt_switches/{s+=$2} END{print s}' /proc/$SP/task/$SP/status)
  sleep "$2"
  s1=$(awk '{print $14+$15}' /proc/$SP/stat); c1=$(awk '/ctxt_switches/{s+=$2} END{print s}' /proc/$SP/task/$SP/status)
  local paints; paints=$(P "global.stage.disconnect(globalThis.__kidle.id); return globalThis.__kidle.n" | grep -o '[0-9]\+' | head -1)
  # The probe's own D-Bus calls (2) are in the counts of both runs alike
  echo "IDLE $1 paints=${paints:-0} cpu_ms=$(( (s1 - s0) * 10 )) wakeups_per_s=$(( (c1 - c0) / $2 ))"
}
sleep 3
_idle idle 10

# ---- a window to work with ------------------------------------------------------------------------
cat >$W/kperfwin.js <<'JSA'
imports.gi.versions.Gtk='4.0';
const {Gtk,Gio}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.Perf',flags:Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate',()=>{const w=new Gtk.ApplicationWindow({application:app,title:'perf',default_width:480,default_height:320});w.set_child(new Gtk.Label({label:'p'}));w.present();});
app.run([]);
JSA
_win() { (WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/kperfwin.js >/dev/null 2>&1 9>&- &); }
_wins() { P "return global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==='org.x2.Perf').length" | grep -o '[0-9]\+' | head -1; }
_win
wait_for "global.get_window_actors().some(a=>a.meta_window.get_wm_class()==='org.x2.Perf')" 40 >/dev/null
sleep 1

# ---- core interactions (run under a label suffix: '' at rest, '-load' under CPU overload) ----------
_core() { # suffix
  local sfx=$1
  # Overview open + close (the stock baseline animation; Mission Control in Guava)
  P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2   # warm-up
  perf_start; P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2; perf_stop "overview$sfx"
  # A panel menu (Quick Settings / Control Center)
  perf_start; P "Main.panel.statusArea.quickSettings.menu.open(); return 1" >/dev/null; sleep 0.8
  P "Main.panel.statusArea.quickSettings.menu.close(); return 1" >/dev/null; sleep 0.8; perf_stop "menu$sfx"
  # Window drag by its titlebar with the real pointer, tracked for jumps
  P "const w=global.get_window_actors().find(a=>a.meta_window.get_wm_class()==='org.x2.Perf')?.meta_window; w?.move_frame(true,300,200); w?.activate(global.get_current_time()); return 1" >/dev/null; sleep 0.5
  local xy; xy=$(P "const r=global.get_window_actors().find(a=>a.meta_window.get_wm_class()==='org.x2.Perf').meta_window.get_frame_rect(); return (r.x+r.width/2|0)+' '+(r.y+18)" | grep -o '[0-9]\+ [0-9]\+')
  set -- $xy
  perf_start; track_actor "global.get_window_actors().find(a=>a.meta_window.get_wm_class()==='org.x2.Perf')" "drag$sfx" >/dev/null
  drag "$1" "$2" $(( $1 + 260 )) $(( $2 + 140 )) >/dev/null; sleep 0.6
  track_stop; perf_stop "drag$sfx"
}
_core ""

# ---- burst: six windows open and close, then overview spam -----------------------------------------
perf_start
for _ in 1 2 3 4 5 6; do _win; done
wait_for "global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==='org.x2.Perf').length>=7" 40 >/dev/null
P "global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==='org.x2.Perf').slice(1).forEach(a=>a.meta_window.delete(global.get_current_time())); return 1" >/dev/null
sleep 2
for _ in 1 2 3 4 5; do P "Main.overview.toggle(); return 1" >/dev/null; sleep 0.25; done
P "Main.overview.hide(); return 1" >/dev/null; sleep 1.5
perf_stop burst
echo "INFO burst windows-left=$(_wins)"

# ---- CPU overload: one busy loop per core at nice 0 ------------------------------------------------
LOADPIDS=""
for _ in $(seq 1 "$(nproc)"); do ( while :; do :; done ) & LOADPIDS="$LOADPIDS $!"; done
sleep 1
_core "-load"
echo "INFO degraded-under-load=$(P "return Main.extensionManager.lookup('guava-os@blueyzx64')?.stateObj?._motion?.env?.degraded ?? 'n/a'" | grep -o 'true\|false\|n/a' | head -1)"
kill $LOADPIDS 2>/dev/null; wait $LOADPIDS 2>/dev/null
sleep 3
_idle idle-after 5
