// Run: gjs -m tests/showDesktopModel.test.js
import {
    PEEK, SPEEDS, wallpaperClickToggles, chooseEdge, durationFor, edgeOffset, focusEnds, isMovable, planReveal,
} from '../features/showDesktop/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

// 1280x800 monitor with a 32 px top bar
const AREA = { x: 0, y: 32, width: 1280, height: 768 };
const rect = (x, y, width, height) => ({ x, y, width, height });

test('chooseEdge: each half and quadrant', () => {
    eq(chooseEdge(rect(50, 300, 300, 200), AREA), 'left');
    eq(chooseEdge(rect(900, 300, 300, 200), AREA), 'right');
    eq(chooseEdge(rect(500, 40, 300, 100), AREA), 'top');
    eq(chooseEdge(rect(500, 650, 300, 100), AREA), 'bottom');
});

test('chooseEdge: distances are relative to the area size', () => {
    // Centre at x=400 (0.31 of the width), y=250 (0.28 of the height): top is nearer
    eq(chooseEdge(rect(300, 200, 200, 100), AREA), 'top');
    // Same window lower: left wins
    eq(chooseEdge(rect(300, 380, 200, 100), AREA), 'left');
});

test('chooseEdge: dead centre goes left; ties prefer the sides', () => {
    eq(chooseEdge(rect(540, 316, 200, 200), AREA), 'left');
    eq(chooseEdge(rect(0, 0, 100, 100), { x: 0, y: 0, width: 100, height: 100 }), 'left');
});

test('chooseEdge: second monitor uses its own origin', () => {
    const right = { x: 1280, y: 0, width: 1920, height: 1080 };
    eq(chooseEdge(rect(1300, 400, 400, 300), right), 'left');
    eq(chooseEdge(rect(2900, 400, 200, 300), right), 'right');
});

test('edgeOffset: leaves PEEK px of the frame on screen', () => {
    const f = rect(100, 200, 400, 300);
    eq(edgeOffset(f, AREA, 'left'), { x: PEEK - 500, y: 0 });
    eq(edgeOffset(f, AREA, 'right'), { x: 1280 - PEEK - 100, y: 0 });
    eq(edgeOffset(f, AREA, 'top'), { x: 0, y: 32 + PEEK - 500 });
    eq(edgeOffset(f, AREA, 'bottom'), { x: 0, y: 800 - PEEK - 200 });
    // After the move exactly PEEK px remain inside
    const l = edgeOffset(f, AREA, 'left');
    eq(f.x + f.width + l.x - AREA.x, PEEK);
    const b = edgeOffset(f, AREA, 'bottom');
    eq(AREA.y + AREA.height - (f.y + b.y), PEEK);
});

test('edgeOffset: never pulls a window inward; custom peek; junk edge', () => {
    eq(edgeOffset(rect(-500, 100, 510, 300), AREA, 'left'), { x: 0, y: 0 });
    eq(edgeOffset(rect(1275, 100, 400, 300), AREA, 'right'), { x: 0, y: 0 });
    eq(edgeOffset(rect(100, 200, 400, 300), AREA, 'left', 0), { x: -500, y: 0 });
    eq(edgeOffset(rect(100, 200, 400, 300), AREA, 'nowhere'), { x: 0, y: 0 });
});

test('planReveal: every window gets its own edge and offset', () => {
    const plans = planReveal([
        { id: 1, frame: rect(50, 300, 300, 200), area: AREA },
        { id: 2, frame: rect(900, 300, 300, 200), area: AREA },
    ]);
    eq(plans.get(1).edge, 'left');
    eq(plans.get(2).edge, 'right');
    eq(plans.get(1).x, PEEK - 350);
    eq(plans.get(2).x, 1280 - PEEK - 900);
});

test('planReveal: dialogs follow their parent, cycles are safe', () => {
    const plans = planReveal([
        { id: 'main', frame: rect(50, 300, 600, 400), area: AREA },
        { id: 'dlg', parentId: 'main', frame: rect(700, 300, 300, 200), area: AREA },
        { id: 'orphan', parentId: 'gone', frame: rect(1000, 300, 200, 200), area: AREA },
        { id: 'a', parentId: 'b', frame: rect(1000, 300, 200, 200), area: AREA },
        { id: 'b', parentId: 'a', frame: rect(50, 300, 200, 200), area: AREA },
    ]);
    eq(plans.get('dlg').edge, 'left');
    eq(plans.get('dlg').x, PEEK - 1000);
    eq(plans.get('orphan').edge, 'right');
    eq(['left', 'right'].includes(plans.get('a').edge), true);
    eq(plans.size, 5);
});

test('isMovable: normal windows only, skipping hidden, minimized and desktop ones', () => {
    const w = (over = {}) => ({
        type: 'normal', minimized: false, skipTaskbar: false, onWorkspace: true, visible: true,
        opacity: 255, ...over,
    });
    eq(isMovable(w()), true);
    eq(isMovable(w({ type: 'dialog' })), true);
    eq(isMovable(w({ type: 'desktop' })), false);
    eq(isMovable(w({ type: 'dock' })), false);
    eq(isMovable(w({ minimized: true })), false);
    eq(isMovable(w({ skipTaskbar: true })), false);   // DING on Wayland
    eq(isMovable(w({ onWorkspace: false })), false);
    eq(isMovable(w({ visible: false })), false);
    eq(isMovable(w({ opacity: 0 })), false);          // parked by Stage Manager
    eq(isMovable(null), false);
});

test('focusEnds: real windows end it, nothing and the desktop do not', () => {
    eq(focusEnds({ type: 'normal', skipTaskbar: false }), true);
    eq(focusEnds({ type: 'normal', skipTaskbar: true }), false);
    eq(focusEnds({ type: 'desktop', skipTaskbar: false }), false);
    eq(focusEnds(null), false);
});

test('durationFor: known speeds and fallback', () => {
    eq(durationFor('fast'), SPEEDS.fast);
    eq(durationFor('slow'), 500);
    eq(durationFor('normal'), 300);
    eq(durationFor('warp'), 300);
    eq(durationFor(undefined), 300);
});

test('wallpaperClickToggles: always, only in Stage Manager, never', () => {
    const t = (mode, stageActive = false, stageHandles = false, blocked = false) =>
        wallpaperClickToggles({ mode, stageActive, stageHandles, blocked });
    eq(t('always'), true);
    eq(t('stage-manager'), false);
    eq(t('never'), false);
    eq(t('never', true, false), false);
    eq(t('always', false, false, true), false);
    // Stage Manager on: it answers when its own option is on, Show Desktop otherwise
    eq(t('always', true, true), false);
    eq(t('stage-manager', true, false), true);
    eq(t('bogus'), false);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
