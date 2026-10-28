// Run: gjs -m tests/iconStyleModel.test.js
// lib/iconStyleModel.js (icon styles), lib/pasteModel.js and lib/modalModel.js placeNear.
import { DEFAULT_STYLE, ICON_STYLES, effectPlan, normalizeStyle, normalizeTint } from '../lib/iconStyleModel.js';
import { canKeep, chordKeys, mimeToKeep, pasteChordFor } from '../lib/pasteModel.js';
import { placeNear } from '../lib/modalModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('styles: macOS order, Default by default, unknown is Default', () => {
    eq(ICON_STYLES, ['default', 'dark', 'clear', 'tinted']);
    eq([DEFAULT_STYLE, normalizeStyle('neon'), normalizeStyle('clear')], ['default', 'default', 'clear']);
});
test('default draws no effect', () => {
    const p = effectPlan('default', { dark: true });
    eq([p.effects, p.opacity], [[], 255]);
});
test('every style uses at most two effects (offscreen passes)', () => {
    for (const s of ICON_STYLES)
        for (const dark of [false, true])
            if (effectPlan(s, { dark, tint: [1, 2, 3] }).effects.length > 2)
                throw new Error(s);
});
test('dark darkens; clear decolourises and is translucent; tinted colours with the accent', () => {
    const dark = effectPlan('dark');
    eq(dark.effects[0].kind, 'brightness');
    if (!(dark.effects[0].brightness < 0))
        throw new Error('dark is not darker');
    const clear = effectPlan('clear', { dark: false });
    eq([clear.effects[0], clear.opacity < 255], [{ kind: 'desaturate', factor: 1 }, true]);
    eq(effectPlan('tinted', { tint: [230, 45, 66] }).effects[0], { kind: 'colorize', tint: [230, 45, 66] });
});
test('the key changes only when the look does', () => {
    eq(effectPlan('dark', { dark: true }).key, effectPlan('dark', { dark: false }).key);
    if (effectPlan('clear', { dark: true }).key === effectPlan('clear', { dark: false }).key)
        throw new Error('clear should follow the scheme');
    if (effectPlan('tinted', { tint: [1, 2, 3] }).key === effectPlan('tinted', { tint: [3, 2, 1] }).key)
        throw new Error('tinted should follow the accent');
});
test('tint: clamped integers, blue when unknown', () => {
    eq(normalizeTint([300, -5, 12.6]), [255, 0, 13]);
    eq(normalizeTint(null), [53, 132, 228]);
});

test('paste chord: terminals use Ctrl+Shift+V', () => {
    eq([pasteChordFor('org.gnome.Ptyxis'), pasteChordFor('firefox'), pasteChordFor(null)],
        ['ctrl-shift-v', 'ctrl-v', 'ctrl-v']);
    eq(chordKeys('ctrl-shift-v'), ['Control_L', 'Shift_L', 'V']);
    eq(chordKeys('ctrl-v'), ['Control_L', 'v']);
});
test('saved clipboard: text first, then images; nothing odd or huge', () => {
    eq(mimeToKeep(['image/png', 'text/plain;charset=utf-8']), 'text/plain;charset=utf-8');
    eq(mimeToKeep(['image/png', 'x-special/gnome-copied-files']), 'image/png');
    eq(mimeToKeep(['application/x-foo']), null);
    eq([canKeep(0), canKeep(10), canKeep(64 * 1024 * 1024)], [false, true, false]);
});

const area = { x: 0, y: 0, width: 1280, height: 800 };
test('modal at a caret: below it, above at the bottom, inside the monitor', () => {
    eq(placeNear({ x: 400, y: 100, width: 1, height: 18 }, { width: 372, height: 404 }, area),
        { x: 376, y: 126, above: false });
    eq(placeNear({ x: 400, y: 700, width: 1, height: 18 }, { width: 372, height: 404 }, area),
        { x: 376, y: 700 - 8 - 404, above: true });
    eq(placeNear({ x: 1270, y: 100, width: 1, height: 18 }, { width: 372, height: 404 }, area).x, 1280 - 372 - 12);
    const second = { x: 1280, y: 0, width: 1280, height: 800 };
    eq(placeNear({ x: 1300, y: 100, width: 1, height: 18 }, { width: 372, height: 404 }, second).x, 12);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
