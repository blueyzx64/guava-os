# Stage Manager: the strip's auto-hide and reveal with a real pointer (SM-15 to SM-19). Bundle
# after stage-manager-lib.sh, perf-lib.sh and classify.js.
echo "-- SM strip"
sm_up A B C
assert "SM-15 strip visible with a windowed stage" "stripShown()"
echo "-- SM-16 a zoomed stage window hides the strip"
focus_app org.x2.SmC; sleep 0.5
key super+Up
sleep 1.8
assert "SM-16 strip hidden" "!stripShown()"
_kjs 'await kmove(800,400); return 1' >/dev/null

echo "-- SM-17 push the left edge"
perf_start
track_actor "strip()" sm-reveal
_kjs 'await kpush(8); await sl(1200); return 1' >/dev/null
track_stop
perf_stop sm-reveal
assert "SM-17 the strip slides in on a push" "stripShown()"
assert "SM-17 thumbnails are there" "cards().length>=2"
shot sm-revealed

echo "-- SM-18 leave the strip"
perf_start
track_actor "strip()" sm-hide
_kjs 'await kmove(800,400); await sl(1800); return 1' >/dev/null
track_stop
perf_stop sm-hide
assert "SM-18 the strip slides out again" "!stripShown()"

echo "-- SM-17 a resting pointer on the edge (dwell) reveals"
_kjs 'await kmove(m0.x+30,400); await kmove(m0.x,400); await sl(1000); return 1' >/dev/null
assert "SM-17 dwell reveals" "stripShown()"
_kjs 'await kmove(800,400); await sl(1500); return 1' >/dev/null

echo "-- SM-18 reveal then leave mid-slide reverses without a jump"
track_actor "strip()" sm-interrupt
_kjs 'await kpush(6); await sl(60); await kmove(800,400); await sl(1800); return 1' >/dev/null
track_stop
assert "SM-18 strip ends hidden" "!stripShown()"

echo "-- SM-19 keyboard (strip only on reveal)"
key super+Up
sleep 1.5
gs stage-manager-show-recent false
sleep 1.5
assert "SM-15 show-recent off: strip hidden" "!stripShown()"
key super+alt+Page_Down
sleep 0.7
assert "SM-19 the cycle shortcut reveals the strip" "stripShown()"
sleep 2.4
assert "SM-19 and it goes again" "!stripShown()"
sm_state
gs stage-manager-show-recent true
sleep 1.5
_kjs 'const w=aw(sid("C")).meta_window; if(w.is_maximized()) w.unmaximize(); await sl(1200); return 1' >/dev/null

echo "-- SM-16 autohide: dragging a stage window over the strip area"
_kjs 'const w=global.display.focus_window; const f=w.get_frame_rect(); await kdrag(f.x+f.width/2, f.y+16, f.width/2-40, f.y+16); await sl(1500); return 1' >/dev/null
assert "SM-16 strip aside while a window overlaps it" "(w=>{const f=w.get_frame_rect(); return f.x>=m0.x+200 || !stripShown()})(global.display.focus_window)"
sm_down
assert_summary
