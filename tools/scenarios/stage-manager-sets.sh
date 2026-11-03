# Stage Manager: sets, the stage and the swap (SM-1 to SM-6, SM-21 to SM-24). Bundle after
# stage-manager-lib.sh (see its header).
echo "-- SM sets: stage, strip, swap"
sm_up A B C
sm_state
assert "SM-1 the last app is the stage" "onStage(sid('C'))"
assert "SM-1 older apps are off the stage, not minimized" "inStrip(sid('A')) && inStrip(sid('B'))"
assert "SM-1 hidden windows are click-through" "!pickable(sid('A')) && !pickable(sid('B'))"
assert "SM-6 strip shows thumbnails of the other sets, at most 6" "cards().length>=2 && cards().length<=6"
assert "SM-15 strip visible while no window overlaps it" "stripShown()"
shot sm-sets-initial

echo "-- SM-21 click a thumbnail"
perf_start
track_actor "(flight()||aw(sid('A')))" sm-swap-A
click_actor "cardOf('SM A')"
sleep 1.6
track_stop
perf_stop sm-swap
sm_state
assert "SM-2/21 clicked set is the stage" "onStage(sid('A'))"
assert "SM-2 old stage went to the strip" "inStrip(sid('C')) && inStrip(sid('B'))"
assert "SM-21 swapped windows end at opacity 0 or 255 only" "[sid('A'),sid('B'),sid('C')].every(c=>{const o=wst(c).op;return o===0||o===255})"
assert "SM-21 the lead window has the focus" "global.display.focus_window?.get_wm_class()===sid('A')"
assert "SM-2 the old stage is in the strip" "!!cardOf('SM C')"

echo "-- SM-22 click a second thumbnail mid-swap"
_kjs 'aw(sid("A")).meta_window.activate(global.get_current_time()); await sl(1800); return 1' >/dev/null
assert "pre: A on the stage" "onStage(sid('A'))"
_kjs 'const a=cardOf("SM B"); const [x,y]=a.get_transformed_position(); await kclick(Math.round(x+a.width/2),Math.round(y+a.height/2)); await sl(120); const c=cardOf("SM C")||cardOf("SM A"); const b=cardOf("SM C"); const t=b??c; const [x2,y2]=t.get_transformed_position(); await kclick(Math.round(x2+t.width/2),Math.round(y2+t.height/2)); await sl(1800); return "ok"' >/dev/null
sm_state
assert "SM-22 the last click wins" "onStage(sid('C')) && inStrip(sid('A')) && inStrip(sid('B'))"
assert "SM-22 no window is left half transparent" "[sid('A'),sid('B'),sid('C')].every(c=>{const o=wst(c).op;return o===0||o===255})"
assert "SM-22 no flight actor is left over" "!flight()"

echo "-- SM-3 a new window of the stage app joins the stage"
sm_cmd C newwin
sleep 1
assert "SM-3 both windows of C are on the stage" "global.get_window_actors().filter(a=>a.meta_window.get_wm_class()===sid('C')&&a.opacity===255).length===2"
assert "SM-3 other apps stay in the strip" "inStrip(sid('A')) && inStrip(sid('B'))"

echo "-- SM-4 close the last window of the stage set"
sm_cmd C close
sm_cmd C close
sleep 2
sm_state
assert "SM-4 C is gone" "!aw(sid('C'))"
assert "SM-4 a strip set took the stage" "onStage(sid('A')) !== onStage(sid('B'))"
sm_down
assert_summary
