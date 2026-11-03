# Scenario for the real-Shell harness (GUAVA_EXTRA; bundle with tools/harness/lib/lib.sh first,
# see tools/harness/README.md). B14: a window minimized into the Dock is not in Mission
# Control's spread (as on macOS); App Exposé still shows it in its minimized strip; a window
# minimized or restored while Mission Control is open leaves or joins the spread.
force_animations on
gs stage-manager false
sleep 1
# org.x2.TestB: the harness opens it (inner-real.sh)
H='const mc=inst("mission-control");
const anyw=c=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()===c);
const spread=()=>{const o=[];const f=a=>{if(a.constructor.name==="WindowPreview"&&a.visible)o.push(a.metaWindow.get_wm_class());a.get_children().forEach(f)};f(Main.layoutManager.overviewGroup);return o};
const strip=()=>{let s=null;const f=a=>{if(a.name==="guava-mc-expose-strip")s=a;a.get_children().forEach(f)};f(global.stage);return s};'
J() { _kjs "$H $1"; }
E=org.gnome.TextEditor
B=org.x2.TestB

echo "-- B14 Mission Control leaves minimized windows in the Dock"
J "anyw('$E').minimize(); await sl(1200); mc.showMissionControl(); await sl(1800); globalThis.__sp=spread(); return JSON.stringify(globalThis.__sp)"
assert "mc-spread-excludes-minimized" "!globalThis.__sp.includes('$E') && globalThis.__sp.includes('$B')"
J "Main.overview.hide(); await sl(1500); return 1" >/dev/null
shot mc-minimized-spread

echo "-- B14 App Exposé keeps its minimized strip"
J "anyw('$E').unminimize(); await sl(900); const w=anyw('$E'); w.activate(global.get_current_time()); await sl(500); w.minimize(); await sl(1200); mc.showAppExpose('org.gnome.TextEditor.desktop'); await sl(1800); globalThis.__st=strip(); globalThis.__n=globalThis.__st?.get_n_children()??0; globalThis.__sp=spread(); return 'strip='+globalThis.__n+' spread='+JSON.stringify(globalThis.__sp)"
assert "expose-strip-shows-minimized" "globalThis.__n===1 && !globalThis.__sp.includes('$E')"
J "Main.overview.hide(); await sl(1500); anyw('$E').unminimize(); await sl(900); return 1" >/dev/null

echo "-- B14 minimized or restored while Mission Control is open"
J "mc.showMissionControl(); await sl(1800); const a=spread(); anyw('$B').minimize(); await sl(1000); const b=spread(); anyw('$B').unminimize(); await sl(1000); const c=spread(); Main.overview.hide(); await sl(1500); globalThis.__live=[a,b,c]; return JSON.stringify(globalThis.__live)"
assert "mc-spread-follows-minimize" "(n=>n(0)>0 && n(1)===n(0)-1 && n(2)===n(0))(i=>globalThis.__live[i].filter(c=>c==='$B').length)"
assert "mc-closed-clean" "!Main.overview.visible && Main.modalCount===0"
assert_summary
