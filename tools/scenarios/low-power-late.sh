# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh). RV4-6:
# Low Power Mode finds the power-profiles daemon when it appears on the bus (it is bus-activated and may come
# up after the extension at login), and lets go when it leaves. The daemon is the python-dbusmock one the
# harness starts on its private system bus ($W/sysbus); it is stopped and started again here.
SB="unix:path=$W/sysbus"
LP='const lp=()=>inst("low-power");'
_KJS_PRE="$_KJS_PRE
$LP"
G() { _kjs "$1"; }
owner_pid() {
  DBUS_SYSTEM_BUS_ADDRESS=$SB gdbus call --system --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetConnectionUnixProcessID org.freedesktop.UPower.PowerProfiles 2>/dev/null | grep -o '[0-9]\+' | tail -1
}
assert "low-power feature runs and found the daemon at start" "!!lp() && lp().available"
pid=$(owner_pid)
echo "LPLATE daemon pid: $pid"
[ -n "$pid" ] && kill "$pid"
sleep 2
assert "the daemon left: not available, nothing held" "!lp().available && !lp().active"
# A second instance started while the daemon is away (Guava enabled before the daemon is on the bus)
G 'const root="file://"+Main.extensionManager.lookup("guava-os@blueyzx64").path;
const lpm=await (0,eval)("import("+JSON.stringify(root+"/features/lowPower/index.js")+")");
const dm=await (0,eval)("import("+JSON.stringify(root+"/lib/disposables.js")+")");
globalThis.__lp2c=new dm.CleanupRegistry(); globalThis.__lp2=new lpm.LowPower(lp()._ctx, globalThis.__lp2c); globalThis.__lp2.enable(); await sl(1000); return 1' | sed 's/^/LPLATE second instance: /' | cut -c1-400
assert "a feature started with the daemon away is not available yet" "!globalThis.__lp2.available"
# Back, as if it had been started late
(DBUS_SYSTEM_BUS_ADDRESS=$SB python3 -m dbusmock --system --template upower_power_profiles_daemon >"$W/mock-ppd2.log" 2>&1 &)
for _ in $(seq 1 30); do [ -n "$(owner_pid)" ] && break; sleep 0.5; done
sleep 2
assert "RV4-6 the daemon came back: both instances see it without a restart" "lp().available && globalThis.__lp2.available"
G 'globalThis.__lp2c.dispose(); return 1' >/dev/null
gs low-power-battery true
gs low-power-adapter true
sleep 2
assert "RV4-6 Low Power Mode holds the profile on the late daemon" "lp().active"
gs low-power-battery false
gs low-power-adapter false
sleep 1
assert_summary
