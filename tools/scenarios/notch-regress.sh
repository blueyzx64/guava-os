# Scenario for the real-Shell harness (GUAVA_EXTRA). Notch regressions (L3: B8, B4).
# Bundle: K=tools/harness/lib; $K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/notch-regress.sh
#   B8  a download whose sender vanishes (browser closed / crashed) leaves the notch at once
#   B8  a partial file left behind weeks ago (interrupted download) never shows; a fresh one does
DL='const dl=()=>inst("notch")?._state.activities.find(a=>a.key==="download")?.data??null;'
N() { _kjs "$DL $1"; }
force_animations on
sleep 1

echo "-- B8 LauncherEntry sender that vanishes"
cat > $W/dlsender.js <<'EOF2'
const {Gio,GLib}=imports.gi;
const bus=Gio.bus_get_sync(Gio.BusType.SESSION,null);
let p=0.2;
const emit=()=>{bus.emit_signal(null,'/com/x2/dl','com.canonical.Unity.LauncherEntry','Update',
  new GLib.Variant('(sa{sv})',['application://org.gnome.Nautilus.desktop',{'progress':new GLib.Variant('d',p),'progress-visible':new GLib.Variant('b',true)}]));
  bus.flush_sync(null); p=Math.min(0.9,p+0.01);};
emit();
GLib.timeout_add(GLib.PRIORITY_DEFAULT,1000,()=>{emit();return GLib.SOURCE_CONTINUE;});
new GLib.MainLoop(null,false).run();
EOF2
gjs $W/dlsender.js 9>&- >$W/dlsender.log 2>&1 &
DLPID=$!
wait_for "inst('notch')?._state.activities.some(a=>a.key==='download')" 10
assert "B8 a live progress bar shows" "inst('notch')._state.activities.find(a=>a.key==='download')?.data?.fraction>0"
kill $DLPID; wait $DLPID 2>/dev/null
sleep 2
assert "B8 its sender left the bus: the download is gone" "!inst('notch')._state.activities.some(a=>a.key==='download')"
# A one-shot sender: gdbus emits and disconnects at once
gdbus emit --session --object-path /com/x2/dl --signal com.canonical.Unity.LauncherEntry.Update \
  "'application://org.gnome.Nautilus.desktop'" "{'progress': <0.5>, 'progress-visible': <true>}" >/dev/null 2>&1
sleep 2
assert "B8 a sender gone before we watched it leaves nothing" "!inst('notch')._state.activities.some(a=>a.key==='download')"

echo "-- B8 stale partial files"
# The harness home has no user-dirs.dirs: give it a Downloads folder and make the Shell re-read it
DLDIR=$HOME/Downloads
mkdir -p "$DLDIR" "${XDG_CONFIG_HOME:-$HOME/.config}"
echo 'XDG_DOWNLOAD_DIR="$HOME/Downloads"' > "${XDG_CONFIG_HOME:-$HOME/.config}/user-dirs.dirs"
echo "downloads dir: $(P "GLib.reload_user_special_dirs_cache(); return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD)")"
head -c 4096 /dev/zero > "$DLDIR/old-install.iso.part"
touch -d '21 days ago' "$DLDIR/old-install.iso.part"
gs notch-activity-downloads false; sleep 1; gs notch-activity-downloads true; sleep 3
assert "B8 a partial file from 3 weeks ago is not shown" "!inst('notch')._state.activities.some(a=>a.key==='download')"
head -c 1000 /dev/zero > "$DLDIR/fresh.iso.part"
sleep 2
assert "B8 a fresh partial file shows" "inst('notch')._state.activities.find(a=>a.key==='download')?.data?.label==='fresh.iso'"
rm -f "$DLDIR/fresh.iso.part"; sleep 2
assert "B8 removed: gone" "!inst('notch')._state.activities.some(a=>a.key==='download')"
rm -f "$DLDIR/old-install.iso.part"

# ---- B4: the notch and the bar --------------------------------------------------------------
NB='const ui=Main.layoutManager.uiGroup; const idx=a=>ui.get_children().indexOf(a);
const named=p=>{let n=0;const w=a=>{if((a.name||"").startsWith(p))n++;a.get_children().forEach(w)};w(global.stage);return n;};'
B() { _kjs "$NB $1"; }
# Nothing else in the notch while we hover
gs notch-live-activities false
B 'await kmove(640,600); await sl(1500); return 1' >/dev/null

echo "-- B4 hover open / close"
B 'await kmove(640,14); await kmove(641,15); await sl(1200); return 1' >/dev/null
assert "B4 resting on the notch opens it (hover)" "inst('notch')._state.dashboard?.by==='hover'"
shot b4-hover-open
B 'await kmove(640,600); await sl(1800); return 1' >/dev/null
assert "B4 leaving closes it" "inst('notch')._state.dashboard===null && !inst('notch')._state.hover"
assert "B4 closed shape is the idle pill" "(()=>{const a=inst('notch')._view._island;return Math.round(a.width)===190&&Math.round(a.height)===32})()"

echo "-- B4 hover spam"
B 'for(let i=0;i<24;i++){await kmove(600+(i%5)*20,12); await sl(30+(i*37)%300); await kmove(600+(i%5)*20,400); await sl(20+(i*53)%250);} await kmove(640,600); await sl(2500); return 1' >/dev/null
assert "B4 hover spam ends closed" "inst('notch')._state.dashboard===null && !inst('notch')._state.hover"
assert "B4 hover spam: idle shape, centred" "(()=>{const a=inst('notch')._view._island;const m=Main.layoutManager.primaryMonitor;return Math.round(a.width)===190&&Math.round(a.height)===32&&Math.abs(a.x+a.width/2-(m.x+m.width/2))<1})()"
B 'for(let i=0;i<12;i++){await kmove(640,12); await sl(330+(i%3)*60); await kmove(640,500); await sl(90+(i%4)*40);} await kmove(640,500); await sl(2500); return 1' >/dev/null
assert "B4 open/close mid-animation spam ends closed" "inst('notch')._state.dashboard===null && (()=>{const a=inst('notch')._view._island;return Math.round(a.width)===190&&Math.round(a.height)===32})()"
assert "B4 no modal grab, no key focus left in the notch" "Main.modalCount===0 && !inst('notch')._view._captureId"

echo "-- B4 click pins, Escape and outside click close"
B 'await kclick(640,14); await sl(900); return 1' >/dev/null
assert "B4 click opens a pinned dashboard" "inst('notch')._state.dashboard?.by==='click'"
B 'await kmove(640,600); await sl(1000); return 1' >/dev/null
assert "B4 pinned outlasts the hover leave time" "inst('notch')._state.dashboard?.by==='click'"
B 'await kkey(["Escape"]); await sl(900); return 1' >/dev/null
assert "B4 Escape closes it" "inst('notch')._state.dashboard===null && !inst('notch')._view._captureId"
B 'await kclick(640,14); await sl(900); await kclick(200,500); await sl(900); return 1' >/dev/null
assert "B4 an outside click closes it" "inst('notch')._state.dashboard===null"

echo "-- B4 z-order"
assert "B4 the notch sits below modal dialogs" "(()=>{const k=Main.layoutManager.uiGroup.get_children();return k.indexOf(inst('notch')._view._island)<k.indexOf(Main.layoutManager.modalDialogGroup)})()"
B 'Main.screenshotUI.open().catch(()=>{}); await sl(1500); return 1' >/dev/null
shot b4-screenshot-ui
assert "B4 the notch is not above the screenshot UI" "(()=>{const k=Main.layoutManager.uiGroup.get_children();return k.indexOf(inst('notch')._view._island)<k.indexOf(Main.layoutManager.screenshotUIGroup)})()"
B 'Main.screenshotUI.close(true); await sl(800); return 1' >/dev/null

echo "-- B4 banners"
gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.Notify Probe 0 "" "Probe one" "first banner" [] {} 5000 >/dev/null
sleep 1.2
assert "B4 a banner shows in the notch" "inst('notch')._state.current!==null"
B 'await kmove(640,600); await sl(9000); return 1' >/dev/null
B 'await kclick(640,14); await sl(600); return 1' >/dev/null
gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.Notify Probe 0 "" "Probe two" "while open" [] {} 5000 >/dev/null
sleep 1
assert "B4 a banner arriving under an open dashboard waits" "inst('notch')._state.dashboard!==null && inst('notch')._state.pending.length===1"
B 'await kkey(["Escape"]); await sl(1200); return 1' >/dev/null
assert "B4 it shows once the dashboard closes" "inst('notch')._state.current!==null"
shot b4-banner-after
B 'await kmove(640,600); await sl(9000); return 1' >/dev/null
assert "B4 banners drain" "inst('notch')._state.current===null && inst('notch')._state.pending.length===0"

echo "-- B4 perf: hover open / close"
gs notch-hover-delay 100
B 'await kmove(640,14); await kmove(641,15); await sl(1200); await kmove(640,600); await sl(1500); return 1' >/dev/null
perf_start
track_actor "inst('notch')?._view?._island" notch-open
B 'await kmove(640,14); await kmove(641,15); await sl(1200); return 1' >/dev/null
track_stop
track_actor "inst('notch')?._view?._island" notch-close
B 'await kmove(640,600); await sl(1500); return 1' >/dev/null
track_stop
perf_stop notch-open-close
gs notch-hover-delay 300

echo "-- B4 full screen: the notch reveals with the bar"
launch_app "gnome-text-editor" org.gnome.TextEditor 40
B 'await kmove(640,400); kwin("org.gnome.TextEditor").make_fullscreen(); await sl(2500); return 1' >/dev/null
assert "B4 over full screen: no notch" "!inst('notch')._view._island.visible"
B 'await kmove(640,1); await kmove(640,0); await sl(1200); return 1' >/dev/null
shot b4-fullscreen-revealed
assert "B4 the bar slid in" "inst('menu-bar')?.part('fullscreen')?.revealed===true"
assert "B4 the notch came with it" "inst('notch')._view._island.visible"
B 'await kmove(640,500); await sl(1500); return 1' >/dev/null
assert "B4 bar and notch went again" "inst('menu-bar')?.part('fullscreen')?.revealed===false && !inst('notch')._view._island.visible"
B 'kwin("org.gnome.TextEditor").unmake_fullscreen(); await sl(1500); return 1' >/dev/null
assert "B4 out of full screen: notch back" "inst('notch')._view._island.visible"

echo "-- B4 leaks across disable / enable"
for i in 1 2 3; do gs notch false; sleep 0.6; gs notch true; sleep 0.8; done
B 'const c={};const w=a=>{const n=a.name||"";if(n.startsWith("guava-notch"))c[n.replace(/-[0-9]$/,"")]=(c[n.replace(/-[0-9]$/,"")]??0)+1;a.get_children().forEach(w)};w(global.stage);return JSON.stringify(c)'
assert "B4 one island, two ears, no stray layers" "(()=>{let n=0;const w=a=>{if((a.name||'').startsWith('guava-notch'))n++;a.get_children().forEach(w)};w(global.stage);return n===11})()"
gs notch-live-activities true
assert_summary
