// Run: gjs -m tests/missionControlModel.test.js
import {
    MODE, canRemoveSpace, centringShift, exposeView, fullscreenAppOf, groupedOrder, mruOrder, reorderIndex,
    skipStartupOverview, spaceLabels, stripCardSize, touchRecent, windowPlace,
} from '../features/missionControl/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

const desk = n => `Desktop ${n}`;

test('spaceLabels: desktops numbered on their own, full-screen Spaces named after the app', () => {
    eq(spaceLabels([{ fullscreenApp: null }, { fullscreenApp: 'Files' }, { fullscreenApp: null }], desk), [
        { label: 'Desktop 1', fullscreen: false },
        { label: 'Files', fullscreen: true },
        { label: 'Desktop 2', fullscreen: false },
    ]);
    eq(spaceLabels([], desk), []);
});

test('fullscreenAppOf: one normal full-screen window only', () => {
    eq(fullscreenAppOf([{ appName: 'Files', fullscreen: true, normal: true }]), 'Files');
    // A dialog next to it does not count
    eq(fullscreenAppOf([{ appName: 'Files', fullscreen: true, normal: true },
        { appName: 'Files', fullscreen: false, normal: false }]), 'Files');
    eq(fullscreenAppOf([{ appName: 'Files', fullscreen: true, normal: true },
        { appName: 'Editor', fullscreen: false, normal: true }]), null);
    eq(fullscreenAppOf([{ appName: 'Files', fullscreen: false, normal: true }]), null);
    eq(fullscreenAppOf([]), null);
    eq(fullscreenAppOf([{ appName: '', fullscreen: true, normal: true }]), null);
});

test('canRemoveSpace: the last Space stays', () => {
    eq(canRemoveSpace(1), false);
    eq(canRemoveSpace(2), true);
});

test('windowPlace: all windows in Mission Control', () => {
    const view = { mode: MODE.ALL, appId: null };
    eq(windowPlace({ appId: 'a', minimized: false }, view), 'spread');
    eq(windowPlace({ appId: 'b', minimized: true }, view), 'spread');
});

test('windowPlace: a window in the Stage Manager strip is in no overview', () => {
    eq(windowPlace({ appId: 'a', minimized: false, staged: true }, { mode: MODE.ALL, appId: null }), 'hidden');
    eq(windowPlace({ appId: 'a', minimized: false, staged: true }, { mode: MODE.APP, appId: 'a' }), 'hidden');
});

test('windowPlace: App Exposé spreads the app, strips its minimized windows, hides the rest', () => {
    const view = { mode: MODE.APP, appId: 'a' };
    eq(windowPlace({ appId: 'a', minimized: false }, view), 'spread');
    eq(windowPlace({ appId: 'a', minimized: true }, view), 'strip');
    eq(windowPlace({ appId: 'b', minimized: false }, view), 'hidden');
    eq(windowPlace({ appId: null, minimized: false }, view), 'hidden');
    eq(windowPlace({ appId: null, minimized: false }, { mode: MODE.APP, appId: null }), 'hidden');
});

test('exposeView: requested app first, then the focused one, else everything', () => {
    eq(exposeView('a', 'b'), { mode: MODE.APP, appId: 'a' });
    eq(exposeView(null, 'b'), { mode: MODE.APP, appId: 'b' });
    eq(exposeView(null, null), { mode: MODE.ALL, appId: null });
});

test('groupedOrder: apps together, in order of first appearance, stable inside a group', () => {
    eq(groupedOrder([{ appId: 'a' }, { appId: 'b' }, { appId: 'a' }, { appId: 'c' }, { appId: 'b' }]),
        [0, 2, 1, 4, 3]);
    // Windows without an app never group with each other
    eq(groupedOrder([{ appId: null }, { appId: 'a' }, { appId: null }]), [0, 1, 2]);
    eq(groupedOrder([]), []);
});

test('mruOrder: recently used Spaces first, the rest in their order', () => {
    eq(mruOrder(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'a', 'b', 'd']);
    eq(mruOrder(['a', 'b'], ['x', 'b', 'b']), ['b', 'a']);
    eq(mruOrder(['a', 'b'], []), ['a', 'b']);
});

test('touchRecent: moves to the front, no duplicates, bounded', () => {
    eq(touchRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    eq(touchRecent([], 'a'), ['a']);
    eq(touchRecent(['a', 'b', 'c'], 'd', 2), ['d', 'a']);
});

test('skipStartupOverview: at startup or the first start, and when wanted', () => {
    eq(skipStartupOverview({ wanted: true, startingUp: true, firstStart: false }), true);
    eq(skipStartupOverview({ wanted: true, startingUp: false, firstStart: true }), true);
    eq(skipStartupOverview({ wanted: true, startingUp: false, firstStart: false }), false);
    eq(skipStartupOverview({ wanted: false, startingUp: true, firstStart: true }), false);
});

test('stripCardSize: keeps the aspect within the box', () => {
    eq(stripCardSize({ width: 800, height: 600 }, 90, 200), { width: 120, height: 90 });
    eq(stripCardSize({ width: 2000, height: 500 }, 90, 200), { width: 200, height: 50 });
    eq(stripCardSize({ width: 0, height: 0 }, 90, 200), { width: 90, height: 90 });
});

test('reorderIndex: the slot whose half the pointer is in', () => {
    const c = [100, 300, 500];
    eq(reorderIndex(c, 0), 0);
    eq(reorderIndex(c, 199), 0);
    eq(reorderIndex(c, 201), 1);
    eq(reorderIndex(c, 450), 2);
    eq(reorderIndex(c, 9999), 2);
    eq(reorderIndex([], 50), 0);
});

const SHIFT = { maxWidth: 192, thumbnailWidth: 114, spacing: 22, available: 1280 };

test('centringShift: nothing while every Space has its full width', () => {
    eq(centringShift({ ...SHIFT, collapse: [0, 0, 0] }) === 0, true);
    eq(centringShift({ ...SHIFT, collapse: [0] }) === 0, true);
});

test('centringShift: a Space coming in at the end', () => {
    // half the slack (39) to the left, a quarter of the spacing back
    eq(centringShift({ ...SHIFT, collapse: [0, 0, 0, 0, 1] }), -33.5);
    eq(centringShift({ ...SHIFT, collapse: [0, 0, 0, 0, 0.5] }) > -33.5, true);
});

test('centringShift: more Spaces than fit: the group is centred in the room there is', () => {
    const collapse = [0, 0, 0, 0, 0, 0, 0, 0];
    eq(centringShift({ ...SHIFT, collapse }), -205);
});

test('centringShift: thumbnails at the maximum, no Space collapsing: none', () => {
    eq(centringShift({ ...SHIFT, maxWidth: 114, collapse: [0, 0] }) === 0, true);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
