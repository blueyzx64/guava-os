// Run: gjs -m tests/switcherModel.test.js
import {
    ICON_SIZES, iconSizeFor, indexAfterRemoval, initialIndex, keyAction, pickAfterHide, planActivation, step,
    switcherApps,
} from '../features/switcher/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

test('switcherApps: MRU order, no duplicates or unknown apps', () => {
    eq(switcherApps(['a', 'b', 'a', null, 'c'], id => id !== 'c'), ['a', 'b']);
});

test('initialIndex: a tap goes back to the previous app', () => {
    eq(initialIndex(3), 1);
    eq(initialIndex(1), 0);
    eq(initialIndex(0), -1);
    eq(initialIndex(3, { backward: true }), 2);
    eq(initialIndex(3, { frontIsFirst: false }), 0);
});

test('step wraps both ways', () => {
    eq(step(2, 3, 1), 0);
    eq(step(0, 3, -1), 2);
    eq(step(0, 0, 1), -1);
});

test('indexAfterRemoval keeps the selected app selected', () => {
    eq(indexAfterRemoval(2, 0, 3), 1);   // an app before it left
    eq(indexAfterRemoval(2, 2, 2), 1);   // the selected (last) app quit
    eq(indexAfterRemoval(1, 1, 3), 1);   // the next one moves under the selection
    eq(indexAfterRemoval(1, 3, 3), 1);
    eq(indexAfterRemoval(0, 0, 0), -1);
});

test('keyAction: the macOS keys', () => {
    eq(keyAction('Tab'), 'next');
    eq(keyAction('Tab', { shift: true }), 'previous');
    eq(keyAction('ISO_Left_Tab'), 'previous');
    eq(keyAction('grave'), 'previous');
    eq(keyAction('Left'), 'previous');
    eq(keyAction('Left', { rtl: true }), 'next');
    eq(keyAction('Right'), 'next');
    eq(keyAction('Down'), 'expose');
    eq(keyAction('1'), 'expose');
    eq(keyAction('q'), 'quit');
    eq(keyAction('Q'), 'quit');
    eq(keyAction('h'), 'hide');
    eq(keyAction('Escape'), 'cancel');
    eq(keyAction('period'), 'cancel');
    eq(keyAction('Return'), 'activate');
    eq(keyAction('x'), null);
});

const W = (id, workspace, minimized = false, hidden = false) => ({ id, workspace, minimized, hidden });
const OPTS = { active: 0, switchToSpace: true, restoreMinimized: false };

test('planActivation: a window on this Space wins over a newer one elsewhere', () => {
    eq(planActivation([W(1, 1), W(2, 0)], OPTS), { kind: 'focus', windowId: 2, unhide: [] });
    eq(planActivation([W(1, -1)], OPTS), { kind: 'focus', windowId: 1, unhide: [] });
});

test('planActivation: switch to a Space with open windows, or a new window here', () => {
    eq(planActivation([W(1, 2)], OPTS), { kind: 'focus', windowId: 1, unhide: [] });
    eq(planActivation([W(1, 2)], { ...OPTS, switchToSpace: false }), { kind: 'new-window', unhide: [] });
});

test('planActivation: minimized windows stay minimized unless asked (Alt)', () => {
    eq(planActivation([W(1, 0, true)], OPTS), { kind: 'none', unhide: [] });
    eq(planActivation([W(1, 0, true)], { ...OPTS, restoreMinimized: true }), { kind: 'focus', windowId: 1, unhide: [] });
    // A minimized window on another Space only comes back if switching Spaces is allowed
    eq(planActivation([W(1, 1, true)], { ...OPTS, restoreMinimized: true, switchToSpace: false }), { kind: 'none', unhide: [] });
    // A visible window beats restoring a minimized one
    eq(planActivation([W(1, 0, true), W(2, 0)], { ...OPTS, restoreMinimized: true }), { kind: 'focus', windowId: 2, unhide: [] });
});

test('planActivation: a hidden app comes back (all its hidden windows)', () => {
    eq(planActivation([W(1, 0, true, true), W(2, 0, true, true), W(3, 0, true)], OPTS),
        { kind: 'focus', windowId: 1, unhide: [1, 2] });
});

test('pickAfterHide: releasing after H keeps the hidden app hidden', () => {
    eq(pickAfterHide(1, [false, false, false]), 1);
    eq(pickAfterHide(1, [false, true, false]), 0);
    eq(pickAfterHide(0, [true, false]), 1);
    eq(pickAfterHide(0, [true, true]), -1);
});

test('iconSizeFor: largest size that fits', () => {
    eq(iconSizeFor(4, 1152, 32), 128);
    eq(iconSizeFor(10, 1152, 32), 80);
    eq(iconSizeFor(100, 1152, 32), ICON_SIZES[ICON_SIZES.length - 1]);
    eq(iconSizeFor(0, 1152, 32), 128);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
