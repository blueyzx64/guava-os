// Run: gjs -m tests/colorFiltersModel.test.js
import { FILTER_KINDS, filterMatrix, hueColor, isIdentity } from '../features/colorFilters/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function near(a, b, eps = 1e-3, msg = '') {
    if (Math.abs(a - b) > eps)
        throw new Error(`${msg} expected ${b}, got ${a}`);
}
const apply = (m, c) => m.map(row => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]);

test('intensity 0 is the identity for every kind', () => {
    for (const kind of FILTER_KINDS) {
        if (!isIdentity(filterMatrix({ kind, intensity: 0, hue: 120 })))
            throw new Error(kind);
    }
});

test('greyscale: equal channels, white stays white', () => {
    const m = filterMatrix({ kind: 'greyscale', intensity: 100, hue: 0 });
    const red = apply(m, [1, 0, 0]);
    near(red[0], red[1]);
    near(red[1], red[2]);
    apply(m, [1, 1, 1]).forEach(v => near(v, 1));
});

test('colour-blind corrections keep greys grey and change red/green', () => {
    for (const kind of ['protanopia', 'deuteranopia', 'tritanopia']) {
        const m = filterMatrix({ kind, intensity: 100, hue: 0 });
        apply(m, [0.5, 0.5, 0.5]).forEach(v => near(v, 0.5, 0.02, kind));
        if (isIdentity(m))
            throw new Error(`${kind} does nothing`);
    }
    const red = apply(filterMatrix({ kind: 'protanopia', intensity: 100, hue: 0 }), [1, 0, 0]);
    if (red[2] <= 0.1)
        throw new Error(`protanopia should move red into blue, got ${red}`);
});

test('tint: hue colours and white maps to the tint', () => {
    const [r, g, b] = hueColor(0);
    near(r, 1);
    near(g, 0.4);
    near(b, 0.4);
    near(hueColor(120)[1], 1);
    near(hueColor(-120)[2], 1);
    const white = apply(filterMatrix({ kind: 'tint', intensity: 100, hue: 240 }), [1, 1, 1]);
    near(white[2], 1);
    near(white[0], 0.4);
});

test('half intensity is halfway', () => {
    const half = filterMatrix({ kind: 'greyscale', intensity: 50, hue: 0 });
    near(half[0][0], (1 + 0.2126) / 2);
    near(half[0][1], 0.7152 / 2);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
