# Scenario for the real-Shell harness (GUAVA_EXTRA; bundle with tools/harness/lib/lib.sh,
# perf-lib.sh and classify.js first). F3 · Windows hand-over audit (RV3):
#   RV3-1  Split View on a window that was zoomed, then full screen: it takes the half
#   RV3-6  a candidate that closes while the picker is open leaves the picker
#   RV3-5  Split View on a window that sends no size-changed: the half is placed anyway
#   RV3-2  a throw while minimizing still completes: the window is hidden, not stuck on screen
#   RV3-4  a tile flight stops when the window is maximized
#   RV3-8  no slow-down when the Space switch does not happen
#   RV3-3  a window opened over a full-screen Space is followed to the first workspace
force_animations on
cat > $W/wapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk}=imports.gi;
const id=ARGV[0];
const app=new Gtk.Application({application_id:id});
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:id,default_width:600,default_height:400});
  w.set_child(new Gtk.Label({label:id})); w.present();
});
app.run([]);
EOF2
gs stage-manager false
gs move-window-to-new-workspace true
sleep 2
launch_app "gjs $W/wapp.js org.x2.WinA" org.x2.WinA 40
launch_app "gjs $W/wapp.js org.x2.WinB" org.x2.WinB 40
sleep 1
H='const wf=c=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()===c)??null; const A=()=>wf("org.x2.WinA"), B=()=>wf("org.x2.WinB"); const wm=()=>global.workspace_manager;
const sv=()=>inst("split-view"); const wt=()=>inst("window-tiling");
const half=()=>{const a=A().get_work_area_current_monitor(); return a.width/2;};
const picker=()=>Main.layoutManager.uiGroup.get_children().find(c=>c.name==="guava-split-picker")??null;
const thumbs=()=>{const p=picker(); return p?p.get_children().filter(c=>c.style_class==="guava-split-thumb").length:-1;};
const back=async()=>{ if(A().is_fullscreen()) A().unmake_fullscreen(); await sl(800); if(A().is_maximized()) A().unmaximize(); if(B()&&B().is_maximized()) B().unmaximize(); wm().get_workspace_by_index(0).activate(global.get_current_time()); await sl(1200); };'
J() { _kjs "$H $1"; }

echo "-- RV3-1 zoomed then full screen then Split View"
J 'A().change_workspace_by_index(0,false); B().change_workspace_by_index(0,false); A().activate(global.get_current_time()); await sl(500); A().maximize(); await sl(900); A().make_fullscreen(); await sl(3500); globalThis.__ok=sv().tile(A(),"left"); await sl(2000); const f=A().get_frame_rect(); globalThis.__sv={ok:__ok,fs:A().is_fullscreen(),max:A().is_maximized(),w:f.width,half:half(),picker:!!picker()}; return JSON.stringify(__sv)' | tail -1
shot rv3-1-split
assert "rv3-1 split view takes the half after zoom+fullscreen" "globalThis.__sv.ok && !globalThis.__sv.fs && !globalThis.__sv.max && Math.abs(globalThis.__sv.w-globalThis.__sv.half)<=2 && globalThis.__sv.picker"

echo "-- RV3-6 a candidate closes while the picker is open"
J 'const n0=thumbs(); B().delete(global.get_current_time()); await sl(1500); globalThis.__pk={n0:n0,n1:thumbs()}; return JSON.stringify(__pk)' | tail -1
assert "rv3-6 thumbnail of the closed window is gone" "globalThis.__pk.n0>=1 && globalThis.__pk.n1===globalThis.__pk.n0-1"
J 'sv()._cancelPicker({refullscreen:false}); await sl(300); await back(); return 1' >/dev/null
launch_app "gjs $W/wapp.js org.x2.WinB" org.x2.WinB 40

echo "-- RV3-5 no size-changed after leaving full screen"
J 'A().change_workspace_by_index(0,false); B().change_workspace_by_index(0,false); A().activate(global.get_current_time()); await sl(500); A().make_fullscreen(); await sl(3500); const w=A(); w.unmake_fullscreen=()=>{}; globalThis.__t=sv().tile(w,"right"); await sl(900); globalThis.__s5={t:__t,settling:!!sv()._settling,picker:!!picker()}; delete w.unmake_fullscreen; return JSON.stringify(__s5)' | tail -1
assert "rv3-5 half placed and picker shown without size-changed" "globalThis.__s5.t && !globalThis.__s5.settling && globalThis.__s5.picker"
J 'sv()._cancelPicker({refullscreen:false}); await sl(300); await back(); return 1' >/dev/null

echo "-- RV3-2 a throw while minimizing still completes"
J 'A().change_workspace_by_index(0,false); A().activate(global.get_current_time()); await sl(800); const me=inst("minimize-effect"); const keep=me.targetFor; me.targetFor=()=>{throw new Error("GUAVA-TEST-EXPECTED boom")}; A().minimize(); await sl(1800); me.targetFor=keep; const act=A().get_compositor_private(); globalThis.__mn={min:A().minimized,vis:act.visible}; A().unminimize(); await sl(1200); globalThis.__mn.back=!A().minimized&&A().get_compositor_private().visible; return JSON.stringify(__mn)' | tail -1
assert "rv3-2 minimized window is hidden after a throw (not stuck)" "globalThis.__mn.min && !globalThis.__mn.vis"
assert "rv3-2 it comes back" "globalThis.__mn.back"

echo "-- RV3-4 a tile flight stops at maximize"
J 'A().activate(global.get_current_time()); await sl(1500); const s0={...wt().tileStats}; const fr0=A().get_frame_rect(); const act0=A().get_compositor_private(); wt().perform(A(),fr0.x<100?"right":"left"); globalThis.__dbg={s0:s0,fr0:[fr0.x,fr0.y,fr0.width,fr0.height],vis:act0.visible,min:A().minimized,fsn:A().is_fullscreen(),ws:A().get_workspace().index(),act:wm().get_active_workspace_index()}; let f=false; for(let i=0;i<6&&!f;i++){ await sl(40); f=wt()._motion.flying(A()); } globalThis.__fly=f; A().maximize(); await sl(100); globalThis.__after=wt()._motion.flying(A()); await sl(1500); const a=A().get_compositor_private(); globalThis.__mx={dbg:__dbg,s1:{...wt().tileStats},fly:__fly,after:__after,sx:a.scale_x,tx:a.translation_x,max:A().is_maximized()}; A().unmaximize(); await sl(800); return JSON.stringify(__mx)' | tail -1
assert "rv3-4 the flight started" "globalThis.__mx.fly===true"
assert "rv3-4 maximize ends the flight, actor native" "globalThis.__mx.after===false && globalThis.__mx.max && globalThis.__mx.sx===1 && globalThis.__mx.tx===0"

echo "-- RV3-8 no slow-down without a switch"
J 'const fsn=inst("move-window-to-new-workspace"); const ws=wm().get_active_workspace(); const before=St.Settings.get().slow_down_factor; fsn._activate(ws,null); globalThis.__sd={before:before,after:St.Settings.get().slow_down_factor}; await sl(900); return JSON.stringify(__sd)' | tail -1
assert "rv3-8 slow_down_factor untouched" "globalThis.__sd.after===globalThis.__sd.before"

echo "-- RV3-3 a new window over a full-screen Space is followed"
J 'B().delete(global.get_current_time()); await sl(1000); wm().get_workspace_by_index(0).activate(global.get_current_time()); await sl(800); A().change_workspace_by_index(0,false); A().activate(global.get_current_time()); await sl(500); A().make_fullscreen(); await sl(3500); globalThis.__act0=wm().get_active_workspace_index(); return 1' >/dev/null
launch_app "gjs $W/wapp.js org.x2.WinB" org.x2.WinB 40
J 'await sl(2500); const b=B(); globalThis.__n3={act0:__act0,act:wm().get_active_workspace_index(),bws:b.get_workspace().index(),focus:global.display.focus_window===b}; return JSON.stringify(__n3)' | tail -1
shot rv3-3-follow
assert "rv3-3 full-screen Space was active" "globalThis.__n3.act0===1"
assert "rv3-3 new window on the first workspace, active and focused" "globalThis.__n3.bws===0 && globalThis.__n3.act===0 && globalThis.__n3.focus"
assert_summary
