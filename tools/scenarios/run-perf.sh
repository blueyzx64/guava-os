#!/bin/bash
# run-perf.sh: the whole perf suite (B11) in one command; prints PASS/FAIL per metric.
#   X2=/tmp/claude-0/x2 tools/scenarios/run-perf.sh
# 1. Unit level: the motion contract (tests/motionSmoothness.test.js) and the trace arithmetic.
# 2. Real Shell, two harness runs in parallel (two roots): a stock GNOME login (the baseline)
#    and a Guava login, each running perf-suite.sh (idle, core interactions, burst, overload).
# 3. perf-compare.py: Guava against the stock baseline of the same suite run (README.md).
# Exit 0 only when every metric passes.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
X2=${X2:-/tmp/x2}; export X2
OUT=$(mktemp -d /tmp/guava-perf.XXXXXX)
K=$REPO/tools/harness/lib

echo "== unit"
unit=0
for t in motionSmoothness motionModel startupModel; do
  if gjs -m "$REPO/tests/$t.test.js" >"$OUT/$t.txt" 2>&1; then echo "PASS unit:$t"; else echo "FAIL unit:$t"; grep FAIL "$OUT/$t.txt"; unit=1; fi
done

# A warm Mesa shader cache (tools/harness/seed-mesa.sh) when one was built: what a user's second
# login has. GUAVA_COLD=1 measures the cold first login instead (README.md, "Login first frame").
if [ -z "${GUAVA_COLD:-}" ] && [ -z "${GUAVA_MESA_SEED:-}" ] && [ -d "$X2/mesa-seed" ]; then export GUAVA_MESA_SEED=$X2/mesa-seed; fi
echo "== real Shell (stock and Guava logins, in parallel)${GUAVA_MESA_SEED:+, warm shader cache}"
"$K/bundle.sh" "$OUT/extra.sh" "$K/lib.sh" "$K/perf-lib.sh" "$K/classify.js" "$HERE/perf-latency.sh" "$HERE/perf-suite.sh" >/dev/null
GUAVA_STOCK=1 GUAVA_SKIP_PROBES=1 GUAVA_EXTRA=$OUT/extra.sh GUAVA_SRC=$REPO "$REPO/tools/harness/run-f44.sh" 0 >"$OUT/stock.txt" 2>&1 &
sp=$!
sleep 5   # take different roots
GUAVA_SKIP_PROBES=1 GUAVA_EXTRA=$OUT/extra.sh GUAVA_SRC=$REPO "$REPO/tools/harness/run-f44.sh" 0 >"$OUT/guava.txt" 2>&1
wait $sp
dir() { grep "RUN DIR" "$1" | awk '{print $3}'; }
S=$(dir "$OUT/stock.txt"); G=$(dir "$OUT/guava.txt")
[ -n "$S" ] && [ -n "$G" ] || { echo "FAIL harness: no run dir (see $OUT)"; exit 1; }
grep "Guava errors" "$OUT/guava.txt"
python3 -I "$HERE/perf-compare.py" "$S/last-run.txt" "$G/last-run.txt" "$OUT/guava.txt"
rc=$?
echo "runs: stock $S  guava $G  (suite files $OUT)"
[ $rc -eq 0 ] && [ $unit -eq 0 ]
