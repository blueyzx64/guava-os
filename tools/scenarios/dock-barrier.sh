# harness-env: GUAVA_MONITORS="1280x800 1280x800"
# Scenario for the real-Shell harness (GUAVA_EXTRA). Run with GUAVA_MONITORS="1280x800 1280x800".
# RV5-1: an auto-hiding dock on a side shared with another monitor must not put a pressure barrier
#        across that shared edge: the pointer has to cross to the neighbour.
sleep 2
gs dock-autohide true
gs dock-position right
sleep 2
if [[ "$(P "return 'MON='+Main.layoutManager.monitors.length")" != *MON=2* ]]; then
    echo "SKIP: needs GUAVA_MONITORS=\"1280x800 1280x800\""
    assert_summary
    exit 0
fi
_kjs 'await kmove(1200,400); await sl(200); for(let x=1200;x<=1360;x+=4) await kmove(x,400); await sl(300); return 1' >/dev/null
assert "pointer crossed to the second monitor" "global.get_pointer()[0]>1290"
_kjs 'await kmove(1360,400); await sl(200); for(let x=1360;x>=1200;x-=4) await kmove(x,400); await sl(300); return 1' >/dev/null
assert "pointer crossed back" "global.get_pointer()[0]<1270"
gs dock-position left
sleep 2
assert "left dock on the primary: barrier exists on its free edge" "!!inst('dock')._barrierCleanup"
gs dock-autohide false
assert_summary
