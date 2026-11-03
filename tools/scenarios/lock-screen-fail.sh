# Scenario for the real-Shell harness (GUAVA_EXTRA, pre: lock-screen-fail-pre.sh). Lock screen styling, two audit findings:
#   RV4-3  only a wrong password counts towards the password hint, not a cancelled prompt (suspend, idle escape,
#          "log in as another user"): the dialog emits 'failed' for both, the auth prompt tells them apart;
#   RV4-2  if styling throws midway the lock screen is left stock: no scrim, no overrides, the stock clock is back.
# Bundle: K=tools/harness/lib; $K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/lock-screen-fail.sh
force_animations on
sleep 0.5
LS='const ls=()=>Main.extensionManager.lookup("guava-os@blueyzx64").stateObj._features.instance("lock-screen");
const dlg=()=>Main.screenShield._dialog;
const sd=()=>ls()?.current;'
_KJS_PRE="$_KJS_PRE
$LS"
G() { _kjs "$1"; }
lock() { G "Main.screenShield.lock(false); return 1" >/dev/null; sleep 1.5; G "Main.screenShield._wakeUpScreen(); return 1" >/dev/null; sleep 1; }
unlock() { G "Main.screenShield.deactivate(false); return 1" >/dev/null; sleep 1.5; }

assert "feature lock-screen is running" "!!ls() && ls()._ctx"
# No GDM here: the prompt's reauthentication channel cannot open and the Shell logs an error from it. Not under test.
G "const u=await (0,eval)(\"import('resource:///org/gnome/shell/gdm/util.js')\"); u.ShellUserVerifier.prototype._openReauthenticationChannel=function(){}; return 1" >/dev/null

echo "-- RV4-3: cancelled prompts are not failures"
lock
G "dlg().activate(); return 1" >/dev/null
sleep 1
assert "the dialog is dressed and has its prompt" "sd()?.applied===true && !!dlg()._authPrompt"
G "for (let i=0;i<3;i++) dlg()._authPrompt.emit('cancelled'); return 1" >/dev/null
sleep 0.5
echo "LOCKFAIL failures after 3 cancels: $(G 'return sd()._failures')"
assert "RV4-3 three cancelled prompts count no failure" "sd()._failures===0"
assert "RV4-3 the capsule did not flash red" "!sd()._capsule.has_style_pseudo_class('error')"
G "dlg().activate(); await sl(900); return 1" >/dev/null
echo "LOCKFAIL wrong password: $(G "dlg()._authPrompt.emit('failed'); globalThis.__r=[sd()._failures, sd()._capsule.has_style_pseudo_class('error')]; return JSON.stringify(globalThis.__r)")"
sleep 0.3
assert "RV4-3 a wrong password counts and flags the capsule" "globalThis.__r[0]===1 && globalThis.__r[1]===true"
unlock

echo "-- RV4-2: styling throws midway, the lock screen stays stock"
lock
G "globalThis.__SD=sd().constructor; return !!globalThis.__SD" >/dev/null
unlock
G "globalThis.__orig=globalThis.__SD.prototype._message; globalThis.__SD.prototype._message=function(){ throw new Error('boom for the test'); }; return 1" >/dev/null
lock
echo "LOCKFAIL dialog classes: $(G 'return dlg().style_class')"
echo "LOCKFAIL children: $(G 'return dlg().get_children().map(a=>a.name||a.constructor.name).join(",")')"
assert "RV4-2 the styling failed and nothing is applied" "!sd() && !dlg().has_style_class_name('guava-lock-dialog')"
assert "RV4-2 no scrim left on the dialog" "!dlg().get_children().some(a=>a.name==='guava-lock-scrim')"
assert "RV4-2 the Shell's transition method is the Shell's again" "!Object.prototype.hasOwnProperty.call(dlg(),'_setTransitionProgress') && !Object.prototype.hasOwnProperty.call(dlg(),'_ensureAuthPrompt')"
assert "RV4-2 the stock clock is back" "dlg()._clock.visible"
assert "RV4-2 no Guava clock or teaser left in the stack" "!dlg()._stack.get_children().some(a=>a.name==='guava-lock-teaser') && !dlg()._stack.get_parent().get_children().some(a=>a.name==='guava-lock-clock')"
shot lock-stock-after-failure
unlock
G "globalThis.__SD.prototype._message=globalThis.__orig; return 1" >/dev/null
lock
assert "the next lock is dressed again" "sd()?.applied===true"
unlock
assert_summary
