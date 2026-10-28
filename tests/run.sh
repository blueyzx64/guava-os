#!/usr/bin/env bash
# Run every tests/**/*.test.js with gjs as an ES module. Non-zero exit on any failure.
set -u
cd "$(dirname "$0")/.."
fail=0; n=0
while IFS= read -r -d '' t; do
    n=$((n + 1))
    echo "== $t"
    if ! gjs -m "$t"; then
        echo "FAIL: $t"
        fail=$((fail + 1))
    fi
done < <(find tests -name '*.test.js' -print0 | sort -z)
echo "ran $n file(s), $fail failed"
[ "$fail" -eq 0 ]
