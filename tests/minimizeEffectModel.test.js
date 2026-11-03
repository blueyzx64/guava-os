// Run: gjs -m tests/minimizeEffectModel.test.js
// features/minimizeEffect/model.js: the Genie mesh and the effect choice.
import {
    chooseMode, edgeTarget, genieFrame, genieOpacity, genieRow, genieVertex, readConfig, retarget, scaleFrame,
    scaleTarget, textureBox,
} from '../src/features/minimizeEffect/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function near(a, b, msg = '', tol = 0.5) {
    if (Math.abs(a - b) > tol)
        throw new Error(`${msg} expected ~${b}, got ${a}`);
}

// The mesh the tests sample: few points across the rows, many along the funnel
const GENIE_TILES = Object.freeze({ across: 4, along: 40 });
const ENV = { animations: true, reducedMotion: false };
const base = { effect: 'genie', env: ENV, normal: true, flagged: false, hasTarget: true, overview: false };
const WIN = { x: 200, y: 100, width: 600, height: 400 };
const ICON = { x: 480, y: 740, width: 48, height: 48 };

test('config: unknown effect falls back to Genie (the macOS default)', () => {
    eq(readConfig({ string: () => 'swirl' }).effect, 'genie');
    eq(readConfig({ string: () => 'scale' }).effect, 'scale');
});

test('mode: Genie, Scale, and the cases left to GNOME', () => {
    eq(chooseMode(base), 'genie');
    eq(chooseMode({ ...base, effect: 'scale' }), 'scale');
    eq(chooseMode({ ...base, effect: 'gnome' }), 'stock');
    eq(chooseMode({ ...base, env: { ...base.env, degraded: true } }), 'scale', 'degraded: the Genie falls back to Scale');
    eq(chooseMode({ ...base, env: { ...base.env, degraded: true }, effect: 'gnome' }), 'stock');
    eq(chooseMode({ ...base, env: { ...base.env, degraded: true }, hasTarget: false }), 'stock');
    eq(chooseMode({ ...base, env: { ...base.env, degraded: true }, overview: true }), 'none');
    eq(chooseMode({ ...base, flagged: true }), 'stock', 'Stage Manager owns its windows');
    eq(chooseMode({ ...base, normal: false }), 'stock');
    eq(chooseMode({ ...base, hasTarget: false }), 'stock');
});
test('mode: maximized and full-screen windows get the Genie too (B1: was GNOME\'s fade)', () => {
    eq(chooseMode({ ...base, monitorSized: true }), 'genie');
});
test('mode: in the overview the window goes at once, as GNOME does', () => {
    eq(chooseMode({ ...base, overview: true }), 'none');
    eq(chooseMode({ ...base, overview: true, effect: 'gnome' }), 'stock');
});
test('mode: animations off completes at once; reduced motion fades in place', () => {
    eq(chooseMode({ ...base, env: { animations: false, reducedMotion: false } }), 'none');
    eq(chooseMode({ ...base, env: { animations: true, reducedMotion: true } }), 'fade');
    eq(chooseMode({ ...base, env: { animations: true, reducedMotion: true }, hasTarget: false }), 'fade');
});

// Rows are lines along the dock (index i), stacked from the far edge to the dock (index j)
const mesh = (f, p, w = WIN.width, h = WIN.height) => {
    const pts = [];
    for (let j = 0; j <= GENIE_TILES.along; j++) {
        const row = [];
        const d = j / GENIE_TILES.along;
        for (let i = 0; i <= GENIE_TILES.across; i++) {
            const lt = i / GENIE_TILES.across;
            const [u, v] = f.position === 'bottom' ? [lt, d] : f.position === 'right' ? [d, lt] : [1 - d, lt];
            const o = { x: 0, y: 0 };
            genieVertex(f, u * w, v * h, w, h, p, o);
            row.push(o);
        }
        pts.push(row);
    }
    return pts;
};

for (const position of ['bottom', 'left', 'right']) {
    const icon = position === 'bottom' ? ICON : position === 'left'
        ? { x: 8, y: 380, width: 48, height: 48 } : { x: 1224, y: 380, width: 48, height: 48 };
    const f = genieFrame(position, WIN, icon);
    test(`${position}: progress 0 is the window itself`, () => {
        for (const [x, y] of [[0, 0], [600, 0], [0, 400], [600, 400], [300, 200]]) {
            const o = genieVertex(f, x, y, 600, 400, 0, { x: 0, y: 0 });
            near(o.x, x, 'x');
            near(o.y, y, 'y');
        }
    });
    test(`${position}: progress 1 lands every point in the icon`, () => {
        for (const row of mesh(f, 1)) {
            for (const o of row) {
                const sx = o.x + WIN.x;
                const sy = o.y + WIN.y;
                if (sx < icon.x - 1 || sx > icon.x + icon.width + 1 || sy < icon.y - 1 || sy > icon.y + icon.height + 1)
                    throw new Error(`(${sx},${sy}) outside the icon`);
            }
        }
    });
    test(`${position}: no tearing - the mesh never folds and rows keep their order`, () => {
        for (let k = 0; k <= 20; k++) {
            const pts = mesh(f, k / 20);
            for (let j = 0; j < pts.length; j++) {
                for (let i = 1; i < pts[j].length; i++) {
                    // Across a row the points stay in order (no crossing)
                    const a = pts[j][i - 1];
                    const b = pts[j][i];
                    const across = position === 'bottom' ? b.x - a.x : b.y - a.y;
                    if (across < -1e-6)
                        throw new Error(`p=${k / 20} row ${j} folds across`);
                }
                if (j > 0) {
                    // Along the funnel, rows advance towards the dock monotonically
                    const a = pts[j - 1][0];
                    const b = pts[j][0];
                    const along = position === 'bottom' ? b.y - a.y : position === 'right' ? b.x - a.x : a.x - b.x;
                    if (along < -1e-6)
                        throw new Error(`p=${k / 20} rows ${j - 1},${j} fold along`);
                }
            }
        }
    });
}

test('bottom: the funnel is narrower at the dock end than at the far end mid-way', () => {
    const f = genieFrame('bottom', WIN, ICON);
    const pts = mesh(f, 0.4);
    const width = row => row[row.length - 1].x - row[0].x;
    if (!(width(pts[pts.length - 1]) < width(pts[0])))
        throw new Error('no funnel');
    // Its near edge already reached the icon's centre line before the slide finishes
    near(pts[pts.length - 1][0].y + WIN.y, ICON.y + ICON.height / 2, 'near edge', 60);
});
test('bottom: the sides are smooth curves (second differences stay small)', () => {
    const f = genieFrame('bottom', WIN, ICON);
    const pts = mesh(f, 0.5);
    let worst = 0;
    for (let j = 2; j < pts.length; j++) {
        const d2 = pts[j][0].x - 2 * pts[j - 1][0].x + pts[j - 2][0].x;
        worst = Math.max(worst, Math.abs(d2));
    }
    if (worst > 12)
        throw new Error(`kink of ${worst}px`);
});
test('a window lower than the icon is not pulled away from the dock', () => {
    const f = genieFrame('bottom', { x: 0, y: 0, width: 1280, height: 800 }, ICON);
    eq(f.reach, 0);
});
test('rows: ordered across the window and the curve carries on past its edges', () => {
    const f = genieFrame('bottom', WIN, ICON);
    const row = { s: 0, centre: 0, width: 0 };
    for (const p of [0, 0.3, 0.6, 0.9, 1]) {
        let last = -Infinity;
        for (let i = -2; i <= 12; i++) {
            const s = genieRow(f, i / 10, p, row).s;
            if (s < last)
                throw new Error(`rows fold at p=${p}, d=${i / 10}`);
            last = s;
        }
    }
    eq(f.winW, WIN.width);
    eq(f.winH, WIN.height);
});
test('rows: the near edge of the window lands in the icon at the end', () => {
    const f = genieFrame('bottom', WIN, ICON);
    const row = genieRow(f, 1, 1, { s: 0, centre: 0, width: 0 });
    near(row.s, ICON.y + ICON.height / 2, 'near edge s');
    near(row.centre, ICON.x + ICON.width / 2, 'near edge centre');
    near(row.width, ICON.width, 'near edge width');
});
test('opacity: solid, then gone at the end', () => {
    eq(genieOpacity(0), 255);
    eq(genieOpacity(0.8), 255);
    eq(genieOpacity(1), 0);
    if (!(genieOpacity(0.93) > 0 && genieOpacity(0.93) < 255))
        throw new Error('no fade');
});
test('scale: keeps the aspect ratio, centred in the icon', () => {
    const t = scaleTarget(WIN, ICON);
    near(t.scale, 0.08, 'scale', 0.001);
    near(t.x + WIN.width * t.scale / 2, ICON.x + 24, 'centre x');
    near(t.y + WIN.height * t.scale / 2, ICON.y + 24, 'centre y');
});

test('edgeTarget: the middle of the dock edge of the window\'s monitor (B1: no icon, no Genie)', () => {
    const mon = { x: 1280, y: 0, width: 1920, height: 1080 };
    eq(edgeTarget('bottom', mon), { x: 1280 + 936, y: 1032, width: 48, height: 48 });
    eq(edgeTarget('left', mon), { x: 1280, y: 516, width: 48, height: 48 });
    eq(edgeTarget('right', mon), { x: 1280 + 1872, y: 516, width: 48, height: 48 });
    eq(edgeTarget('bottom', null), null);
    eq(edgeTarget('bottom', { x: 0, y: 0, width: 0, height: 0 }), null);
});
test('retarget: a fresh effect runs the whole way', () => {
    eq(retarget(null, false, 550), { from: 0, to: 1, duration: 550 });
    eq(retarget(undefined, true, 550), { from: 1, to: 0, duration: 550 });
});
test('retarget: restore during a minimize turns back from where it is (B1: was a snap to the icon)', () => {
    eq(retarget(0.4, true, 500), { from: 0.4, to: 0, duration: 200 });
    eq(retarget(0.25, false, 400), { from: 0.25, to: 1, duration: 300 });
    eq(retarget(1.3, true, 100), { from: 1, to: 0, duration: 100 });
    eq(retarget(0, true, 550).duration, 0);
});
test('scaleFrame: from the window to the target, continuous', () => {
    const end = scaleTarget(WIN, ICON);
    eq(scaleFrame(WIN, end, 0), { x: 200, y: 100, scale: 1, opacity: 255 });
    const e = scaleFrame(WIN, end, 1);
    near(e.x, end.x, 'x', 1e-9);
    near(e.scale, end.scale, 'scale', 1e-9);
    eq(e.opacity, 0);
    near(scaleFrame(WIN, end, 0.5).scale, (1 + end.scale) / 2, 'half', 1e-9);
});

test('textureBox: the padded box Clutter renders the Genie into (B1: was taken as the container, blurry)', () => {
    // Measured in GNOME Shell 50.6: a 750x697 container at 265,90 gets a 753x700 texture
    eq(textureBox({ x: 265, y: 90, width: 750, height: 697 }, 753, 700, 1), { x: 263, y: 88, width: 753, height: 700 });
    // 200%: padded in device pixels, one texel per device pixel
    eq(textureBox({ x: 10, y: 10, width: 100, height: 50 }, 203, 103, 2), { x: 9, y: 9, width: 101.5, height: 51.5 });
    // padded before scaling
    eq(textureBox({ x: 10, y: 10, width: 100, height: 50 }, 206, 106, 2), { x: 8, y: 8, width: 103, height: 53 });
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
