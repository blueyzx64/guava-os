# Example (GUAVA_EXTRA): frame timing + jitter for Guava's Spotlight open/close, and a stock overview
# open/close as the GNOME baseline. Bundle:
#   bundle.sh OUT lib.sh perf-lib.sh classify.js perf-example.sh
force_animations on
sleep 1
_perf_cycle() {   # _perf_cycle NAME OPEN_JS CLOSE_JS ACTOR_EXPR
  local n=$1
  perf_start; track_actor "$4" "$n-open"
  _kjs "$2; await sl(1200); return 'ok'" >/dev/null
  track_stop
  track_actor "$4" "$n-close"
  _kjs "$3; await sl(1200); return 'ok'" >/dev/null
  track_stop; perf_stop "$n"
}
# warm-up so first-use shader/texture compilation is not counted
_kjs "inst('spotlight').toggle(); await sl(800); inst('spotlight').toggle(); await sl(800); Main.overview.show(); await sl(1000); Main.overview.hide(); await sl(1000); return 'ok'" >/dev/null
# Guava Spotlight
_perf_cycle spotlight "inst('spotlight').toggle()" "inst('spotlight').toggle()" "inst('spotlight')?._modal?.frame"
# GNOME baseline: stock overview (actor tracked: the overview's own element)
_perf_cycle overview-baseline "Main.overview.show()" "Main.overview.hide()" "Main.overview._overview"
assert_summary
