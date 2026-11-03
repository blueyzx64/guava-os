# Scenario for the real-Shell harness (GUAVA_EXTRA; bundle with tools/harness/lib/lib.sh,
# perf-lib.sh and classify.js first, see tools/harness/README.md). L10 · Windows:
#   B17  the menu bar revealed over a full-screen window leads with a green exit control; a click
#        leaves full screen
#   B23  a tile flies the window (no jump), a second tile retargets from where the window is,
#        and the last frame is the app's own, 1:1
force_animations on
gs stage-manager false
gs move-window-to-new-workspace false
sleep 2
E=org.gnome.TextEditor
J() { _kjs "$1"; }
H='const wt=inst("window-tiling");
const w=()=>global.get_window_actors().map(a=>a.meta_window).find(x=>x.get_wm_class()==="org.gnome.TextEditor");
const act=()=>w().get_compositor_private();
const idle=a=>a.scale_x===1&&a.scale_y===1&&a.translation_x===0&&a.translation_y===0;
globalThis.__w=w; globalThis.__act=act;'
J2() { _kjs "$H $1"; }

echo "-- B23 a tile flies, the last frame is native"
J2 "w().activate(global.get_current_time()); await sl(500); const s0={...wt.tileStats}; globalThis.__s0=s0; wt.perform(w(),'left'); await sl(110); const a=act(); globalThis.__mid=!idle(a)&&wt._motion.flying(w()); globalThis.__midScale=a.scale_x; await sl(1500); globalThis.__s1={...wt.tileStats}; const z=wt.zoneRectOn('left',w().get_monitor()); const f=w().get_frame_rect(); globalThis.__fit=f.x===z.x&&f.y===z.y&&f.width===z.width&&f.height===z.height; globalThis.__idle=idle(act())&&!wt._motion.flying(w()); return 1" >/dev/null
assert "tile-flies" "globalThis.__mid===true && globalThis.__s1.flights-globalThis.__s0.flights===1 && globalThis.__s1.frames>globalThis.__s0.frames"
assert "tile-ends-native" "globalThis.__fit===true && globalThis.__idle===true"

echo "-- B23 interrupted: the second tile starts where the window is (no jump)"
J2 "wt.perform(w(),'right'); await sl(120); const r=wt._motion._runs.get(w()); const before={...r.visual}; wt.perform(w(),'left'); const after={...wt._motion._runs.get(w()).visual}; globalThis.__jump=Math.max(Math.abs(before.x-after.x),Math.abs(before.y-after.y),Math.abs(before.width-after.width),Math.abs(before.height-after.height)); await sl(1700); const z=wt.zoneRectOn('left',w().get_monitor()); const f=w().get_frame_rect(); globalThis.__fit2=f.x===z.x&&f.width===z.width; globalThis.__idle2=idle(act())&&!wt._motion.flying(w()); return 1" >/dev/null
assert "tile-retarget-no-jump" "globalThis.__jump<1.5 && globalThis.__fit2===true && globalThis.__idle2===true"

echo "-- B23 animations off: the tile is at once"
force_animations off
J2 "const s=wt.tileStats.flights; wt.perform(w(),'right'); await sl(150); globalThis.__off=wt.tileStats.flights===s&&idle(act()); return 1" >/dev/null
assert "tile-animations-off" "globalThis.__off===true"
force_animations on

echo "-- B17 green exit control in the revealed bar"
J2 "w().make_fullscreen(); await sl(1500); const fs=inst('menu-bar').part('fullscreen'); globalThis.__fsw=fs; globalThis.__in=w().is_fullscreen()&&Main.layoutManager.primaryMonitor.inFullscreen; fs.reveal(); await sl(700); const b=fs._exit; const [x,y]=b.get_transformed_position(); globalThis.__btn={vis:b.visible,mapped:b.mapped,x:x,y:y,w:b.width,h:b.height,name:b.accessible_name}; return 1" >/dev/null
shot b17-revealed
assert "exit-visible-when-revealed" "globalThis.__in===true && globalThis.__btn.vis && globalThis.__btn.mapped && globalThis.__btn.w>=12 && globalThis.__btn.y>=0 && globalThis.__btn.y<32"
J2 "const b=__fsw._exit; const [x,y]=b.get_transformed_position(); await kclick(x+b.width/2,y+b.height/2); await sl(800); globalThis.__left=!w().is_fullscreen(); return 1" >/dev/null
assert "exit-click-leaves-fullscreen" "globalThis.__left===true"
J2 "await sl(900); const fs=inst('menu-bar').part('fullscreen'); globalThis.__hidden=!fs._exit.visible; return 1" >/dev/null
assert "exit-hidden-outside-fullscreen" "globalThis.__hidden===true"
assert_summary
