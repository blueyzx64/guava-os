# Scenario for the real-Shell harness (GUAVA_EXTRA; bundle with tools/harness/lib/lib.sh,
# perf-lib.sh and classify.js first, see tools/harness/README.md). B1: the Genie runs for every
# way a window is minimized or restored, and a restore during a minimize turns back from where
# the funnel is (no snap).
#   - Mutter's minimize from the Shell (keyboard, app menu, dock all call meta_window_minimize)
#   - the app's own minimize (xdg_toplevel.set_minimized from a GTK window)
#   - restore from the dock's minimized-window tile (a real click)
#   - maximized and full-screen windows
#   - the dock auto-hidden and out of sight, and the dock turned off (no icon at all)
#   - restore during a minimize, and the reverse: one turn, small steps, no leftovers
#   - five fast minimize/restore pairs; the overview (no effect, as in GNOME)
#   - frame times of a Genie (perf_start/perf_stop)
force_animations on
gs stage-manager false
sleep 2
cat > $W/selfmin.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk,GLib}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.SelfMin'});
// Minimizes itself through the toolkit (xdg_toplevel.set_minimized), like its own button
app.connect('activate',()=>{const w=new Gtk.ApplicationWindow({application:app,title:'Self minimize',default_width:520,default_height:360});w.set_child(new Gtk.Label({label:'min'}));w.present();
  GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,6,()=>{w.minimize();return GLib.SOURCE_REMOVE;});});
app.run([]);
EOF2

# me: the feature; genie(): the running funnel's progress (null when none); clean(): no funnel
# left, every window fully opaque, nothing running or carried; rec(): progress per painted frame
H='const me=inst("minimize-effect");
const anyw=c=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()===c);
const fx=()=>{let e=null;const f=x=>{e??=x.get_effect?.("guava-genie")??null;x.get_children().forEach(f)};f(global.window_group);return e};
const genie=()=>fx()?.progress??null;
const clean=()=>genie()===null&&me._running.size===0&&me._carried.size===0&&global.get_window_actors().every(a=>a.meta_window.minimized||a.opacity===255);
const st=()=>({...me.stats});
const rec=()=>{const s=[];const id=global.stage.connect("after-paint",()=>{const p=genie();if(p!==null)s.push(p)});return {s,stop:()=>global.stage.disconnect(id)}};
globalThis.__clean=clean; globalThis.__anyw=anyw;
const turns=s=>{let t=0,d=0,big=0;for(let i=1;i<s.length;i++){const k=s[i]-s[i-1];if(Math.abs(k)>big)big=Math.abs(k);const n=Math.sign(k);if(n&&d&&n!==d)t++;if(n)d=n;}return {t,big:+big.toFixed(3),n:s.length}};'
J() { _kjs "$H $1"; }
E=org.gnome.TextEditor

echo "-- warm-up"
J "const w=anyw('$E'); w.activate(global.get_current_time()); await sl(400); w.minimize(); await sl(900); w.unminimize(); await sl(900); return 1" >/dev/null

echo "-- B1 minimize and restore by Mutter (keyboard, app menu and dock share this path)"
J "globalThis.__s0=st(); const w=anyw('$E'); w.minimize(); await sl(200); globalThis.__mid=genie(); globalThis.__map=fx()?.map; await sl(900); globalThis.__m=w.minimized; w.unminimize(); await sl(200); globalThis.__mid2=genie(); await sl(900); return 1" >/dev/null
assert "genie-minimize-runs" "globalThis.__m && globalThis.__mid>0 && globalThis.__mid<1"
J "return 'map '+JSON.stringify(globalThis.__map)"
assert "genie-texture-native-1to1" "(m=>m && Number.isInteger(m.texWidth/m.width) && m.texWidth/m.width===m.texHeight/m.height && Number.isInteger(m.x) && Number.isInteger(m.y))(globalThis.__map)"
assert "genie-restore-runs" "globalThis.__mid2>0 && globalThis.__mid2<1 && inst('minimize-effect').stats.animations-globalThis.__s0.animations===2"
assert "genie-clean-after" "__clean() && !__anyw('$E').minimized"

echo "-- B1 the app minimizes itself (xdg_toplevel.set_minimized)"
J "globalThis.__s0=st(); return 1" >/dev/null
launch_app "gjs $W/selfmin.js" org.x2.SelfMin 30
wait_for "__anyw('org.x2.SelfMin')?.minimized" 15
J "await sl(900); return 1" >/dev/null
assert "genie-app-own-minimize" "__anyw('org.x2.SelfMin').minimized && inst('minimize-effect').stats.animations-globalThis.__s0.animations===1 && __clean()"

echo "-- B1 restore from the dock's minimized-window tile (a click)"
J "globalThis.__s0=st(); const w=anyw('$E'); w.minimize(); await sl(1200); const d=inst('dock'); const r=d.rectOf(d._view.item('window-'+w.get_stable_sequence())); globalThis.__tile=!!r; if(r) await kclick(r.x+r.width/2,r.y+r.height/2); await sl(1200); return 1" >/dev/null
assert "genie-restore-from-dock-tile" "globalThis.__tile && !__anyw('$E').minimized && inst('minimize-effect').stats.animations-globalThis.__s0.animations===2 && __clean()"

echo "-- B1 maximized and full-screen windows"
J "globalThis.__s0=st(); const w=anyw('$E'); w.maximize(); await sl(900); w.minimize(); await sl(200); globalThis.__mx=genie(); await sl(900); w.unminimize(); await sl(900); w.unmaximize(); await sl(700); w.make_fullscreen(); await sl(1200); w.minimize(); await sl(200); globalThis.__fs=genie(); await sl(900); w.unminimize(); await sl(900); w.unmake_fullscreen(); await sl(900); return 1" >/dev/null
assert "genie-maximized" "globalThis.__mx>0 && globalThis.__mx<1"
assert "genie-fullscreen" "globalThis.__fs>0 && globalThis.__fs<1 && __clean()"

echo "-- B1 dock auto-hidden out of sight, then the dock off"
gs dock-autohide true
J "await kmove(640,300); await sl(2500); globalThis.__s0=st(); const w=anyw('$E'); w.minimize(); await sl(200); globalThis.__ah=genie(); await sl(900); w.unminimize(); await sl(900); return 1" >/dev/null
assert "genie-dock-autohidden" "globalThis.__ah>0 && globalThis.__ah<1 && __clean()"
gs dock-autohide false
gs dock false
sleep 2
J "globalThis.__s0=st(); const w=anyw('$E'); w.minimize(); await sl(200); globalThis.__nd=genie(); globalThis.__ndt=JSON.stringify(me.targetFor(w)?.rect); await sl(900); w.unminimize(); await sl(900); return 1" >/dev/null
assert "genie-without-dock" "globalThis.__nd>0 && globalThis.__nd<1 && __clean()"
gs dock true
sleep 3

echo "-- B1 interruptible: restore during a minimize, minimize during a restore"
J "const w=anyw('$E'); w.activate(global.get_current_time()); await sl(500); globalThis.__s0=st(); const r=rec(); w.minimize(); await sl(260); globalThis.__p1=genie(); w.unminimize(); globalThis.__p2=genie(); await sl(1000); r.stop(); globalThis.__t1=turns(r.s); return 1" >/dev/null
assert "genie-restore-turns-back-in-place" "globalThis.__p1>0.1 && globalThis.__p1<0.9 && Math.abs(globalThis.__p2-globalThis.__p1)<0.02 && inst('minimize-effect').stats.resumed-globalThis.__s0.resumed===1"
assert "genie-restore-turn-smooth" "globalThis.__t1.t===1 && globalThis.__t1.big<0.2 && __clean() && !__anyw('$E').minimized"
# The record holds the minimize, the restore, and the minimize that cuts the restore: two turns
J "const w=anyw('$E'); globalThis.__s0=st(); const r=rec(); w.minimize(); await sl(1000); w.unminimize(); await sl(260); globalThis.__p1=genie(); w.minimize(); globalThis.__p2=genie(); await sl(1000); r.stop(); globalThis.__t2=turns(r.s); globalThis.__m2=w.minimized; w.unminimize(); await sl(900); return 1" >/dev/null
assert "genie-minimize-during-restore" "globalThis.__m2 && Math.abs(globalThis.__p2-globalThis.__p1)<0.02 && globalThis.__t2.t===2 && globalThis.__t2.big<0.2 && __clean()"
J "return 'turns '+JSON.stringify([globalThis.__t1,globalThis.__t2])"

echo "-- B1 five fast pairs"
J "const w=anyw('$E'); for(let i=0;i<5;i++){w.minimize(); await sl(60+i*30); w.unminimize(); await sl(60);} await sl(1200); return 1" >/dev/null
assert "genie-fast-pairs-end-clean" "__clean() && !__anyw('$E').minimized && __anyw('$E').get_compositor_private().visible"

echo "-- B1 in the overview: no effect, completes (as GNOME)"
J "globalThis.__s0=st(); Main.overview.show(); await sl(1500); const w=anyw('$E'); w.minimize(); await sl(100); globalThis.__ov=w.minimized&&genie()===null; Main.overview.hide(); await sl(1500); w.unminimize(); await sl(900); return 1" >/dev/null
assert "genie-overview-none" "globalThis.__ov && __clean()"

echo "-- B1 frame times"
perf_start
J "const w=anyw('$E'); w.minimize(); await sl(900); w.unminimize(); await sl(900); return 1" >/dev/null
perf_stop genie-min-restore
J "return 'stats '+JSON.stringify(me.stats)"
shot minimize-genie-end
assert_summary
