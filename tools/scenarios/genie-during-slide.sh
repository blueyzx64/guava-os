# Scenario for the real-Shell harness (GUAVA_EXTRA; bundle with tools/harness/lib/lib.sh first,
# see tools/harness/README.md). B24: the Genie plays for a window minimized or restored while a
# workspace slide runs. Mutter sends no 'minimize' / 'unminimize' then (meta_window_actor_hide/show
# wait for the slide and then hide or show it with no effect), so features/minimizeEffect plays
# a detached run on a clone above the slide.
#   - minimize a window going full screen during its slide to its own Space
#   - restore it with a slide (activating it from another workspace, as the dock does)
#   - restore during that slide, then minimize again: the funnel turns back from where it is
#   - the Genie stays the Genie at its own speed (no Scale, not stretched by the slowed slide)
force_animations on
gs stage-manager false
gs move-window-to-new-workspace true
gs dock-minimize-effect genie
sleep 2
cat > $W/slideapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.SlideApp'});
app.connect('activate',()=>{const w=new Gtk.ApplicationWindow({application:app,title:'Slide App',default_width:640,default_height:420});w.set_child(new Gtk.Label({label:'slide'}));w.present();});
app.run([]);
EOF2
launch_app "gjs $W/slideapp.js" org.x2.SlideApp 40
sleep 2; focus_app org.x2.SlideApp; sleep 1

# W(): the window, minimized or not (kwin() sees mapped windows only); fx(): the running funnel's effect anywhere in the stage tree; rec(): progress and time per
# painted frame, and whether a slide ran at that frame
H='const me=inst("minimize-effect"); const W=()=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()==="org.x2.SlideApp")??null;
const fx=()=>{let e=null;const f=x=>{e??=x.get_effect?.("guava-genie")??null;x.get_children().forEach(f)};f(Main.uiGroup);return e};
const genie=()=>fx()?.progress??null;
const clean=()=>genie()===null&&me._running.size===0&&me._carried.size===0&&global.get_window_actors().every(a=>a.meta_window.minimized||a.opacity===255);
const rec=()=>{const s=[],t=[],sw=[];const id=global.stage.connect("after-paint",()=>{const p=genie();if(p!==null){s.push(p);t.push(GLib.get_monotonic_time()/1000);sw.push(!!Main.wm._switchInProgress)}});return {s,t,sw,stop:()=>global.stage.disconnect(id)}};
const until=async(f,ms=3000)=>{for(let i=0;i<ms/10&&!f();i++)await sl(10)};
const turns=s=>{let t=0,d=0;for(let i=1;i<s.length;i++){const n=Math.sign(s[i]-s[i-1]);if(n&&d&&n!==d)t++;if(n)d=n;}return t};
const span=r=>r.t.length>1?Math.round(r.t[r.t.length-1]-r.t[0]):0;
globalThis.__clean=clean; globalThis.__W=W;'
J() { _kjs "$H $1"; }

echo "-- full duration of a Genie on this machine (no slide), for comparison"
J "const w=W(); const r=rec(); w.minimize(); await sl(1500); r.stop(); globalThis.__base=span(r); w.unminimize(); await sl(1500); return 'genie span '+globalThis.__base+' ms, frames '+r.s.length"

echo "-- minimize during the slide to its full-screen Space"
J "const w=W(); w.make_fullscreen(); await until(()=>Main.wm._switchInProgress,6000); globalThis.__sw=!!Main.wm._switchInProgress; globalThis.__s0={...me.stats}; const r=rec(); w.minimize(); await until(()=>genie()!==null&&genie()>0,1500); globalThis.__layer=fx()?.actor?.get_parent()===Main.uiGroup; globalThis.__mid=genie(); await sl(2500); r.stop(); globalThis.__r1={n:r.s.length,inSlide:r.sw.filter(x=>x).length,span:span(r),last:r.s[r.s.length-1]}; globalThis.__m1=w.minimized&&!w.get_compositor_private().visible; return 'slide '+globalThis.__sw+' '+JSON.stringify(globalThis.__r1)"
assert "slide-minimize-in-a-slide" "globalThis.__sw===true"
assert "slide-minimize-genie-runs" "globalThis.__mid>0 && globalThis.__mid<1 && globalThis.__r1.inSlide>0 && inst('minimize-effect').stats.animations-globalThis.__s0.animations===1"
assert "slide-minimize-genie-above-the-slide" "globalThis.__layer===true"
# The last painted frame is a software frame (~40 ms) short of the end, where the funnel goes
assert "slide-minimize-genie-full-run" "globalThis.__r1.last>0.85 && globalThis.__m1"
# Not stretched by fullscreenSpace's 3x slow-down: within half again of the plain run
assert "slide-minimize-genie-own-speed" "globalThis.__r1.span < globalThis.__base*1.5+150"
assert "slide-minimize-ends-clean" "__clean()"

echo "-- restore with a slide (activated from another workspace, as the dock does)"
J "const w=W(); global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); await sl(2000); globalThis.__away=global.workspace_manager.get_active_workspace()!==w.get_workspace(); globalThis.__s0={...me.stats}; const r=rec(); Main.activateWindow(w); globalThis.__sw2=!!Main.wm._switchInProgress; await sl(2500); r.stop(); globalThis.__r2={n:r.s.length,inSlide:r.sw.filter(x=>x).length,span:span(r),first:r.s[0],last:r.s[r.s.length-1]}; return 'away '+globalThis.__away+' slide '+globalThis.__sw2+' '+JSON.stringify(globalThis.__r2)"
assert "slide-restore-in-a-slide" "globalThis.__away && globalThis.__sw2"
assert "slide-restore-genie-runs" "globalThis.__r2.inSlide>0 && globalThis.__r2.first>0.5 && globalThis.__r2.last<0.05 && inst('minimize-effect').stats.animations-globalThis.__s0.animations===1"
assert "slide-restore-ends-clean" "__clean() && !__W().minimized && __W().get_compositor_private().visible && __W().get_compositor_private().opacity===255"

# A plain slide lasts ~250 ms: the turn comes early, inside it (reported); after the slide the
# picture above it carries on as well
echo "-- restore with a slide, then minimize again mid-way: one turn, from where it is"
J "const w=W(); global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); await sl(2000); w.minimize(); await sl(1500); globalThis.__s0={...me.stats}; const r=rec(); Main.activateWindow(w); await until(()=>genie()!==null&&genie()<0.85,1500); globalThis.__p1=genie(); globalThis.__sw3=!!Main.wm._switchInProgress; w.minimize(); globalThis.__p2=genie(); await sl(2500); r.stop(); globalThis.__t3=turns(r.s); globalThis.__m3=w.minimized; return 'turn p1 '+globalThis.__p1+' p2 '+globalThis.__p2+' slide '+globalThis.__sw3+' turns '+globalThis.__t3+' stats '+JSON.stringify([globalThis.__s0,me.stats])"
assert "slide-turn-in-place" "globalThis.__sw3 && Math.abs(globalThis.__p2-globalThis.__p1)<0.02 && inst('minimize-effect').stats.resumed-globalThis.__s0.resumed===1"
assert "slide-turn-one-turn" "globalThis.__t3===1 && globalThis.__m3 && __clean()"

echo "-- the same turn once the slide has ended (the picture above it carries on)"
J "const w=W(); global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); await sl(2000); globalThis.__s0={...me.stats}; const r=rec(); Main.activateWindow(w); await until(()=>!Main.wm._switchInProgress&&genie()!==null&&genie()<0.6,1500); globalThis.__p1=genie(); globalThis.__sw4=!!Main.wm._switchInProgress; w.minimize(); globalThis.__p2=genie(); await sl(2500); r.stop(); globalThis.__t4=turns(r.s); globalThis.__m4=w.minimized; return 'turn p1 '+globalThis.__p1+' p2 '+globalThis.__p2+' slide '+globalThis.__sw4+' turns '+globalThis.__t4"
assert "after-slide-turn-in-place" "!globalThis.__sw4 && globalThis.__p1!==null && Math.abs(globalThis.__p2-globalThis.__p1)<0.02 && inst('minimize-effect').stats.resumed-globalThis.__s0.resumed===1"
assert "after-slide-turn-one-turn" "globalThis.__t4===1 && globalThis.__m4 && __clean()"

J "const w=W(); w.unminimize(); await sl(1500); w.unmake_fullscreen(); await sl(2000); return 'stats '+JSON.stringify(me.stats)"
assert "slide-end-clean" "__clean() && !__W().minimized && !__W().is_fullscreen()"
shot genie-during-slide-end
assert_summary
