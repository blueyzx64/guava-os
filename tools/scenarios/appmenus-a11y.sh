# Scenario (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh): D-014, accessibility for app menus.
#   1. appmenus-accessibility (default on): Guava owns toolkit-accessibility = true, and the user's
#      value comes back when the key is turned off.
#   2. With the AT-SPI providers on, a libadwaita app (Text Editor, no menu bar) gets its primary
#      menu read: first read time, cached read time, no stuck popover (modal grab, focus kept).
gsettings reset org.gnome.desktop.interface toolkit-accessibility
sleep 1
GI='gsettings get org.gnome.desktop.interface toolkit-accessibility'
echo "A11Y user value before toggling: $($GI)"
gs appmenus-accessibility false; sleep 1
gs appmenus-accessibility true; sleep 2
echo "A11Y owned: $($GI)"
[ "$($GI)" = true ] && echo "A11Y PASS owned" || echo "A11Y FAIL not owned"
gs appmenus-accessibility false; sleep 2
[ "$($GI)" = false ] && echo "A11Y PASS user value back" || echo "A11Y FAIL not restored: $($GI)"
gs appmenus-accessibility true; sleep 2

gs menubar-atspi-menus true; gs menubar-atspi-popovers true; sleep 2
# kill() ends exactly this session's Text Editor (pkill would hit other roots and the host)
P "global.get_window_actors().map(a=>a.meta_window).filter(w=>w.get_wm_class()==='org.gnome.TextEditor').forEach(w=>w.kill()); return 1" >/dev/null; sleep 2
launch_app "env NO_AT_BRIDGE=0 GTK_A11Y=atspi gnome-text-editor --standalone" org.gnome.TextEditor 40
sleep 3
H='const win=()=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()==="org.gnome.TextEditor");
const svc=()=>inst("menu-bar").part("apps")._service;'
read_menus() {
  _kjs "$H"' const w=win(); w.activate(global.get_current_time()); await sl(800); const s=svc(); const t=s.targetFor(w); s.invalidate(t); const provs=s._providers.map(p=>p.id).join(); const t0=GLib.get_monotonic_time(); const r=await s.results(t); const ms1=(GLib.get_monotonic_time()-t0)/1000; const t1=GLib.get_monotonic_time(); await s.results(t); const ms2=(GLib.get_monotonic_time()-t1)/1000; await sl(1500); return JSON.stringify({provs,pid:t.pid,ms1:Math.round(ms1),ms2:Math.round(ms2),menus:r.menus.length,items:r.menus.flatMap(m=>m.items).length,bar:r.menubar.length,modal:Main.modalCount,focus:global.display.focus_window?.get_wm_class()});'
}
for i in 1 2; do echo "A11Y read $i: $(read_menus)"; done
assert "no stuck popover: no modal grab, editor focused" "Main.modalCount===0 && global.display.focus_window?.get_wm_class()==='org.gnome.TextEditor'"
gs menubar-atspi-menus false; gs menubar-atspi-popovers false
assert_summary
