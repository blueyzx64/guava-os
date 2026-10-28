// Run: gjs -m tests/roundedCornersModel.test.js
import {
    RADIUS_DEFAULT, WHICH_DEFAULT, WHICH_VALUES, clampRadius, cornerMask, enlargeForEffects, fboOrigin, fitRadius, frameInActor,
    isExcluded, normalizeId, qualifies, shaderGeometry,
} from '../features/roundedCorners/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

const normal = (over = {}) => ({
    type: 'normal', overrideRedirect: false, maximizedH: false, maximizedV: false,
    fullscreen: false, shellOwned: false, title: 'Notes', ids: ['org.gnome.TextEditor', null], ...over,
});
const cfg = (over = {}) => ({ radius: 12, blacklist: [], ...over });

test('clampRadius: range, rounding and junk', () => {
    eq(clampRadius(12), 12);
    eq(clampRadius(-3), 0);
    eq(clampRadius(99), 24);
    eq(clampRadius(7.6), 8);
    eq(clampRadius('x'), RADIUS_DEFAULT);
    eq(clampRadius(undefined), RADIUS_DEFAULT);
});

test('cornerMask: top (default) rounds TL and TR only, all rounds four', () => {
    eq(WHICH_DEFAULT, 'top');
    eq(WHICH_VALUES, ['top', 'all']);
    eq(cornerMask('top'), [1, 1, 0, 0]);
    eq(cornerMask('all'), [1, 1, 1, 1]);
    eq(cornerMask(''), [1, 1, 0, 0]);
    eq(cornerMask(undefined), [1, 1, 0, 0]);
    eq(cornerMask('bottom'), [1, 1, 0, 0]);
});

test('fitRadius: never more than half the shorter side', () => {
    eq(fitRadius(12, 800, 600), 12);
    eq(fitRadius(12, 15, 600), 7);
    eq(fitRadius(12, 0, 0), 0);
});

test('qualifies: normal and dialog windows at normal size', () => {
    eq(qualifies(normal(), cfg()), true);
    eq(qualifies(normal({ type: 'dialog' }), cfg()), true);
    eq(qualifies(normal({ type: 'modal-dialog' }), cfg()), true);
});

test('qualifies: maximized, tiled and fullscreen stay square', () => {
    eq(qualifies(normal({ maximizedH: true, maximizedV: true }), cfg()), false);
    eq(qualifies(normal({ maximizedV: true }), cfg()), false);   // half tiled
    eq(qualifies(normal({ maximizedH: true }), cfg()), false);
    eq(qualifies(normal({ fullscreen: true }), cfg()), false);
});

test('qualifies: roundMaximized rounds a window maximized both ways, nothing else', () => {
    eq(qualifies(normal({ maximizedH: true, maximizedV: true }), cfg({ roundMaximized: true })), true);
    eq(qualifies(normal({ maximizedV: true }), cfg({ roundMaximized: true })), false);
    eq(qualifies(normal({ fullscreen: true, maximizedH: true, maximizedV: true }), cfg({ roundMaximized: true })), false);
});

test('qualifies: menus, popups, docks, desktops, OR windows and the Shell never', () => {
    for (const type of ['other', 'menu', 'popup-menu', 'tooltip', 'dnd', 'dock', 'desktop', 'utility'])
        eq(qualifies(normal({ type }), cfg()), false);
    eq(qualifies(normal({ overrideRedirect: true }), cfg()), false);
    eq(qualifies(normal({ shellOwned: true }), cfg()), false);
    eq(qualifies(normal({ title: '@!0,0;BDHF' }), cfg()), false);
});

test('qualifies: radius 0 turns it off', () => {
    eq(qualifies(normal(), cfg({ radius: 0 })), false);
});

test('blacklist: WM_CLASS or app id, case-insensitive, .desktop ignored', () => {
    eq(normalizeId(' Org.Gnome.Terminal.desktop '), 'org.gnome.terminal');
    eq(normalizeId(null), '');
    eq(isExcluded(['firefox', null, undefined], ['Firefox']), true);
    eq(isExcluded(['org.gnome.TextEditor'], ['org.gnome.texteditor.desktop']), true);
    eq(isExcluded(['org.gnome.TextEditor'], []), false);
    eq(isExcluded(['org.gnome.TextEditor'], ['', '  ']), false);
    eq(qualifies(normal(), cfg({ blacklist: ['ORG.GNOME.TEXTEDITOR'] })), false);
    eq(qualifies(normal(), cfg({ blacklist: ['firefox'] })), true);
});

test('frameInActor: CSD shadow margins become the inset', () => {
    eq(frameInActor({ x: 123, y: 87, width: 500, height: 300 }, { x: 100, y: 60, width: 546, height: 354 }),
        { x: 23, y: 27, width: 500, height: 300 });
    // server-side decorated / no margins
    eq(frameInActor({ x: 10, y: 10, width: 50, height: 40 }, { x: 10, y: 10, width: 50, height: 40 }),
        { x: 0, y: 0, width: 50, height: 40 });
});

test('enlargeForEffects matches mutter: +3 px, pixel-aligned bottom-right', () => {
    eq(enlargeForEffects({ x1: 0, y1: 0, x2: 100, y2: 50 }), { x1: -2, y1: -2, x2: 101, y2: 51 });
    eq(enlargeForEffects({ x1: 0.4, y1: 0, x2: 100.4, y2: 50 }), { x1: -1, y1: -2, x2: 102, y2: 51 });
    eq(enlargeForEffects({ x1: 0, y1: 0, x2: 0, y2: 50 }), { x1: 0, y1: 0, x2: 0, y2: 50 });
});

test('fboOrigin: from the paint volume, else relative to the allocation', () => {
    eq(fboOrigin({ x: 0, y: 0, width: 546, height: 354 }, { x1: 100, y1: 60, x2: 646, y2: 414 }), { x: -2, y: -2 });
    // an SSD shadow volume reaching left and up of the actor
    eq(fboOrigin({ x: -20, y: -14, width: 540, height: 352 }, { x1: 0, y1: 0, x2: 500, y2: 320 }), { x: -22, y: -16 });
    eq(fboOrigin(null, { x1: 100, y1: 60, x2: 646, y2: 414 }), { x: -2, y: -2 });
});

test('shaderGeometry: scale 1', () => {
    const g = shaderGeometry({
        frame: { x: 23, y: 27, width: 500, height: 300 }, origin: { x: -2, y: -2 },
        radius: 12, resourceScale: 1, texWidth: 549, texHeight: 357,
    });
    eq(g, { tex: [549, 357], frame: [25, 29, 525, 329], radius: 12, aa: 1 });
});

test('shaderGeometry: HiDPI and fractional scaling render at the ceiled scale', () => {
    const base = {
        frame: { x: 23, y: 27, width: 500, height: 300 }, origin: { x: -2, y: -2 },
        radius: 12, texWidth: 1098, texHeight: 714,
    };
    eq(shaderGeometry({ ...base, resourceScale: 2 }),
        { tex: [1098, 714], frame: [50, 58, 1050, 658], radius: 24, aa: 1 });
    const f = shaderGeometry({ ...base, resourceScale: 1.25 });
    eq(f.frame, [50, 58, 1050, 658]);
    eq(f.radius, 24);
    eq(f.aa, 1.6);     // one screen pixel is 1.6 texture pixels at 2x for 1.25
    eq(shaderGeometry({ ...base, resourceScale: 0 }).aa, 1);
});

test('shaderGeometry: radius fits a tiny frame', () => {
    const g = shaderGeometry({
        frame: { x: 0, y: 0, width: 10, height: 300 }, origin: { x: -2, y: -2 },
        radius: 12, resourceScale: 1, texWidth: 13, texHeight: 303,
    });
    eq(g.radius, 5);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
