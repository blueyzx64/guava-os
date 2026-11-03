# Review brief (orchestrator; read-only for reviewers)

Goal (user): before hand-over, find every defect that would bite the user on a real Fedora 44 / GNOME 50
machine and that we could have caught here. You are a READ-ONLY reviewer: never edit the repo, never run
the harness (another sweep is using the roots). Repo: /home/user/guava-os (branch HEAD). Terse prose.

Read first: CLAUDE.md, docs/architecture/principles.md, conventions.md, docs/agents/learnings.md (known
pitfalls). GNOME Shell 50.6 sources (exact running code): /home/user/.swarm/guava-os/refs/gnome-shell-50.6-js.
API truth for Mutter/Clutter/St 50: introspect in the Fedora root, e.g.
  /tmp/claude-0/x2/f44.enter.sh gjs -c "imports.gi.versions.Clutter='18'; const C=imports.gi.Clutter; print(typeof C.Image)"
(Clutter/St/Meta/Cogl/Shell typelib versions: ls /tmp/claude-0/x2/f44/usr/lib64/mutter-*/ and /usr/lib64/gnome-shell/).

Two passes over your area:
1. Changed code (git diff 57a4a6d..HEAD -- <your paths>): read every line.
2. The rest of your area: scan for high-severity issues only.
What counts (verify each against the 50.6 source / typelib before reporting; no speculation):
- API that does not exist or changed on GNOME 50 (e.g. Clutter.Image, Clutter.GrabState, get_maximized(),
  get_stage_view, signals on the wrong object) — these throw only on the path that uses them.
- Errors swallowed or only console.warn'd on paths a user hits (a feature silently degrading).
- enable/disable asymmetry: anything not undone in cleanup; signals on objects that outlive the feature;
  timeouts/idles not removed; actors not destroyed; injections not restored; GNOME keys not given back.
- Use of a disposed actor (callbacks after destroy, ease onDone without `finished`), races on fast toggles,
  lock/unlock (features stay loaded while locked: anything that must stop while locked?).
- Sync IO or subprocess on the Shell main loop; unbounded polling; per-frame allocation in hot paths.
- Multi-monitor and HiDPI assumptions (primary monitor only, monitor 0, hard-coded pixel sizes that should
  scale, textures created below the monitor scale); Xwayland vs Wayland windows.
- Security/privacy: anything visible or reactive on the lock screen; files written outside Guava's own;
  shell injection in subprocess args; secrets in logs.
- Settings: keys read that aren't in the schema (tools/check-refs.mjs covers literals; check computed keys),
  schema defaults that contradict the docs.
- Leftovers: debug logging, dead code referencing removed APIs, TODOs that hide a real bug.
Output: /home/user/.swarm/guava-os/agents/review/<you>.md, one finding per block:
  ID (<you>-n) · severity (blocker/high/medium/low) · file:line · what happens to the user (concrete
  scenario) · evidence (source/typelib line) · suggested fix (one line).
Skip style nits. Max 25 findings, most severe first. Final report to O ≤ 120 words: counts by severity and
the top 3.
