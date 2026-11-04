#!/bin/bash
# seed-mesa.sh: build a warm Mesa shader cache for the harness. Every harness run starts from a
# fresh home, so every login compiles its shaders cold (llvmpipe JIT: ~200 ms of the first frame
# with Guava's chrome; a stock login pays the same for its own). A user's second login finds the
# cache. Build it once per root update, then
#   GUAVA_MESA_SEED=$X2/mesa-seed tools/harness/run-f44.sh ...
# starts the run (stock or Guava alike) from the same warm cache. The seed is copied in and never
# written back, so every run sees the same cache and no run warms the next one.
#   X2=/tmp/claude-0/x2 tools/harness/seed-mesa.sh [runs=3]   -> $X2/mesa-seed
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
X2=${X2:-/tmp/x2}; export X2
SEED=$X2/mesa-seed
RUNS=${1:-3}
rm -rf "$SEED" "$SEED.new"
for i in $(seq 1 "$RUNS"); do
  # The first run is a stock login; each run starts from what the one before left
  unset GUAVA_MESA_SEED GUAVA_STOCK
  [ -d "$SEED" ] && export GUAVA_MESA_SEED=$SEED
  [ "$i" = 1 ] && export GUAVA_STOCK=1
  GUAVA_SKIP_PROBES=1 GUAVA_MESA_SEED_OUT=$SEED.new "$HERE/run-f44.sh" 0 >/dev/null 2>&1
  [ -d "$SEED.new" ] || { echo "run $i left no shader cache"; exit 1; }
  rm -rf "$SEED"; mv "$SEED.new" "$SEED"
  echo "run $i: $(du -sh "$SEED" | cut -f1)"
done
