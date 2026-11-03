# Brief: Guava OS (read first, 30 lines)
GNOME Shell extension, macOS desktop on GNOME. Target: Fedora 44, GNOME Shell 50.6, Wayland.
Repo: /home/user/guava-os, branch claude/guavaos-codebase-refactor-qigqgw. ~97K lines.

Architecture (sound; keep it): extension.js composition root -> features.js registry -> one
folder per feature (index.js adapter, model.js pure + tested, prefs.js, style.css). core/ =
shared services in ctx (desktop, layout, motion, events, originals, appMenus, osd, timers).
lib/ = feature-free infra (cleanup registry, glass, compat). Features never import features.

Read: docs/architecture/principles.md (the bar), code-map.md (where), conventions.md (how),
docs/agents/workflow.md (memory + ownership), docs/agents/learnings.md (lessons).

Checks: make check (eslint, strict schema, css-check, gjs unit tests: tests/run.sh).
Real Shell: GUAVA_SRC=$PWD X2=/tmp/claude-0/x2 tools/harness/run-f44.sh 3
  -> must end "Guava errors: 0", probes PASS. Roots f44,f44b,f44c,f44d (queue when busy).
  Scenario: GUAVA_EXTRA=bundle (tools/harness/README.md "Write a scenario").
Baseline 2026-11-03: 79 unit test files pass, lint clean, harness 0 errors 8/8 probes.

Reference code (read-only): /home/user/LordOS (macOS-like desktop, web+runtime),
/home/user/macos-font-rendering (setup.sh font rendering), /home/user/blueyzx64/app-installer
(Tauri .rpm/AppImage installer, app id io.github.blueyzx64.Installer).
Upstream extensions: clone into /home/user/.swarm/guava-os/refs/<name> (shallow), read-only.

Rules: claim before edit (tools/agents/claim.sh), own memory file only, ASK O for anything
outside your lane, never write shared/, never push. Root cause before fix. Test before fix.

Token rules (workflow.md "Limits and tokenomics"): max 6 sonnet leads, 12 haiku workers. Terse
(caveman) prose, narrow reads, narrow tests, final report <= 150 words.
