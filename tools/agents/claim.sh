#!/usr/bin/env bash
# claim.sh: the file-ownership log shared by every agent and worktree (docs/agents/workflow.md §4).
#   claim.sh start <agent> <path>...   claim paths; exit 3 (and claim nothing) if another agent holds one
#   claim.sh end   <agent> <path>...   release them ("all" releases every path the agent holds)
#   claim.sh list                      active claims: who holds what, since when
# A path is a file or a folder prefix ("features/notch/" or "features/notch/**"). Two claims clash
# when one path is a prefix of the other. The log is append-only Markdown, so humans can read it.
set -euo pipefail
SWARM=${SWARM:-/home/user/.swarm/guava-os}
LOG=$SWARM/ownership-log.md
mkdir -p "$SWARM"
[ -f "$LOG" ] || printf '# Ownership log (append-only; written by tools/agents/claim.sh)\n\n| time (UTC) | agent | action | path |\n|---|---|---|---|\n' > "$LOG"

norm() { local p=${1%/\*\*}; p=${p%/\*}; p=${p#./}; printf '%s' "${p%/}"; }

# Active claims as "agent<TAB>path<TAB>since", replaying START/END in order
active() {
    awk -F' *\\| *' '/^\| [0-9]/ {
        key = $3 "\t" $5
        if ($4 == "START") { since[key] = $2 } else if ($4 == "END") { delete since[key] }
    } END { for (k in since) print k "\t" since[k] }' "$LOG" | sort
}

clashes() { # agent path -> prints clashing claims by other agents
    local me=$1 p; p=$(norm "$2")
    active | while IFS=$'\t' read -r who held since; do
        [ "$who" = "$me" ] && continue
        local h; h=$(norm "$held")
        if [ "$h" = "$p" ] || [[ "$p" == "$h"/* ]] || [[ "$h" == "$p"/* ]] || [ -z "$h" ] || [ -z "$p" ]; then
            printf '%s holds %s since %s\n' "$who" "$held" "$since"
        fi
    done
}

cmd=${1:-list}; shift || true
exec 9>"$LOG.lock"; flock 9
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
case "$cmd" in
start)
    agent=${1:?agent}; shift
    [ $# -gt 0 ] || { echo "claim.sh start <agent> <path>..." >&2; exit 2; }
    bad=0
    for p in "$@"; do
        c=$(clashes "$agent" "$p")
        [ -n "$c" ] && { echo "CLASH $p: $c" >&2; bad=1; }
    done
    [ "$bad" -eq 0 ] || { echo "nothing claimed; ask the orchestrator (ASK O) to reassign" >&2; exit 3; }
    for p in "$@"; do printf '| %s | %s | START | %s |\n' "$now" "$agent" "$p" >> "$LOG"; done
    ;;
end)
    agent=${1:?agent}; shift
    if [ "${1:-}" = all ]; then
        set -- $(active | awk -F'\t' -v a="$agent" '$1 == a {print $2}')
    fi
    for p in "$@"; do printf '| %s | %s | END | %s |\n' "$now" "$agent" "$p" >> "$LOG"; done
    ;;
list)
    printf '%-8s %-40s %s\n' agent path since; active | while IFS=$'\t' read -r a p s; do printf '%-8s %-40s %s\n' "$a" "$p" "$s"; done
    ;;
*) echo "usage: claim.sh start|end <agent> <path>... | list" >&2; exit 2 ;;
esac
