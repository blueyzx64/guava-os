# Stage Manager: the strip's cards are kept across redraws (RV1-8) and sit on the physical pixel
# grid (RV1-9). Run it also with GUAVA_SCALE=2 and GUAVA_SCALE=1.25. Bundle after stage-manager-lib.sh.
echo "-- SM thumbnails"
sm_up A B C
sm_state
assert "pre: C on the stage, A and B in the strip" "onStage(sid('C')) && inStrip(sid('A')) && inStrip(sid('B'))"

echo "-- RV1-8 a redraw with nothing changed keeps the cards (no clone and shader rebuilt)"
_kjs 'const v=inst("stage-manager")._view; globalThis.__smCards=[...v._cards.values()].map(c=>c.card); globalThis.__smClones=[...v._thumbs.values()].map(t=>t.actor); inst("stage-manager")._render(); inst("stage-manager")._render(); return 1' >/dev/null
assert "RV1-8 the same card actors after two redraws" "(()=>{const v=inst('stage-manager')._view; const now=[...v._cards.values()].map(c=>c.card); return now.length>=2 && now.length===globalThis.__smCards.length && now.every((c,i)=>c===globalThis.__smCards[i]);})()"
assert "RV1-8 the same thumbnail clones, all still alive" "(()=>{const v=inst('stage-manager')._view; const now=[...v._thumbs.values()].map(t=>t.actor); return now.length===globalThis.__smClones.length && now.every((c,i)=>c===globalThis.__smClones[i]);})()"
assert "RV1-8 thumbnails and cards still clickable after a redraw" "cards().length>=2 && !!cardOf('SM A')"

echo "-- RV1-8 a changed entry rebuilds only itself"
sm_cmd A newwin
sleep 1.5
_kjs 'const v=inst("stage-manager")._view; globalThis.__smBefore=new Map([...v._cards].map(([id,c])=>[id,c.card])); return 1' >/dev/null
sm_cmd B newwin
sleep 2
assert "RV1-8 some card kept its actor when another entry changed" "(()=>{const v=inst('stage-manager')._view; let same=0; for (const [id,c] of v._cards) if (globalThis.__smBefore.get(id)===c.card) same++; return same>=1;})()"

echo "-- RV1-9 cards and thumbnails sit on whole physical pixels"
assert "RV1-9 card and clone positions are multiples of 1/scale" "(()=>{const s=global.display.get_monitor_scale(Main.layoutManager.primaryIndex); const ok=v=>Math.abs(v*s-Math.round(v*s))<0.03; const v=inst('stage-manager')._view; for (const c of v._cards.values()) { const [x,y]=c.card.get_transformed_position(); if(!ok(x)||!ok(y)||!ok(c.card.width)||!ok(c.card.height)) return false; } for (const t of v._thumbs.values()) { const [x,y]=t.actor.get_parent().get_transformed_position(); if(!ok(x+t.actor.x)||!ok(y+t.actor.y)) return false; } return v._thumbs.size>0;})()"
shot sm-thumbs
sm_down
assert_summary
