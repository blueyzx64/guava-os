# overview-bisect.sh: L19 (B35). What does each Guava feature add to the overview open / close and to the
# overview spam burst? One PERF line per feature turned off (and one with everything on), same measure as
# perf-suite.sh. Bundle:
#   K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/overview-bisect.sh
# Read the PERF lines: a feature whose "off" row is clearly better than "all-on" is a cost to cut.
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
for _ in 1 2 3; do
  (WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/kperfwin.js >/dev/null 2>&1 9>&- &)
done
sleep 6

_round() { # label
  P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2
  perf_start; P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2; perf_stop "ov-$1"
  perf_start
  for _ in 1 2 3 4 5; do P "Main.overview.toggle(); return 1" >/dev/null; sleep 0.25; done
  P "Main.overview.hide(); return 1" >/dev/null; sleep 1.5
  perf_stop "burst-$1"
}
_round all-on
_round all-on2
for f in ${BISECT:-liquid-glass dock stage-manager notch desktop-icons menu-bar mission-control}; do
  gs "$f" false >/dev/null 2>&1; sleep 2
  _round "no-$f"
  gs "$f" true >/dev/null 2>&1; sleep 3
done
assert_summary
