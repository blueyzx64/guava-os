# Stage Manager: minimize (SM-8 to SM-11). A minimized window goes to the Dock and leaves its set;
# Stage Manager never minimizes anything itself. Bundle after stage-manager-lib.sh.
echo "-- SM minimize"
sm_up A B C
echo "-- SM-8 the app minimizes itself (xdg_toplevel.set_minimized)"
sm_cmd C min
sleep 1.5
sm_state
assert "SM-8 C is minimized (Dock), not in the strip" "wst(sid('C')).min && !cardOf('SM C')"
assert "SM-9 a strip set took the stage" "onStage(sid('B'))"
assert "SM-9 the other set is still in the strip" "inStrip(sid('A'))"

echo "-- SM-10 restore from the Dock"
_kjs 'aw(sid("C")).meta_window.unminimize(); await sl(1800); return 1' >/dev/null
sm_state
assert "SM-10 C is back on the stage" "onStage(sid('C')) && !wst(sid('C')).min"
assert "SM-10 B went to the strip, not minimized" "inStrip(sid('B')) && inStrip(sid('A'))"

echo "-- SM-8 Super+H"
focus_app org.x2.SmC; sleep 0.5
key super+h
sleep 1.5
sm_state
assert "SM-8 Super+H minimizes C" "wst(sid('C')).min"
assert "SM-9 replacement on the stage" "onStage(sid('B')) || onStage(sid('A'))"
_kjs 'aw(sid("C")).meta_window.unminimize(); await sl(1800); return 1' >/dev/null
assert "SM-10 C on the stage again" "onStage(sid('C'))"

echo "-- SM-8 the header minimize button"
J='const j=JSON.parse(new TextDecoder().decode(GLib.file_get_contents("/tmp/w/org.x2.SmC.json")[1])); const b=aw(sid("C")).meta_window.get_buffer_rect(); return j.minimize?[b.x+j.minimize[0],b.y+j.minimize[1]]:null'
pt=$(_kjs "$J" | grep -o "[0-9]*,[0-9]*" | head -1)
if [ -n "$pt" ]; then
  _kjs "await kclick(${pt%,*},${pt#*,}); await sl(1800); return 1" >/dev/null
  assert "SM-8 button minimizes C" "wst(sid('C')).min"
  assert "SM-9 replacement on the stage" "onStage(sid('B')) || onStage(sid('A'))"
  _kjs 'aw(sid("C")).meta_window.unminimize(); await sl(1800); return 1' >/dev/null
else
  echo "SKIP header minimize button (no minimize in the button layout)"
fi

echo "-- SM-9 minimize every window, then restore them"
for x in C B A; do
  _kjs "const w=aw(sid('$x'))?.meta_window; if(w&&!w.minimized) w.minimize(); await sl(1500); return 1" >/dev/null
done
sm_state
assert "SM-8 all three minimized, none left invisible-but-mapped" "['A','B','C'].every(x=>wst(sid(x)).min)"
assert "SM-8 no strip thumbnail for a minimized window" "!cardOf('SM A') && !cardOf('SM B') && !cardOf('SM C')"
for x in C B A; do
  _kjs "aw(sid('$x')).meta_window.unminimize(); await sl(1500); return 1" >/dev/null
done
sm_state
assert "SM-10 last restored is the stage" "onStage(sid('A'))"
assert "SM-10 the others are in the strip, not minimized" "inStrip(sid('B')) && inStrip(sid('C'))"
sm_down
assert_summary
