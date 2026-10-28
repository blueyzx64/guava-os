#!/bin/bash
# bundle.sh OUT FILE...
#   Concatenate library and scenario files into one self-contained script for GUAVA_PRE or GUAVA_EXTRA.
#   The harness copies only that one file into the chroot (/opt), where /home/user is not visible,
#   so `source lib.sh` would fail there. Files are joined in the order given; shebang lines are dropped.
#   Example: bundle.sh "$S/example.bundle.sh" lib.sh example.sh
set -eu
out=${1:?usage: bundle.sh OUT FILE...}; shift
[ $# -ge 1 ] || { echo "usage: bundle.sh OUT FILE..." >&2; exit 2; }
dir=$(cd "$(dirname "$0")" && pwd)
: > "$out"
for f in "$@"; do
  [ -f "$f" ] || f="$dir/$f"          # bare names resolve inside this directory
  case "$f" in
    *.js)   # embed JS as a bash variable _K_<NAME>_JS (classify.js -> _K_CLASSIFY_JS); the Shell cannot see /home
      v=$(basename "$f" .js | tr 'a-z-' 'A-Z_')
      { echo "# ---- $(basename "$f") (as \$_K_${v}_JS) ----"; echo "_K_${v}_JS=\$(cat <<'__GUAVA_JS__'"; cat "$f"; echo "__GUAVA_JS__"; echo ")"; } >> "$out";;
    *) { echo "# ---- $(basename "$f") ----"; grep -v '^#!' "$f" || true; } >> "$out";;
  esac
done
echo "bundled $# file(s) -> $out"
