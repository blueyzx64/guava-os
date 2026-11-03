# Agent workflow: orchestrator, leads, memory and ownership

> **Summary:** one orchestrator (O) plans, owns the shared memory and merges. Leads each own a
> lane (a set of paths), work in their own git worktree, keep their own memory file and claim
> files in the ownership log before they edit them. Nobody edits shared memory or another
> agent's file. A lane is done when `make check` is green, the real-Shell harness reports
> `Guava errors: 0`, and the lesson is written down.

Rules for the code itself: `docs/architecture/principles.md` and `conventions.md`.

## 1. Roles

| Role | Writes | Never |
|---|---|---|
| **Orchestrator (O)** | `$SWARM/shared/*`, merges lanes, `docs/agents/learnings.md`, pushes | Leaves a lane's conflict unresolved |
| **Lead (L1…)** | Code in its lane's paths, its own memory file, the ownership log through `claim.sh` | Edits outside its lane, writes `shared/`, pushes |
| **Researcher (R1…)** | Its own memory file and its report folder `$SWARM/agents/<id>/` | Edits the repo |

Leads run with `isolation: "worktree"`: their own checkout and branch, merged by O.

### Limits and tokenomics

| Tier | Model | Max at once | Use for |
|---|---|---|---|
| Orchestrator | the session's model | 1 | planning, merging, the gate |
| Lead / researcher | `model: "sonnet"` | **6** | a lane: design, hard code, verification |
| Worker | `model: "haiku"` | **12** | one small, fully specified ticket plus its test |

1. **Spawn only when parallel work pays.** A lookup or a one-file fix is done inline, not by an agent.
2. **Terse prose.** Agent-to-agent text (memory files, ASKs, reports) uses the `caveman:caveman`
   style: short sentences, no filler. Code, docs in `docs/`, commit messages and UI strings stay normal.
3. **Read narrowly.** Grep, then Read with `offset`/`limit`. Never re-read a file you just edited.
4. **Hand off by pointer**: path, SHA, one line. Never paste file contents into reports or memory.
5. **Test narrowly.** Run the one test file you touched while iterating; `make check` and one
   harness run at the end of the lane (a harness run costs ~3 minutes of log output: grep it).
6. **Fail fast.** Two failed attempts at the same error: write `STATUS: blocked` and stop.
7. **Final report ≤ 150 words.** Memory file ≤ 60 lines.

## 2. Memory

Live memory sits outside the repo so every worktree sees the same files:

```
SWARM=/home/user/.swarm/guava-os         (tools/agents/init-swarm.sh creates it)
├─ shared/            ONLY O writes (chmod 444 between writes); everyone reads
│  ├─ brief.md        the project in 30 lines + where things are
│  ├─ board.md        lanes, bugs, status, owner, commit
│  ├─ decisions.md    D-001… answers to ASK lines (append-only)
│  └─ ownership.md    lane -> paths (the plan; the log below is the live truth)
├─ ownership-log.md   append-only; written only by tools/agents/claim.sh
└─ agents/
   ├─ L1.md           a lead's memory: only L1 writes it, anyone reads it
   └─ R1/             a researcher's reports
```

**Own memory file** (≤ 60 lines; replace `NOW`, don't append history to it):

```
# L1 · minimize + Mission Control
STATUS: working            # working | blocked | review | done
NOW: genie misses windows mapped before the dock
DONE: 3f2a1bc genie target fallback
ASK O: may I add an event to core/events.js?
NOTE: Main.wm._shouldAnimateActor gates every stock effect
LEARN: (candidate for learnings.md) minimize signal fires before the actor is ready
```

**Protocol.** Agent -> O: an `ASK O:` line in your file, then keep working on what isn't blocked.
O -> agents: the answer goes in `shared/decisions.md` as `D-0xx`. O polls with
`grep -H '^STATUS\|^ASK' $SWARM/agents/*.md`. To promote a note to shared memory or
`learnings.md`, mark it `LEARN:`; O decides and copies it.

What survives the session: O copies `shared/` and the `LEARN` notes it accepts into
`docs/agents/` before each push. Agent memory files are working notes and are not committed.

## 3. Ownership

1. Before editing a file: `tools/agents/claim.sh start <you> <path>...` (a file or a folder).
   Exit 3 means another agent holds it: don't edit it; write `ASK O`.
2. When done with it: `tools/agents/claim.sh end <you> <path>...` (or `all`).
3. Who holds what now: `tools/agents/claim.sh list`. History: `$SWARM/ownership-log.md`.

Shared hot spots (`core/events.js`, `features.js`, `schemas/*.xml`, `stylesheet.css`,
`src/styles/base.css`, `extension.js`) are claimed for minutes, not hours: claim, make the one change,
commit, release. `stylesheet.css` is generated: never hand-merge it, run `make css` after a merge.

## 4. Done for a lane

1. Root cause written in your memory file before the fix (a bug fixed without a known cause is
   not fixed).
2. A test that failed before the fix and passes after it: a pure-model test in `tests/` where
   the logic can be pure; otherwise a harness scenario in `tools/scenarios/`.
3. `make check` green in your worktree.
4. Real Shell: `GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 tools/harness/run-f44.sh 3` ends with
   `Guava errors: 0` and every probe passing (plus your scenario via `GUAVA_EXTRA`).
5. The feature page in `docs/features/` and `docs/architecture/code-map.md` match the code.
6. Commits: one topic each, imperative subject, body says why.
7. `LEARN:` lines for anything the next agent should know.
