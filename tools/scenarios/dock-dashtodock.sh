# Scenario for the real-Shell harness (GUAVA_EXTRA; GUAVA_PRE=dock-dashtodock-pre.sh).
# B22: Dash to Dock enabled before Guava (the usual order: DtD was installed first). Guava takes it out of
#      enabled-extensions; that must not make the Shell disable and enable Guava again ("rebase"): that
#      would be a second full Guava start at every login.
GUAVA=guava-os@blueyzx64
DTD=dash-to-dock@micxgx.gmail.com
sleep 3
# Fresh login order: nothing enabled but the probe, then [probe, DtD, Guava] in that order
P "global.settings.set_strv('enabled-extensions', ['probe@x2']); return 1" >/dev/null
sleep 3
P "return 'AFTER-OFF enabled='+global.settings.get_strv('enabled-extensions').join(',')+' gen='+Main.extensionManager.lookup('$GUAVA').stateObj._generation"
P "globalThis.__g0 = Main.extensionManager.lookup('$GUAVA').stateObj._generation; global.settings.set_strv('enabled-extensions', ['probe@x2','$DTD','$GUAVA']); return 1" >/dev/null
sleep 6
P "return 'ORDER '+Main.extensionManager._extensionOrder.join(',')+' enabled='+global.settings.get_strv('enabled-extensions').join(',')+' gen='+Main.extensionManager.lookup('$GUAVA').stateObj._generation+' g0='+globalThis.__g0"
echo "DTD LOG: $(tr '\n' ' ' < $W/dtd.log)"
assert dtd-taken-out "!global.settings.get_strv('enabled-extensions').includes('$DTD')"
assert dtd-stopped "Main.extensionManager.lookup('$DTD').state === 2"
assert guava-running "Main.extensionManager.lookup('$GUAVA').state === 1"
# one enable() = +1; a rebase adds a disable and an enable
assert guava-not-restarted "Main.extensionManager.lookup('$GUAVA').stateObj._generation === globalThis.__g0 + 1"
assert_summary
