#!/bin/bash
HARNESS_DIR=${HARNESS_DIR:-$(cd "$(dirname "$0")" && pwd)}
X2=${X2:-/tmp/x2}   # state: roots, locks, runs
# Fedora 44 / GNOME Shell 50.6. Picks a free root among $X2/f44, f44b … f44h (those that exist).
# Usage: [GUAVA_SRC=dir] [GUAVA_ONLY="..."] [GUAVA_EXTRA=file] run-f44.sh [toggles=20]
while :; do
  for r in f44 f44b f44c f44d f44e f44f f44g f44h; do
    [ -d "$X2/$r" ] || continue
    exec 8>"$X2/pick-$r.lock"
    if flock -n 8; then ARCH="$X2/$r" X2="$X2" "$HARNESS_DIR/run-real.sh" "$@" 8>&-; rc=$?; exec 8>&-; exit $rc; fi
    exec 8>&-
  done
  sleep 5
done
