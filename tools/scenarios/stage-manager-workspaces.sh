# Stage Manager: workspaces (RV1-3 the strip does not slide on workspace add/remove, RV1-4 removing a
# middle workspace keeps the stages of the workspaces after it). Bundle after stage-manager-lib.sh.
echo "-- SM workspaces"
force_animations on
_kjs 'new Gio.Settings({schema_id:"org.gnome.mutter"}).set_boolean("dynamic-workspaces", false); const wm=global.workspace_manager; while (wm.n_workspaces<3) wm.append_new_workspace(false, global.get_current_time()); await sl(500); return "NWS"+wm.n_workspaces' | grep -o "NWS.*" | head -1
sm_up A B C

# sm_ws_round WANT: B and C onto the last workspace (A stays on 0), WANT (B or C) is its stage,
# then the empty workspace in front of it is removed
sm_ws_round() {
  local want=$1 other
  other=$([ "$want" = B ] && echo C || echo B)
  _kjs 'const wm=global.workspace_manager; const t=wm.n_workspaces-1; for (const x of ["B","C"]) aw(sid(x)).meta_window.change_workspace_by_index(t,false); await sl(800); wm.get_workspace_by_index(t).activate(global.get_current_time()); await sl(1500); return "MV"+t+" n="+wm.n_workspaces' | grep -o "MV.*" | head -1
  # the stage is the other one: click its thumbnail
  if [ "$(_kjs 'return "ON"+onStage(sid("'$want'"))' | grep -o 'ON[a-z]*')" != ONtrue ]; then click_actor "cardOf('SM $want')"; sleep 1.8; fi
  sm_state
  assert "pre($want): $want is the stage, $other in the strip" "onStage(sid('$want')) && inStrip(sid('$other'))"
  _kjs 'const wm=global.workspace_manager; const t=wm.n_workspaces-1; wm.remove_workspace(wm.get_workspace_by_index(t-1), global.get_current_time()); await sl(1500); return "RM n="+wm.n_workspaces+" active="+wm.get_active_workspace_index()+" B="+aw(sid("B")).meta_window.get_workspace().index()+" C="+aw(sid("C")).meta_window.get_workspace().index()+" sw="+globalThis.__sw' | grep -o "RM.*" | head -1
  sm_state
  assert "RV1-4($want) $want is still the stage" "onStage(sid('$want'))"
  assert "RV1-4($want) $other is still in the strip" "inStrip(sid('$other')) && cards().length===1"
}
echo "-- RV1-3/RV1-4 remove the workspace in front of a stage, C being the stage"
sm_ws_round C
echo "-- same, B being the stage"
_kjs 'const wm=global.workspace_manager; wm.append_new_workspace(false, global.get_current_time()); await sl(500); return 1' >/dev/null
sm_ws_round B

echo "-- RV1-3 the strip slides in again on a workspace switch, not when a workspace is added or removed"
_kjs 'const v=inst("stage-manager")._view; globalThis.__replays=0; const orig=v.replay.bind(v); v.replay=()=>{globalThis.__replays++; return orig()}; globalThis.__restoreReplay=()=>{delete v.replay}; return 1' >/dev/null
_kjs 'const wm=global.workspace_manager; wm.append_new_workspace(false, global.get_current_time()); await sl(800); return 1' >/dev/null
assert "RV1-3 adding a workspace does not replay the strip slide" "globalThis.__replays===0"
_kjs 'const wm=global.workspace_manager; wm.remove_workspace(wm.get_workspace_by_index(wm.n_workspaces-1), global.get_current_time()); await sl(800); return 1' >/dev/null
assert "RV1-3 removing a workspace behind the active one does not replay it" "globalThis.__replays===0"
_kjs 'const wm=global.workspace_manager; wm.get_workspace_by_index(0).activate(global.get_current_time()); await sl(800); return 1' >/dev/null
assert "RV1-3 a real workspace switch replays it once" "globalThis.__replays===1"
_kjs 'globalThis.__restoreReplay(); return 1' >/dev/null
sm_down
_kjs 'new Gio.Settings({schema_id:"org.gnome.mutter"}).reset("dynamic-workspaces"); return 1' >/dev/null
assert_summary
