# Scenario for the real-Shell harness (GUAVA_EXTRA). Lock invariant (D-018, F2 audit RV2-2/5/6/10, RV4-5):
# while the screen is locked nothing of Guava is visible or reactive, whatever tries to show it, and an
# unlock gives back exactly what was there (the dock stays hidden over a full-screen window).
# Bundle: K=tools/harness/lib; $K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/lock-lifecycle.sh
# The harness has no screen shield here: the 'unlock-dialog' mode is pushed on Main.sessionMode, which is what
# the Shell does on a lock.
force_animations on
cat > $W/fsapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.LockFs'});
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:'Lock Fs',default_width:700,default_height:450});
  w.set_child(new Gtk.Label({label:'video'})); w.present();
});
app.run([]);
EOF2
gs stage-manager false
gs move-window-to-new-workspace false
sleep 2
GS='const gv=()=>{const out=[];const walk=(a,d)=>{if(!a.visible)return;const n=(a.name||"")+" "+(a.style_class||"");if(/guava/i.test(n)&&a!==Main.panel&&a!==Main.layoutManager.uiGroup)out.push(a);if(d<9)a.get_children().forEach(c=>walk(c,d+1));};walk(Main.layoutManager.uiGroup,0);return out;};
const names=()=>gv().map(a=>a.name+"/"+a.style_class).join(" ; ");
const ctx=()=>inst("lock-screen")._ctx;
const tracked=()=>Main.layoutManager._trackedActors.filter(d=>d.trackFullscreen&&/guava/.test(d.actor.name||""));
const lock=()=>Main.sessionMode.pushMode("unlock-dialog");
const unlock=()=>Main.sessionMode.popMode("unlock-dialog");'
_KJS_PRE="$_KJS_PRE
$GS"
G() { _kjs "$1"; }

launch_app "gjs $W/fsapp.js" org.x2.LockFs 40
sleep 2; focus_app org.x2.LockFs; sleep 1
G 'kwin("org.x2.LockFs").make_fullscreen(); await sl(2500); return 1' >/dev/null
echo "LOCKLC tracked chrome: $(G 'return JSON.stringify(tracked().map(d=>[d.actor.name,d.actor.visible]))')"
assert "RV2-2 full screen: the window is full screen and the Guava chrome the Shell tracks is hidden" "kwin('org.x2.LockFs').is_fullscreen() && tracked().length>0 && tracked().every(d=>!d.actor.visible)"

# RV2-5: a fade running on a Guava surface at the moment of the lock
G 'globalThis.__ease=Main.layoutManager.uiGroup.get_children().find(a=>/guava/.test(a.name||"")&&a.visible&&!tracked().some(d=>d.actor===a)); return !!globalThis.__ease' >/dev/null
echo "LOCKLC ease target: $(G 'return globalThis.__ease?.name')"
G 'if(globalThis.__ease) ctx().motion.ease(globalThis.__ease,{opacity:120},{duration:3000}); return 1' >/dev/null

echo "-- lock"
G 'lock(); return 1' >/dev/null
sleep 0.5
echo "LOCKLC visible while locked: $(G 'return names()')"
assert "lock: nothing of Guava visible" "gv().length===0"

echo "-- the Shell's own visibility pass while locked (monitors-changed, fullscreen change)"
G 'Main.layoutManager._updateVisibility(); Main.layoutManager.emit("monitors-changed"); return 1' >/dev/null
sleep 0.5
echo "LOCKLC after Shell pass: $(G 'return names()')"
assert "RV2-2 the dock does not pop over the lock screen when the Shell re-runs its chrome pass" "gv().length===0"

echo "-- an ease on a hidden Guava surface (RV2-5)"
G 'const a=globalThis.__ease; if(a){ctx().motion.ease(a,{opacity:0},{duration:100}); await sl(300); ctx().motion.ease(a,{opacity:255},{duration:300});} await sl(600); return 1' >/dev/null
assert "RV2-5 a fade-in does not unhide a suspended surface" "gv().length===0 && (!globalThis.__ease || !globalThis.__ease.visible)"

echo "-- chrome that appears while locked is swept as it arrives"
G 'const a=new St.Widget({name:"guava-late-chrome",width:50,height:50}); Main.layoutManager.uiGroup.add_child(a); globalThis.__late=a; await sl(800); return 1' >/dev/null
assert "RV2-5 a Guava-named actor added while locked is hidden" "!globalThis.__late.visible && gv().length===0"

echo "-- volume key while locked (RV2-6, RV4-5)"
G 'Main.osdWindowManager.showOne(Main.layoutManager.primaryIndex, Gio.ThemedIcon.new("audio-volume-high-symbolic"), "Volume", 0.6, 1); await sl(700); return 1' >/dev/null
echo "LOCKLC osd windows: $(G 'return JSON.stringify(Main.osdWindowManager._osdWindows.map(w=>[w.visible,w.opacity]))')"
assert "RV2-6 the stock OSD answers the key on the lock screen" "Main.osdWindowManager._osdWindows[Main.layoutManager.primaryIndex].visible"
assert "RV4-5 no Guava pill or notch content appeared" "gv().length===0"

echo "-- Caps Lock while locked (RV4-5)"
key Caps_Lock; sleep 1
echo "LOCKLC after caps: $(G 'return names()')"
assert "RV4-5 the input indicator does not draw on the lock screen" "gv().length===0"
key Caps_Lock; sleep 0.5

echo "-- a timer that rings while locked (RV2-10)"
G 'globalThis.__tid=ctx().timers.startTimer({seconds:2,label:"Lock tea"}); await sl(3500); return 1' >/dev/null
echo "LOCKLC timers: $(G 'return JSON.stringify(ctx().timers.list().map(t=>[t.id,t.state]))')"
assert "RV2-10 the ringing timer waits for the unlock (not dismissed)" "ctx().timers.list().some(t=>t.state==='finished')"

echo "-- unlock"
G 'unlock(); return 1' >/dev/null
sleep 1.5
echo "LOCKLC visible after unlock: $(G 'return names()')"
assert "RV2-2 after unlock the Guava chrome is still hidden over the full-screen window" "tracked().length>0 && tracked().every(d=>!d.actor.visible)"
assert "RV2-10 the timer alert was shown at the unlock and dismissed" "!ctx().timers.list().some(t=>t.state==='finished')"
assert "unlock: the late chrome came back" "globalThis.__late.visible"
G 'globalThis.__late.destroy(); kwin("org.x2.LockFs").unmake_fullscreen(); await sl(1500); return 1' >/dev/null
assert "leaving full screen shows the dock again" "tracked().length>0 && tracked().some(d=>d.actor.visible)"

echo "-- RV2-10: the Timer done pill shows at the unlock (no full-screen window now, so the notch is visible)"
G 'lock(); ctx().timers.startTimer({seconds:2,label:"Pill tea"}); await sl(3500); return 1' >/dev/null
assert "RV2-10 still waiting while locked" "ctx().timers.list().some(t=>t.state==='finished') && gv().length===0"
G 'unlock(); return 1' >/dev/null
sleep 1
echo "LOCKLC after second unlock: $(G 'return names()')"
assert "RV2-10 the Timer done pill is on screen after the unlock" "names().includes('timer-done')"
assert_summary
