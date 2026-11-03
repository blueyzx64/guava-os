# Scenario for the real-Shell harness (GUAVA_EXTRA). Lock screen (L14, B21, D-018/D-022).
# Bundle: K=tools/harness/lib; $K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/lock-screen.sh
# The harness has no real lock screen: the 'unlock-dialog' session mode is pushed on Main.sessionMode, which is
# what the Shell does on a lock (extensionSystem re-evaluates every extension for the new mode).
# Checks: Guava stays ENABLED; its surfaces hide and go inert while locked, come back at once on unlock;
# an open modal closes on lock; lock and unlock cost; no Guava errors.
force_animations on
sleep 0.3
GS='const gv=()=>{const out=[];const walk=(a,d)=>{if(!a.visible)return;const n=(a.name||"")+" "+(a.style_class||"");if(/guava/i.test(n)&&a!==Main.panel&&a!==Main.layoutManager.uiGroup)out.push(a);if(d<9)a.get_children().forEach(c=>walk(c,d+1));};walk(Main.layoutManager.uiGroup,0);return out;};
const ext=()=>Main.extensionManager.lookup("guava-os@blueyzx64");'
_KJS_PRE="$_KJS_PRE
$GS"
G() { _kjs "$1"; }

echo "NOTCH rows: $(G 'return JSON.stringify(globalThis.__x2startup?.trace.actors["guava-notch"])')"
echo "MC state: $(G 'return JSON.stringify([inst("mission-control")?.startupState, inst("mission-control")?.startupSkipped, typeof Main.overview.runStartupAnimation, Main.overview.runStartupAnimation.toString().slice(0,300)])')"
echo "NOTCH sources: $(G 'return JSON.stringify(Main.messageTray.getSources().map(s=>s.title+": "+s.notifications.map(n=>n.title+"/"+n.body).join("|")))')"
BEFORE=$(G "return gv().length" | grep -o "[0-9]*" | head -1)
echo "LOCK before: $(G 'return gv().map(a=>a.name+"/"+a.style_class).join(" ; ")')"
echo "LOCK visible guava actors before: $BEFORE"
assert "L14 metadata declares unlock-dialog" "ext().sessionModes.includes('unlock-dialog')"
assert "L14 some Guava surface is visible" "gv().length>0"

echo "-- lock"
G "const t0=GLib.get_monotonic_time(); Main.sessionMode.pushMode('unlock-dialog'); global.__lockMs=(GLib.get_monotonic_time()-t0)/1000; return 1" >/dev/null
sleep 1
echo "LOCK push cost ms: $(G 'return global.__lockMs')"
assert "L14 Guava still ENABLED while locked" "ext().state===1 && !!ext().stateObj._features"
assert "L14 session says locked" "ext().stateObj._session.locked===true && Main.sessionMode.isLocked"
echo "LOCK visible while locked: $(G 'return gv().map(a=>a.name+"/"+a.style_class).join(" ; ")')"
assert "L14 every Guava surface hidden while locked" "gv().length===0"
assert "L14 the registry is locked" "ext().stateObj._features.locked===true"
shot locked

echo "-- unlock"
G "const t0=GLib.get_monotonic_time(); Main.sessionMode.popMode('unlock-dialog'); global.__unlockMs=(GLib.get_monotonic_time()-t0)/1000; return 1" >/dev/null
echo "UNLOCK pop cost ms: $(G 'return global.__unlockMs')"
sleep 1
assert "L14 Guava still ENABLED after unlock" "ext().state===1 && ext().stateObj._session.locked===false"
echo "LOCK visible guava actors after: $(G 'return gv().length')"
assert "L14 surfaces back as they were" "gv().length===$BEFORE"
shot unlocked

echo "-- lock, unlock x5: no leak, no error"
for i in 1 2 3 4 5; do
  G "Main.sessionMode.pushMode('unlock-dialog'); return 1" >/dev/null; sleep 0.3
  G "Main.sessionMode.popMode('unlock-dialog'); return 1" >/dev/null; sleep 0.3
done
echo "LOCK after cycles: $(G 'return gv().map(a=>a.name+"/"+a.style_class).join(" ; ")')"
assert "L14 still the same surfaces after 5 cycles" "gv().length===$BEFORE"

echo "-- Spotlight open at lock closes"
G "inst('spotlight')?.toggle?.(); return 1" >/dev/null; sleep 1
G "Main.sessionMode.pushMode('unlock-dialog'); return 1" >/dev/null; sleep 0.5
assert "L14 the open modal closed on lock" "!(inst('spotlight')?._modal?.isOpen)"
G "Main.sessionMode.popMode('unlock-dialog'); return 1" >/dev/null; sleep 0.5
assert_summary
