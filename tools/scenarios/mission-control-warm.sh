# mission-control-warm.sh: Q2 (B39). The first Mission Control open of a session answers within 250 ms because the
# overview is painted once, invisibly, while the Shell is idle (features/missionControl/warm.js). Checks:
#   - the warm-up runs (the overview group is shown while the overview is closed) and is invisible (opacity <= 1)
#   - it never emits Overview 'showing' / 'hidden' (the dock, Stage Manager, notch would flicker)
#   - it puts everything back (group hidden and opaque, no workspace views, no thumbnails)
#   - the first real open's first painted frame is < 250 ms
# Bundle:  K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh tools/scenarios/mission-control-warm.sh
force_animations on >/dev/null
_kjs "
const g=Main.layoutManager.overviewGroup;
globalThis.__w={show:0,hide:0,seen:0,maxOp:0};
Main.overview.connect('showing',()=>globalThis.__w.show++);
Main.overview.connect('hidden',()=>globalThis.__w.hide++);
global.stage.connect('after-paint',()=>{ if(g.visible&&!Main.overview.visible){ __w.seen++; __w.maxOp=Math.max(__w.maxOp,g.opacity); } });
return 1" >/dev/null
sleep 16
assert warm-ran "inst('mission-control').warmup?.frames>=1 && !inst('mission-control').warmup.tookOver"
assert warm-invisible "__w.maxOp<=1"
assert warm-no-showing "__w.show===0&&__w.hide===0"
assert warm-undone "!Main.layoutManager.overviewGroup.visible&&Main.layoutManager.overviewGroup.opacity===255&&!Main.overview.visible"
assert warm-views-gone "Main.overview._overview.controls._workspacesDisplay._workspacesViews.length===0&&Main.overview._overview.controls._thumbnailsBox._thumbnails.length===0"
r=$(_kjs "
const t0=GLib.get_monotonic_time(); let hit=0;
const sid=global.stage.connect('after-paint',()=>{if(!hit)hit=GLib.get_monotonic_time();});
Main.overview.show();
for(let k=0;k<40&&!hit;k++) await new Promise(r=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,25,()=>{r();return GLib.SOURCE_REMOVE;}));
global.stage.disconnect(sid);
return 'COLDRES '+((hit-t0)/1000).toFixed(1);" | grep -o 'COLDRES [0-9.]*' | head -1)
echo "COLD first-open ${r#COLDRES } ms"
_kjs "Main.overview.hide(); return 1" >/dev/null; sleep 1.5
assert first-open-under-250 "${r#COLDRES } < 250"
assert real-open-still-showing "__w.show===1"
assert_summary
