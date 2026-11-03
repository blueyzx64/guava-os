# Stage Manager: a window created minimized never fires the Shell's 'map' (RV1-5). It must be told to
# the model when it is restored, not left visible and unmanaged. Bundle after stage-manager-lib.sh.
echo "-- SM window created minimized"
cat > $W/minapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.SmM'});
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:'SM M',default_width:500,default_height:300});
  w.set_child(new Gtk.Label({label:'minimized at start'}));
  w.minimize();
  w.present();
});
app.run([]);
EOF2
sm_up A B
# not mapped, so launch_app times out: the window is looked up below
launch_app "gjs $W/minapp.js" org.x2.SmM 5 || true
sleep 2
_kjs 'const a=global.get_window_actors().find(x=>x.meta_window.get_wm_class()==="org.x2.SmM"); globalThis.__smM=a?.meta_window.get_stable_sequence()??null; return "MIN "+JSON.stringify(a?{min:a.meta_window.minimized,mapped:a.mapped}:null)' | grep -o "MIN.*" | head -1
assert "pre: the new window exists and is minimized" "globalThis.__smM!==null && global.get_window_actors().find(x=>x.meta_window.get_stable_sequence()===globalThis.__smM).meta_window.minimized"
_kjs 'global.get_window_actors().find(x=>x.meta_window.get_stable_sequence()===globalThis.__smM).meta_window.unminimize(); await sl(2000); return 1' >/dev/null
sm_state
assert "RV1-5 the restored window is managed" "inst('stage-manager')._model.isManaged(globalThis.__smM)"
assert "RV1-5 it is the stage; the one before went to the strip" "(()=>{const a=global.get_window_actors().find(x=>x.meta_window.get_stable_sequence()===globalThis.__smM); return a.opacity===255 && !inst('stage-manager')._pending.has(globalThis.__smM) && [wst(sid('A')),wst(sid('B'))].filter(s=>s.op===255).length===0;})()"
echo quit > $W/org.x2.SmM.cmd
_kjs 'const a=global.get_window_actors().find(x=>x.meta_window.get_stable_sequence()===globalThis.__smM); a?.meta_window.delete(global.get_current_time()); await sl(800); return 1' >/dev/null
sm_down
assert_summary
