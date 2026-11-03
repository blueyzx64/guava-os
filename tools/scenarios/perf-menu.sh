# perf-menu.sh: focused bisect scenario for the suite's Quick Settings open/close step (perf regression P1).
# Same warm-up and PERF line as perf-suite.sh's `menu`. Bundle with lib.sh, perf-lib.sh, classify.js, then
#   GUAVA_EXTRA=<bundle> GUAVA_SKIP_PROBES=1 GUAVA_SRC=<tree> tools/harness/run-f44.sh 0
force_animations on >/dev/null
P "Main.overview.hide(); global.get_window_actors().forEach(a=>a.meta_window.delete(global.get_current_time())); return 1" >/dev/null
sleep 8   # past the login settling, as in the suite
for rep in 1 2 3; do
  P "Main.overview.show(); return 1" >/dev/null; sleep 1.2; P "Main.overview.hide(); return 1" >/dev/null; sleep 1.2   # warm-up
  perf_start; P "Main.panel.statusArea.quickSettings.menu.open(); return 1" >/dev/null; sleep 0.8
  P "Main.panel.statusArea.quickSettings.menu.close(); return 1" >/dev/null; sleep 0.8; perf_stop "menu$rep"
done
