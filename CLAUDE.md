# Guava OS: agent entry point

A GNOME Shell extension that brings the macOS desktop to GNOME. Target: Fedora 44, GNOME Shell 50, Wayland.

Read, in this order (stop when you have what you need):
1. `docs/architecture/principles.md`: the definition of good code and the interaction bar.
2. `docs/agents/learnings.md`: lessons earlier agents paid for.
3. `docs/architecture/code-map.md`: where everything lives. `conventions.md`: how to write a feature.
4. `docs/agents/workflow.md`: orchestrator, memory, ownership log, worktrees (multi-agent work).
5. `docs/features/<area>.md` for the area you touch.

Skills: `.claude/skills/` (GNOME Shell extension patterns, GJS, Clutter motion, the test harness).

Checks before any commit:
- `make check` (eslint, strict schema compile, generated CSS up to date, gjs unit tests).
- Real GNOME Shell 50.6: `GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 tools/harness/run-f44.sh 3` must end
  with `Guava errors: 0` and every probe passing. Build the roots once:
  `sudo X2=/tmp/claude-0/x2 CA_BUNDLE=... tools/harness/build-f44-root.sh f44 4`.

Non-negotiables: pure logic in `*Model.js` with tests; everything a feature creates goes in its
`cleanup`; animations only through `ctx.motion`; GNOME keys only through `core/originals.js`;
no sync IO on the Shell's main loop; features never import each other.
