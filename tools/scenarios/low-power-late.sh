# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh). RV4-6:
# Low Power Mode finds the power-profiles daemon when it appears on the bus (it is bus-activated and may come
# up after the extension at login), and lets go when it leaves. The daemon is the python-dbusmock one the
# harness starts on its private system bus ($W/sysbus); it is stopped and started again here.
SB="unix:path=$W/sysbus"
LP='const lp=()=>inst("low-power");'
_KJS_PRE="$_KJS_PRE
$LP"
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
# Back, as if it had been started late
(DBUS_SYSTEM_BUS_ADDRESS=$SB python3 -m dbusmock --system --template upower_power_profiles_daemon >"$W/mock-ppd2.log" 2>&1 &)
for _ in $(seq 1 30); do [ -n "$(owner_pid)" ] && break; sleep 0.5; done
sleep 2
assert "RV4-6 the daemon came back: available again without restarting Guava" "lp().available"
gs low-power-battery true
gs low-power-adapter true
sleep 2
assert "RV4-6 Low Power Mode holds the profile on the late daemon" "lp().active"
gs low-power-battery false
gs low-power-adapter false
sleep 1
assert_summary
