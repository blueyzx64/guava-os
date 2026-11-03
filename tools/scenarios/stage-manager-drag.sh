# Stage Manager: drag a thumbnail onto the stage, drag a window onto a thumbnail (SM-34, B31).
# Bundle after stage-manager-lib.sh, perf-lib.sh and classify.js.
echo "-- SM drag and drop"
sm_up A B C
_SMD='const cc=t=>{const a=cardOf(t); const [x,y]=a.get_transformed_position(); return [Math.round(x+a.width/2),Math.round(y+a.height/2)];};
const lit=()=>!!walk(global.stage,a=>a.has_style_class_name?.("guava-stage-drop")&&a.visible&&a.opacity>200);
const litCard=()=>!!walk(global.stage,a=>a.has_style_class_name?.("guava-stage-drop-card")&&a.visible&&a.opacity>200);'
assert "pre: C on the stage, A and B in the strip" "onStage(sid('C')) && inStrip(sid('A')) && inStrip(sid('B'))"

echo "-- SM-34 a thumbnail dragged over the stage lights it; Esc cancels"
_kjs "$_SMD"'
const [x,y]=cc("SM A"); await kmove(x,y); await sl(120); await kpress();
for(let i=1;i<=20;i++) await kmove(x+(900-x)*i/20, y+(500-y)*i/20);
await sl(400); globalThis.__smLit=lit(); return 1' >/dev/null
assert "SM-34 the stage is lit while a thumbnail is over it" "globalThis.__smLit===true"
key Escape
sleep 0.5
_kjs 'await krelease(); await sl(900); return 1' >/dev/null
sm_state
assert "SM-34 Esc: nothing changed" "onStage(sid('C')) && inStrip(sid('A')) && !flight()"
assert "SM-34 the highlight is gone" "!walk(global.stage,a=>a.has_style_class_name?.('guava-stage-drop')&&a.visible)"
assert "SM-34 the thumbnail is back in its place, fully visible" "!!cardOf('SM A')"

echo "-- SM-34 drop on the strip: back, nothing joins"
_kjs "$_SMD"'
const [x,y]=cc("SM A"); await kdrag(x,y,x+20,y+60,12); await sl(900); return 1' >/dev/null
sm_state
assert "SM-34 a drop on the strip changes nothing" "onStage(sid('C')) && inStrip(sid('A')) && !!cardOf('SM A')"

echo "-- SM-34 drop a thumbnail on the stage: its windows join the stage set"
perf_start
_kjs "$_SMD"'
const [x,y]=cc("SM A"); await kdrag(x,y,900,500,20); await sl(1600); return 1' >/dev/null
perf_stop sm-drag-join
sm_state
assert "SM-34 A and C are both on the stage (shown, opaque)" "wst(sid('A')).op===255 && wst(sid('C')).op===255 && inStrip(sid('B'))"
assert "SM-34 no flight and no drag copy is left" "!flight()"
shot sm-drag-joined

echo "-- SM-34 drag a stage window onto a thumbnail: the window moves to that set"
sm_down
sm_up A B C
_kjs "$_SMD"'
const st="C", other="A"; globalThis.__smCards0=cards().length;
globalThis.__smDragSt=st; globalThis.__smDragTo=other;
const w=aw(sid(st)).meta_window; const f=w.get_frame_rect(); const [tx,ty]=cc("SM "+other);
await kmove(f.x+f.width/2, f.y+16); await sl(120); await kpress();
for(let i=1;i<=24;i++) await kmove(f.x+f.width/2+(tx-f.x-f.width/2)*i/24, f.y+16+(ty-f.y-16)*i/24);
await sl(500); globalThis.__smLitCard=litCard(); return 1' >/dev/null
assert "SM-34 the thumbnail under the window is lit" "globalThis.__smLitCard===true"
_kjs 'await krelease(); await sl(1800); return 1' >/dev/null
sm_state
assert "SM-34 the dragged window left the stage and joined the thumbnail's set" "inStrip(sid(globalThis.__smDragSt)) && !onStage(sid(globalThis.__smDragSt))"
assert "SM-34 the most recent other set (B) took the stage" "onStage(sid('B'))"
assert "SM-34 the strip has one thumbnail less: A and C share one" "cards().length===globalThis.__smCards0-1"
assert "SM-34 the highlight is gone" "!walk(global.stage,a=>a.has_style_class_name?.('guava-stage-drop-card')&&a.visible)"
sm_down
assert_summary
