// Run: gjs -m tests/minimizeEffectModel.test.js
// features/minimizeEffect/model.js: the Genie mesh and the effect choice.
import {
    chooseMode, genieFrame, genieOpacity, genieRow, genieVertex, readConfig, scaleTarget,
} from '../features/minimizeEffect/model.js';

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
const base = { effect: 'genie', env: ENV, normal: true, flagged: false, hasTarget: true, monitorSized: false };
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
    eq(chooseMode({ ...base, flagged: true }), 'stock', 'Stage Manager owns its windows');
    eq(chooseMode({ ...base, normal: false }), 'stock');
    eq(chooseMode({ ...base, hasTarget: false }), 'stock');
    eq(chooseMode({ ...base, monitorSized: true }), 'stock');
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

if (failed)
    throw new Error(`${failed} test(s) failed`);
