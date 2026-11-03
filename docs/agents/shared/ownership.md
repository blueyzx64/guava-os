# Ownership plan (lane -> paths). Live truth: tools/agents/claim.sh list
| Lane | Agent | Paths | Bugs |
|---|---|---|---|
| Minimize + Mission Control | L1 | features/minimizeEffect/**, features/missionControl/** | B1, B14 |
| Window controls | L2 | features/windows/**, features/fullscreenSpace/**, features/appButtons/**, core/windowState.js | B12, B13 |
| Notch + menu bar | L3 | features/notch/**, features/menuBar/* except appMenuBar.js and adaptiveBar.js | B4, B8 |
| Liquid Glass + bar blur | L4 | lib/glass.js, lib/glassParams.js, lib/menuGlass.js, lib/wallpaperTint.js, lib/wallpaperModel.js, features/liquidGlass/**, styles/base.css, features/menuBar/adaptiveBar.js | B3, B15 |
| Login + performance | L5 | extension.js, lib/featureRegistry.js, features.js, core/motion*.js, tools/harness/**, tools/scenarios/** | B2, B11 |
| App menus | L6 | core/appMenus/**, features/menuBar/appMenuBar.js | B5, B6, B7 |
| Research: extensions + GNOME + skills | R1 | .claude/skills/** (drafts in $SWARM/agents/R1/) | skills |
| Research: LordOS + fonts | R2 | none ($SWARM/agents/R2/) | reuse map |
Hot spots (claim for minutes): core/events.js, schemas/*.xml, stylesheet.css (generated), po/, translating/.
| Stage Manager rewrite | L8 | features/stageManager/**, tests/stageManager*.test.js, docs/features/stage-manager.md, tools/scenarios/stage-manager*.sh | B16, B25 |
