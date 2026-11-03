# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh).
# Full screen as its own Space (features/fullscreenSpace):
#   enter full screen -> the window alone on a new workspace, the user follows it;
#   leave full screen -> the window back on its original workspace, the user too, and the
#   empty Space removed; with dynamic and with static workspaces; leaving during the slide.
force_animations on
cat > $W/fsapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.FsApp'});
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:'Fs App',default_width:700,default_height:450});
  w.set_child(new Gtk.Label({label:'full screen'})); w.present();
});
app.run([]);
EOF2
# Stage Manager pauses this feature (conflictsWith); the harness turns it on
gs stage-manager false
gs move-window-to-new-workspace true
sleep 2
launch_app "gjs $W/fsapp.js" org.x2.FsApp 40
sleep 2; focus_app org.x2.FsApp; sleep 1

H='const W=()=>kwin("org.x2.FsApp"); const wm=()=>global.workspace_manager;
const wsOf=()=>W().get_workspace().index(); const act=()=>wm().get_active_workspace_index(); const cnt=()=>wm().n_workspaces;'
J() { _kjs "$H $1"; }

run_mode() {
  local mode=$1
  # Static Spaces: the sweep drops empty workspaces past the one kept after the last occupied
  AFTER=2; [ "$mode" = dynamic ] && AFTER=-1
  echo "-- $mode workspaces"
  J 'W().change_workspace_by_index(0,false); wm().get_workspace_by_index(0).activate(global.get_current_time()); await sl(1500); return 1' >/dev/null
  N0=$(J 'return cnt()' | grep -o "[0-9]\+" | head -1)
  echo "FSSPACE start count=$N0"
  [ "$AFTER" = -1 ] && AFTER=$N0

  J 'W().make_fullscreen(); await sl(3000); return 1' >/dev/null
  J 'return "FSDEBUG fs="+W().is_fullscreen()+" ws="+wsOf()+" act="+act()+" cnt="+cnt()+" feat="+!!inst("move-window-to-new-workspace")'
  assert "$mode: full screen window alone on workspace 1" "kwin('org.x2.FsApp').is_fullscreen() && kwin('org.x2.FsApp').get_workspace().index()===1"
  assert "$mode: the user followed it" "global.workspace_manager.get_active_workspace_index()===1"
  assert "$mode: an empty workspace is kept after it" "global.workspace_manager.n_workspaces>=3 && global.workspace_manager.get_workspace_by_index(2).list_windows().length===0"
  assert "$mode: the stationary window is not left pinned" "!Main.wm._workspaceAnimation || Main.wm._workspaceAnimation.movingWindow===null"
  shot fs-$mode-in

  J 'W().unmake_fullscreen(); await sl(3500); return 1' >/dev/null
  assert "$mode: window back on workspace 0" "!kwin('org.x2.FsApp').is_fullscreen() && kwin('org.x2.FsApp').get_workspace().index()===0"
  assert "$mode: the user is back too" "global.workspace_manager.get_active_workspace_index()===0"
  assert "$mode: no stray workspace left" "global.workspace_manager.n_workspaces===$AFTER"
  assert "$mode: slow-down factor given back" "St.Settings.get().slow_down_factor===1"
  shot fs-$mode-out

  # Leave during the slide: the isolate timer (600 ms) has fired, the slide is running
  J 'W().make_fullscreen(); await sl(1000); W().unmake_fullscreen(); await sl(4500); return 1' >/dev/null
  assert "$mode: leaving during the slide ends on workspace 0" "!kwin('org.x2.FsApp').is_fullscreen() && kwin('org.x2.FsApp').get_workspace().index()===0 && global.workspace_manager.get_active_workspace_index()===0"
  assert "$mode: interrupted, no stray workspace" "global.workspace_manager.n_workspaces===$AFTER"
  # Leave before the isolate timer: nothing ever moves
  J 'W().make_fullscreen(); await sl(250); W().unmake_fullscreen(); await sl(2500); return 1' >/dev/null
  assert "$mode: a short full screen never moves the window" "kwin('org.x2.FsApp').get_workspace().index()===0 && global.workspace_manager.get_active_workspace_index()===0"
}

gsettings set org.gnome.mutter dynamic-workspaces true; sleep 2
run_mode dynamic
gsettings set org.gnome.desktop.wm.preferences num-workspaces 3
gsettings set org.gnome.mutter dynamic-workspaces false; sleep 2
run_mode static
gsettings set org.gnome.mutter dynamic-workspaces true; sleep 1
gs stage-manager true

assert_summary
