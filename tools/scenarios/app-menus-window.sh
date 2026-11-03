# Scenario for the real-Shell harness (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh).
# The menu bar's Window menu, driven by real pointer clicks on the Text Editor window:
#   B7  Always on Top pins the window the menu was opened for and the check mark follows,
#       with Stage Manager off and on (a pinned stage window must keep the stage and focus)
#   B6  Move to Workspace > New Workspace leaves the window alone on a new workspace and the
#       user follows it there, with static Spaces and with GNOME's dynamic workspaces
#   B5  Fill, Move & Resize > Top Left, Return to Previous Size; Always on Visible Workspace
force_animations on
sleep 1
H='const kc=async(a)=>{const [x,y]=a.get_transformed_position();const [w,h]=a.get_transformed_size();await kclick(Math.round(x+w/2),Math.round(y+h/2));};
const apps=()=>inst("menu-bar")?.part("apps");
const btn=id=>apps()._buttons.find(b=>b.def?.id===id);
const items=m=>m._getMenuItems().flatMap(i=>i.menu&&i.menu!==m&&i.menu._getMenuItems?[i,...items(i.menu)]:[i]);
const find=(id,label)=>items(btn(id).menu).find(i=>i.label?.text===label);
const ed=()=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()==="org.gnome.TextEditor");
const home=async()=>{const w=ed();const ws=global.workspace_manager.get_workspace_by_index(0);w.change_workspace(ws);ws.activate_with_focus(w,global.get_current_time());await sl(1500);};
const pick=async(label,sub)=>{await kc(btn("window")); await sl(700); if(sub){const s=find("window",sub); if(!s.menu?.isOpen){await kc(s); await sl(600);}} const it=find("window",label); if(!it) return "NOITEM"; const orn=it._ornament; globalThis.__orn=orn; const [,iy]=it.get_transformed_position(); if(iy+it.height<global.stage.height-4) await kc(it); else it.activate(Clutter.get_current_event()); await sl(1500); return "orn="+orn;};
const onNew=()=>{const w=ed();const ws=w.get_workspace();const wm=global.workspace_manager;return ws.index()>0&&ws.list_windows().filter(x=>x.get_window_type()===Meta.WindowType.NORMAL).length===1&&wm.get_active_workspace_index()===ws.index()&&global.display.focus_window===w;};'
J() { _kjs "$H $1"; }
for sm in false true; do
  gs stage-manager $sm; sleep 2
  J 'await home(); return 1' >/dev/null
  echo "-- B7 Always on Top (stage manager $sm)"
  J 'return await pick("Always on Top")'
  assert "B7 pinned, focus kept (sm=$sm)" "kwin('org.gnome.TextEditor')?.is_above() && global.display.focus_window?.get_wm_class()==='org.gnome.TextEditor'"
  J 'return await pick("Always on Top")'
  assert "B7 check mark showed, unpinned (sm=$sm)" "globalThis.__orn===2 && !kwin('org.gnome.TextEditor').is_above()"
done
gs stage-manager false; sleep 2
echo "-- B6 New Workspace, static Spaces"
J 'await home(); return await pick("New Workspace","Move to Workspace")'
assert "B6 static: alone on a new workspace, followed" "(()=>{$H; return onNew()})()"
shot b6-static
gs mc-static-spaces false; sleep 1
gsettings set org.gnome.mutter dynamic-workspaces true; sleep 2
echo "-- B6 New Workspace, dynamic workspaces"
J 'await home(); return await pick("New Workspace","Move to Workspace")'
assert "B6 dynamic: alone on a new workspace, followed" "(()=>{$H; return onNew()})()"
J 'await home(); return 1' >/dev/null
echo "-- B5 Fill, Move & Resize, Return to Previous Size, Always on Visible Workspace"
J 'globalThis.__r0=ed().get_frame_rect(); return await pick("Fill")'
assert "B5 Fill covers the work area" "(()=>{const w=kwin('org.gnome.TextEditor');const r=w.get_frame_rect();const a=w.get_work_area_current_monitor();return r.width>=a.width-40&&r.height>=a.height-40;})()"
J 'return await pick("Top Left","Move & Resize")'
assert "B5 Top Left is the top-left quarter" "(()=>{const w=kwin('org.gnome.TextEditor');const r=w.get_frame_rect();const a=w.get_work_area_current_monitor();return r.x<a.x+40&&r.y<a.y+40&&r.width<a.width*0.6&&r.height<a.height*0.6;})()"
J 'return await pick("Return to Previous Size","Move & Resize")'
assert "B5 Return to Previous Size" "(()=>{const r=kwin('org.gnome.TextEditor').get_frame_rect();return Math.abs(r.width-globalThis.__r0.width)<40&&Math.abs(r.height-globalThis.__r0.height)<40;})()"
J 'return await pick("Always on Visible Workspace")'
assert "B5 Always on Visible Workspace sticks" "kwin('org.gnome.TextEditor').is_on_all_workspaces()"
J 'return await pick("Always on Visible Workspace")'
assert "B5 and unsticks" "!kwin('org.gnome.TextEditor').is_on_all_workspaces()"
assert "menus closed, no modal grab" "Main.modalCount===0"
assert_summary
