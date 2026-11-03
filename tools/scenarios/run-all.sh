#!/bin/bash
# run-all.sh: every scenario in tools/scenarios on the real Shell, in parallel on the free roots,
# one line per scenario: Guava errors and the scenario's assert summary. Exit 1 if any fails.
#   X2=/tmp/claude-0/x2 tools/scenarios/run-all.sh [name-filter]
# A scenario <name>.sh with a <name>-pre.sh next to it runs with that file as GUAVA_PRE.
# Not run here: libraries (*-lib.sh), setup files (*-pre.sh), the perf suite (run-perf.sh, which
# has its own runner) and one-off spikes/bisects (their headers say so).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
X2=${X2:-/tmp/x2}; export X2
K=$REPO/tools/harness/lib
OUT=$(mktemp -d /tmp/guava-all.XXXXXX)
filter=${1:-}
skip='-lib\.sh$|-pre\.sh$|^run-|^perf-|-spike|-bisect|^overview-bisect|^latency-coldprobe|^login-modules|^appmenus-qt-spike'
names=()
for f in "$HERE"/*.sh; do
    n=$(basename "$f")
    [[ "$n" =~ $skip ]] && continue
    [ -n "$filter" ] && [[ "$n" != *"$filter"* ]] && continue
    names+=("$n")
done
run_one() {
    local n=$1 base=${1%.sh} pre="" libs=()
    [ -f "$HERE/$base-pre.sh" ] && pre="$HERE/$base-pre.sh"
    # Stage Manager scenarios share a helper file
    [[ "$n" == stage-manager-* ]] && libs+=("$HERE/stage-manager-lib.sh")
    "$K/bundle.sh" "$OUT/$base.extra.sh" "$K/lib.sh" "$K/perf-lib.sh" "$K/classify.js" "${libs[@]}" "$HERE/$n" >/dev/null
    GUAVA_SRC=$REPO GUAVA_EXTRA=$OUT/$base.extra.sh ${pre:+GUAVA_PRE=$pre} timeout 1500 \
        "$REPO/tools/harness/run-f44.sh" 1 >"$OUT/$base.log" 2>&1
    local dir errs asserts
    dir=$(grep "RUN DIR" "$OUT/$base.log" | awk '{print $3}')
    errs=$(grep -o "Guava errors: [0-9]*" "$OUT/$base.log" | head -1)
    asserts=$( [ -n "$dir" ] && grep -o "ASSERT SUMMARY.*" "$dir/last-run.txt" | tail -1)
    printf '%-34s %-18s %s\n' "$n" "${errs:-NO RUN}" "${asserts:-(no asserts)}"
    [ -n "$dir" ] && grep -E "ASSERT FAIL" "$dir/last-run.txt" | sed 's/^/    /' | head -8
    sed -n '/== SUMMARY/,/^[^ ]/p' "$OUT/$base.log" | grep '^ ' | sed 's/^/    /' | head -8
}
export -f run_one; export HERE REPO K OUT
printf '%s\n' "${names[@]}" | xargs -P 4 -I{} bash -c 'run_one "$@"' _ {} | tee "$OUT/summary.txt"
echo "logs: $OUT"
! grep -qE "Guava errors: [1-9]|NO RUN|fail=[1-9]" "$OUT/summary.txt"
