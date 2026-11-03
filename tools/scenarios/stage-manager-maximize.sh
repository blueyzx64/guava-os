# Stage Manager: maximize, zoom and full screen (SM-12 to SM-14). Bundle after stage-manager-lib.sh.
echo "-- SM maximize"
sm_up A B C
echo "-- SM-12 Super+Up"
focus_app org.x2.SmC; sleep 0.5
key super+Up
sleep 1.8
sm_state
assert "SM-12 C is maximized and still on the stage" "wst(sid('C')).max && onStage(sid('C'))"
assert "SM-12 maximized frame covers the work area" "(f=>f.width>=Main.layoutManager.getWorkAreaForMonitor(m0.index).width-2)(aw(sid('C')).meta_window.get_frame_rect())"
assert "SM-12 other sets stay hidden, not minimized" "inStrip(sid('A')) && inStrip(sid('B'))"
assert "SM-13 the strip steps aside under the zoomed window" "!stripShown()"
shot sm-maximized
key super+Down
sleep 1.8
assert "SM-12 unmaximize returns the old frame" "!wst(sid('C')).max && aw(sid('C')).meta_window.get_frame_rect().width<1000"
assert "SM-13 the strip is back" "stripShown()"

echo "-- SM-12 the app's own maximize request"
sm_cmd C max
sleep 1.5
assert "SM-12 client maximize keeps C on the stage" "wst(sid('C')).max && onStage(sid('C')) && inStrip(sid('B'))"
sm_cmd C unmax
sleep 1.2

echo "-- SM-12 switching away from and back to a zoomed window"
key super+Up; sleep 1.5
_kjs 'aw(sid("B")).meta_window.activate(global.get_current_time()); await sl(1800); return 1' >/dev/null
assert "SM-2 B on the stage, C hidden but still zoomed" "onStage(sid('B')) && inStrip(sid('C')) && wst(sid('C')).max"
_kjs 'aw(sid("C")).meta_window.activate(global.get_current_time()); await sl(1800); return 1' >/dev/null
assert "SM-2 C back, still zoomed, strip aside" "onStage(sid('C')) && wst(sid('C')).max && !stripShown()"
key super+Down; sleep 1.5

echo "-- SM-14 full screen"
_kjs 'aw(sid("C")).meta_window.make_fullscreen(); await sl(1800); return 1' >/dev/null
sm_state
assert "SM-14 C is full screen on the stage" "wst(sid('C')).fs && onStage(sid('C'))"
assert "SM-14 the strip is hidden" "!stripShown()"
_kjs 'await kpush(8); await sl(900); return 1' >/dev/null
assert "SM-14 a push on the edge does not reveal the strip" "!stripShown()"
assert "SM-14 sets behind stay hidden" "inStrip(sid('A')) && inStrip(sid('B'))"
_kjs 'await kmove(640,400); aw(sid("C")).meta_window.unmake_fullscreen(); await sl(1800); return 1' >/dev/null
assert "SM-14 leaving full screen returns the strip and the stage" "!wst(sid('C')).fs && onStage(sid('C')) && stripShown()"

echo "-- SM-12 the green button (windows-green-button-fullscreen)"
J='const j=JSON.parse(new TextDecoder().decode(GLib.file_get_contents("/tmp/w/org.x2.SmC.json")[1])); const b=aw(sid("C")).meta_window.get_buffer_rect(); return j.maximize?[b.x+j.maximize[0],b.y+j.maximize[1]]:null'
pt=$(_kjs "$J" | grep -o "[0-9]*,[0-9]*" | head -1)
if [ -n "$pt" ]; then
  _kjs "await kclick(${pt%,*},${pt#*,}); await sl(2000); return 1" >/dev/null
  sm_state
  assert "SM-12/14 green button: C zoomed or full screen, on the stage" "(wst(sid('C')).fs||wst(sid('C')).max) && onStage(sid('C'))"
  assert "SM-13/14 strip aside" "!stripShown()"
  assert "SM-12 others still hidden, not minimized" "inStrip(sid('A')) && inStrip(sid('B'))"
  _kjs 'const w=aw(sid("C")).meta_window; if(w.is_fullscreen()) w.unmake_fullscreen(); if(w.get_maximized()) w.unmaximize(); await sl(1800); return 1' >/dev/null
else
  echo "SKIP green button (no maximize in the button layout)"
fi
sm_down
assert_summary
