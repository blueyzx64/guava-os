# latency-cold.sh: L19 (B35, D-021) focused latency run for the cold first opens: Notification Center (clock),
# notch hover, Mission Control (Ctrl+Up), and the overview / burst frame costs. Same `lat` metric as
# perf-latency.sh. Bundle:
#   K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh $K/perf-lib.sh $K/classify.js \
#     tools/scenarios/perf-latency.sh tools/scenarios/latency-cold.sh
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
(WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/kperfwin.js >/dev/null 2>&1 9>&- &)
wait_for "global.get_window_actors().some(a=>a.meta_window.get_wm_class()==='org.x2.Perf')" 40 >/dev/null
sleep 1
P "const w=kwin('org.x2.Perf'); w?.move_frame(true,300,200); w?.activate(global.get_current_time()); Main.overview.hide(); return 1" >/dev/null; sleep 1

REPS=${LAT_REPS:-5}
esc="await kkey(['Escape']); Main.overview.hide(); await sl(900);"
dm="Main.panel.statusArea.dateMenu"
# the first rep of each is the cold one: INFO lines print the misses, LAT the summary
lat clock $REPS "(${dm}.menu.isOpen&&shown(${dm}.menu.actor))||(inst('notification-center')?.isOpen&&shown(find('guava-nc')))" "await kclickM(${dm},mark);" "${dm}.menu.close(); inst('notification-center')?.close(); await sl(900);"
# notch hover: the pill swells at once (a response); the dashboard follows the dwell
lat notch-hover $REPS "(()=>{const n=find('guava-notch');return shown(find('guava-notch-dash'))||(!!n&&n.width>globalThis.__lat.w0+3);})()" \
  "await away(); await sl(600); const n=find('guava-notch'); globalThis.__lat.w0=n.width; const [x,y]=ctr(n); await kmove(x,y+30); await sl(100); mark(); await kmove(x,y);" \
  "await away(); await sl(1500);"
lat mission-control $REPS "ovp()" "await kk(['Control_L','Up'],mark,1,-1);" "$esc"
# overview open / close frame cost, then the burst
P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2
perf_start; P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2; perf_stop overview
perf_start
for _ in 1 2 3 4 5; do P "Main.overview.toggle(); return 1" >/dev/null; sleep 0.25; done
P "Main.overview.hide(); return 1" >/dev/null; sleep 1.5
perf_stop burst
assert_summary
