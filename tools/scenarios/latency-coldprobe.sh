# latency-coldprobe.sh: L19 (B35). Where the cold first open spends its time. For Notification Center and the
# overview, on a fresh login: the synchronous JS time of open() and the time to the first painted frame after
# it, for the first and the second open. Bundle:
#   K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh tools/scenarios/latency-coldprobe.sh
# Prints COLD <what> sync=<ms> first_paint=<ms>.
force_animations on >/dev/null
sleep 8
_cold() { # label  open_js  close_js
  local r
  r=$(_kjs "
const t0=GLib.get_monotonic_time(); let hit=0;
const sid=global.stage.connect('after-paint',()=>{if(!hit)hit=GLib.get_monotonic_time();});
$2
const sync=(GLib.get_monotonic_time()-t0)/1000;
for(let k=0;k<40&&!hit;k++) await new Promise(r=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,25,()=>{r();return GLib.SOURCE_REMOVE;}));
global.stage.disconnect(sid);
return 'COLDRES sync='+sync.toFixed(1)+' first_paint='+((hit-t0)/1000).toFixed(1);" | grep -o 'COLDRES [^"]*' | head -1)
  echo "COLD $1 ${r#COLDRES }"
  _kjs "$3" >/dev/null; sleep 1.5
}
for i in 1 2 3; do
  _cold "nc-open-$i" "inst('notification-center').open();" "inst('notification-center').close();"
done
if [ "${WARM:-0}" = 1 ]; then
  # the warm-up under test: the overview opens once with its group invisible, then closes
  _kjs "const g=Main.layoutManager.overviewGroup; g.opacity=1; Main.overview.show(); await sl(900); Main.overview.hide(); await sl(900); g.opacity=255; return 1" >/dev/null
fi
for i in 1 2 3; do
  _cold "overview-show-$i" "Main.overview.show();" "Main.overview.hide();"
done
assert_summary
