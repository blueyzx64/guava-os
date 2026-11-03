# Scenario for the real-Shell harness (GUAVA_EXTRA). Lock screen like macOS (L16, B32, D-022).
# Bundle: K=tools/harness/lib; $K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/lock-screen-style.sh
# Drives the REAL screen shield: Main.screenShield.lock(false) builds GNOME's UnlockDialog and pushes the
# 'unlock-dialog' mode; Main.screenShield.deactivate(false) unlocks (no password needed while the prompt was
# never used). LIMITS (no GDM, PAM, fprintd or logind in the chroot): the real password prompt cannot
# authenticate, a wrong password cannot be typed, the shake and the hint after failures are only unit-tested
# (tests/lockScreenModel.test.js) and driven by emitting the dialog's 'failed' signal; Sleep / Restart / Shut
# Down are checked with a spy in place of logind. Screenshots are read by eye by the author, never committed.
force_animations on
sleep 0.5
LS='const ls=()=>globalThis.__ls ??= Main.extensionManager.lookup("guava-os@blueyzx64").stateObj._features.instance("lock-screen");
const dlg=()=>Main.screenShield._dialog;
const sd=()=>ls()?.current;
const pos=a=>{const [x,y]=a.get_transformed_position();const [w,h]=a.get_transformed_size();return {x,y,w,h};};
const labels=(a,out=[])=>{if(a.text!==undefined&&a.visible&&(a.get_stage()))out.push(a.text);a.get_children?.().forEach(c=>labels(c,out));return out;};
const gvOutside=()=>{const out=[];const d=dlg();const walk=(a,k)=>{if(!a.visible)return;const n=(a.name||"")+" "+(a.style_class||"");if(/(^|\s)guava-/.test(n)&&a!==Main.panel&&a!==Main.layoutManager.uiGroup&&!(d&&(d===a||d.contains(a))))out.push(n);if(k<9)a.get_children().forEach(c=>walk(c,k+1));};walk(Main.layoutManager.uiGroup,0);return out;};
const setk=(k,v)=>{const s=ls()._ctx.settings;typeof v==="boolean"?s.set_boolean(k,v):s.set_string(k,v);};'
_KJS_PRE="$_KJS_PRE
$LS"
G() { _kjs "$1"; }

assert "L16 feature lock-screen is running" "!!ls() && ls()._ctx"
# No GDM here: the prompt's reauthentication channel cannot open and the Shell logs an error from it. Not under test.
G "const u=await import('resource:///org/gnome/shell/gdm/util.js'); u.ShellUserVerifier.prototype._openReauthenticationChannel=function(){}; return 1" >/dev/null

BEFORE=$(G "return gvOutside().length" | grep -o "[0-9]*" | head -1)
echo "LOCK Guava surfaces visible before: $BEFORE"
echo "-- lock (default options)"
G "const t0=GLib.get_monotonic_time(); Main.screenShield.lock(false); global.__lockMs=(GLib.get_monotonic_time()-t0)/1000; return 1" >/dev/null
sleep 1.5
# lock(false) fades the shield to black at once (the screen would be off); user activity lifts it, as a key or mouse move does
G "Main.screenShield._wakeUpScreen(); return 1" >/dev/null
sleep 1
echo "LOCK lock() cost ms: $(G 'return global.__lockMs')"
assert "L16 screen is locked, GNOME's dialog exists" "Main.sessionMode.currentMode==='unlock-dialog' && !!dlg()"
assert "L16 dialog is dressed" "dlg().has_style_class_name('guava-lock-dialog') && sd()?.applied===true"
assert "L16 date above big time" "(()=>{const c=sd().parts.clock;const [d,t]=c.get_children();return d.text.length>0 && t.text.length>0 && pos(d).y<pos(t).y && !/[ap]\\.?m/i.test(t.text);})()"
assert "L16 clock centred in the upper half" "(()=>{const p=pos(sd().parts.clock);const W=global.stage.width,H=global.stage.height;return Math.abs(p.x+p.w/2-W/2)<=2 && p.y+p.h<H/2;})()"
assert "L16 password capsule at the bottom centre" "(()=>{const t=dlg()._stack.get_children().find(a=>a.name==='guava-lock-teaser');const p=pos(t);const W=global.stage.width,H=global.stage.height;return t.visible && Math.abs(p.x+p.w/2-W/2)<=2 && p.y>H/2 && p.y+p.h<=H;})()"
assert "L16 capsule says Enter Password, named, focusable" "(()=>{const c=sd()._capsule;return c.label==='Enter Password' && c.accessible_name==='Enter Password' && c.can_focus && c.reactive;})()"
assert "L16 sharp wallpaper: no blur effect on the backgrounds" "dlg()._backgroundGroup.get_children().length>0 && dlg()._backgroundGroup.get_children().every(w=>!w.get_effect('blur'))"
assert "L16 scrim shown over the wallpaper" "dlg().get_children().some(a=>a.name==='guava-lock-scrim'&&a.visible)"
assert "L16 no clock/date from the stock clock" "!dlg()._clock.visible"
assert "L16 no Guava actor outside the lock dialog is visible" "gvOutside().length===0"
echo "LOCK outside: $(G 'return gvOutside().join(" ; ")')"
assert "L16 Guava stays ENABLED while locked" "Main.extensionManager.lookup('guava-os@blueyzx64').state===1"
shot lock-default

echo "-- password prompt: the stock one, crossfaded in place"
G "dlg().activate(); return 1" >/dev/null
sleep 1
assert "L16 prompt page shown, capsule teaser hidden" "dlg()._promptBox.visible && dlg()._promptBox.opacity>200 && !sd()._teaserBox.visible"
assert "L16 real prompt styled and named" "(()=>{const p=dlg()._authPrompt;return !!p && p.has_style_class_name('guava-lock-prompt') && p._passwordEntry.accessible_name.length>0;})()"
echo "LOCK prompt box: $(G 'return JSON.stringify([pos(dlg()._promptBox), pos(sd()._teaserBox), pos(dlg()._stack)])')"
assert "L16 prompt ends where the teaser did, centred (the field does not jump)" "(()=>{const p=pos(dlg()._promptBox),t=pos(sd()._teaserBox);return Math.abs(p.y+p.h-(t.y+t.h))<=2 && Math.abs(p.x+p.w/2-global.stage.width/2)<=2;})()"
echo "LOCK mainBox kids: $(G 'const m=dlg()._authPrompt._mainBox; return JSON.stringify(m.get_children().map(c=>[c.constructor.name,c.visible,Math.round(pos(c).x),Math.round(pos(c).w)]))')"
echo "LOCK field vs capsule y: $(G 'const e=dlg()._authPrompt._passwordEntry; return JSON.stringify([pos(e).y, pos(sd()._capsule).y, pos(e).x+pos(e).w/2])')"
assert "L16 clock stays while the prompt is shown" "sd().parts.clock.visible && sd().parts.clock.opacity===255"
shot lock-prompt
echo "-- a failed attempt returns to the capsule and flags it"
G "dlg()._authPrompt.emit('failed'); dlg()._showClock(); return 1" >/dev/null
sleep 1
assert "L16 back on the capsule after a failure" "sd()._teaserBox.visible && sd()._failures===1"
G "dlg()._authPrompt.emit('failed'); dlg()._authPrompt.emit('failed'); return 1" >/dev/null
sleep 0.3
assert "L16 no hint while the option is off" "sd()._hint.opacity===0 && sd()._hint.text===''"

echo "-- options (each applied live to the open dialog)"
setkey() { G "setk('$1', $2); return 1" >/dev/null; sleep 0.8; }
setkey lockscreen-large-clock "'never'"
assert "L16 large clock never: hidden" "!sd().parts.clock.visible"
shot lock-no-clock
setkey lockscreen-large-clock "'lock-screen'"
setkey lockscreen-wallpaper "'blurred'"
assert "L16 blurred wallpaper: the Shell's blur is back and the scrim is lighter" "dlg().has_style_class_name('guava-lock-blurred') && dlg()._backgroundGroup.get_children().every(w=>!!w.get_effect('blur'))"
shot lock-blurred
setkey lockscreen-wallpaper "'sharp'"
setkey lockscreen-show-user false
assert "L16 no user photo and name in the teaser" "sd()._teaserBox.get_children().length===2 || sd()._teaserBox.get_children().every(a=>a.name!=='' || a===sd()._capsule || a===sd()._hint)"
setkey lockscreen-show-user true
setkey lockscreen-message-on true
setkey lockscreen-message "'Found this Mac? Call 555 0100'"
assert "L16 message shown above the capsule" "(()=>{const m=sd().parts.message;return m.visible && m.text==='Found this Mac? Call 555 0100' && pos(m).y+pos(m).h<=pos(sd()._teaserBox).y;})()"
shot lock-message
setkey lockscreen-message-on false
assert "L16 message off: hidden" "!sd().parts.message.visible"
setkey lockscreen-power-buttons true
G "const s=sd(); global.__run=[]; s._run=id=>global.__run.push(id); s.setCan({suspend:true,restart:true,poweroff:true}); return 1" >/dev/null
sleep 0.5
assert "L16 Sleep, Restart, Shut Down buttons under the capsule, named" "(()=>{const r=sd().parts.power;const b=r.get_children();return r.visible && b.length===3 && b.every(x=>x.accessible_name&&x.can_focus) && pos(r).y>=pos(sd()._teaserBox).y+pos(sd()._teaserBox).h;})()"
shot lock-power
G "const b=sd().parts.power.get_children(); b[1].emit('clicked', 0); return 1" >/dev/null
assert "L16 Restart needs a second press (not run after the first)" "global.__run.length===0 && sd()._buttons.get('restart').caption.text==='Click Again'"
G "const b=sd().parts.power.get_children(); b[1].emit('clicked', 0); b[0].emit('clicked', 0); return 1" >/dev/null
assert "L16 second press runs Restart, Sleep runs at once" "JSON.stringify(global.__run)==='[\"restart\",\"suspend\"]'"
setkey lockscreen-power-buttons false
assert "L16 power buttons off: row hidden" "!sd().parts.power.visible"

echo "-- notifications: names and counts, never the text"
G "Main.notify('GUAVA-SECRET-TITLE', 'GUAVA-SECRET-BODY'); return 1" >/dev/null
sleep 1
echo "LOCK notification labels: $(G 'return labels(dlg()._notificationsBox).join(" | ")')"
assert "L16 no notification title or body on the lock screen" "!labels(dlg()._notificationsBox).join(' ').match(/GUAVA-SECRET/)"
shot lock-notifications
setkey lockscreen-notifications "'never'"
assert "L16 notifications never: no source rows" "dlg()._notificationsBox._notificationBox.get_children().filter(a=>a.has_style_class_name('unlock-dialog-notification-source')).every(a=>!a.visible)"
setkey lockscreen-notifications "'count'"
assert "L16 Now Playing off hides media rows (none playing: no-op)" "(setk('lockscreen-now-playing',false),true)"
setkey lockscreen-now-playing true

echo "-- reduced motion: no shake, the error flag still shows"
G "St.Settings.get().gtk_enable_animations; return 1" >/dev/null
G "dlg()._authPrompt.emit('failed'); return 1" >/dev/null
sleep 0.2
assert "L16 failed attempt flags the capsule" "sd()._capsule.has_style_pseudo_class('error')"

echo "-- unlock"
G "const t0=GLib.get_monotonic_time(); Main.screenShield.deactivate(false); global.__unlockMs=(GLib.get_monotonic_time()-t0)/1000; return 1" >/dev/null
sleep 1.5
echo "UNLOCK deactivate() cost ms: $(G 'return global.__unlockMs')"
assert "L16 unlocked, dialog gone" "Main.sessionMode.currentMode!=='unlock-dialog' && !dlg()"
assert "L16 wrapper dropped with the dialog" "!sd()"
assert "L16 Guava still ENABLED after unlock" "Main.extensionManager.lookup('guava-os@blueyzx64').state===1"
shot unlocked

echo "-- lock, unlock x4: same dress every time, no error"
for i in 1 2 3 4; do
  G "Main.screenShield.lock(false); return 1" >/dev/null; sleep 1
  G "global.__ok=(global.__ok??0)+(sd()?.applied?1:0); Main.screenShield.deactivate(false); return 1" >/dev/null; sleep 1
done
assert "L16 dressed on each of 4 locks" "global.__ok===4"
echo "LOCK left behind: $(G 'return gvOutside().join(" ; ")') / $(G 'return String(!!sd())')"
assert "L16 nothing of ours left behind (the pre-lock Guava surfaces are back, no lock-screen actor)" "gvOutside().length===$BEFORE && !gvOutside().some(n=>/guava-lock/.test(n)) && !sd()"

echo "-- Guava turned off while locked: the dialog goes back to stock"
G "Main.screenShield.lock(false); return 1" >/dev/null; sleep 1
G "setk('lockscreen-style', false); return 1" >/dev/null; sleep 1
assert "L16 off while locked: stock dialog again" "!dlg().has_style_class_name('guava-lock-dialog') && dlg()._clock.visible && !dlg().get_children().some(a=>a.name==='guava-lock-scrim')"
shot lock-stock
G "Main.screenShield.deactivate(false); return 1" >/dev/null; sleep 1
assert_summary
