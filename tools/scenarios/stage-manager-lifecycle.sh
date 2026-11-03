# Stage Manager: turning it off and Guava off leave every window usable (SM-11, SM-32).
# Bundle after stage-manager-lib.sh.
echo "-- SM lifecycle"
sm_up A
echo "-- SM-11 a window minimized by the user before"
sm_cmd A min
sleep 1.5
sm_up B C
sm_state
assert "pre: A minimized, C on stage, B in the strip" "wst(sid('A')).min && onStage(sid('C')) && inStrip(sid('B'))"

echo "-- SM-32 Stage Manager off"
gs stage-manager false
sleep 2
sm_state
assert "SM-32 B and C restored (opaque, visible)" "restored(sid('B')) && restored(sid('C'))"
assert "SM-32 B and C clickable" "pickable(sid('C')) || pickable(sid('B'))"
assert "SM-11 A stays minimized" "wst(sid('A')).min"
assert "SM-32 no strip actor, no flight left" "!strip() && !cards().length && !flight()"

echo "-- SM-32 on again, then Guava off"
gs stage-manager true
sleep 2
sm_state
assert "SM on again: one stage among B and C" "['B','C'].filter(x=>onStage(sid(x))).length===1"
D="gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions"
$D.DisableExtension guava-os@blueyzx64 >/dev/null 2>&1
sleep 3
sm_state
assert "SM-32 Guava off: every window restored" "['B','C'].every(x=>restored(sid(x)))"
assert "SM-11 A still minimized" "wst(sid('A')).min"
$D.EnableExtension guava-os@blueyzx64 >/dev/null 2>&1
sleep 4
sm_state
assert "Guava on again: exactly one stage among B and C" "['B','C'].filter(x=>onStage(sid(x))).length===1"

echo "-- SM-32 B16: a minimize round trip must not leave windows minimized after off"
_kjs 'aw(sid("B")).meta_window.minimize(); await sl(1200); aw(sid("B")).meta_window.unminimize(); await sl(1500); return 1' >/dev/null
gs stage-manager false
sleep 2
assert "SM-32 off after a minimize round trip: B and C restored" "restored(sid('B')) && restored(sid('C')) && !wst(sid('B')).min && !wst(sid('C')).min"
gs stage-manager true
sleep 1
sm_down
assert_summary
