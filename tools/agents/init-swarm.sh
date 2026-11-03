#!/usr/bin/env bash
# init-swarm.sh: create the live agent memory ($SWARM) from the committed snapshot in
# docs/agents/shared/, or (with --sync-back) copy the live shared memory into the repo before a
# commit. Only the orchestrator runs it. Layout: docs/agents/workflow.md §2.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SWARM=${SWARM:-/home/user/.swarm/guava-os}
if [ "${1:-}" = --sync-back ]; then
    cp "$SWARM"/shared/*.md "$REPO/docs/agents/shared/"
    echo "copied $SWARM/shared -> docs/agents/shared"; exit 0
fi
mkdir -p "$SWARM/shared" "$SWARM/agents"
for f in "$REPO"/docs/agents/shared/*.md; do
    t="$SWARM/shared/$(basename "$f")"
    [ -e "$t" ] && continue            # never overwrite live memory
    cp "$f" "$t"
done
chmod 444 "$SWARM"/shared/*.md
echo "swarm ready: $SWARM"
