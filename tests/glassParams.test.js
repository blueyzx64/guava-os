// SPDX-License-Identifier: GPL-3.0-or-later
// gjs -m tests/glassParams.test.js
// lib/glassParams.js: the faux Liquid Glass look (fill, edge, rim, variants) for every surface.
import {
    ALPHA_RANGE, SETTING_FIELDS, TINT, WALLPAPER_MIX, fillStyle, glassClasses, hostClasses,
    hostStyle, readSnapshot, resolve, roleFor, sliderAlpha,
    stripFragments, wantsSurface, worstCaseContrast, wrapFragment,
} from '../lib/glassParams.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

const snap = (over = {}) => ({
    liquid: true, surfaces: ['panel', 'menus', 'dock', 'overlays'], tint: 0, wallpaperTint: true,
    reduceTransparency: false, increaseContrast: false, showBorders: false, noise: false, ...over,
});
const env = (over = {}) => ({ dark: true, highContrast: false, reducedMotion: false, wallpaper: null, ...over });

test('defaults follow macOS: glass on, Clear, wallpaper tint on, accessibility off', () => {
    const d = Object.fromEntries(Object.values(SETTING_FIELDS));
    eq([d.liquid, d.tint, d.wallpaperTint, d.reduceTransparency, d.increaseContrast, d.showBorders, d.noise],
        [true, 0, true, false, false, false, false]);
});

test('surfaces: the list and the master switch decide', () => {
    ok(wantsSurface(snap(), 'menus'), 'menus wanted');
    ok(!wantsSurface(snap({ surfaces: ['dock'] }), 'menus'), 'list respected');
    ok(!wantsSurface(snap({ liquid: false }), 'dock'), 'master off');
    eq(resolve(snap({ liquid: false }), env(), 'menus').tier, 'off');
    eq(glassClasses(resolve(snap({ liquid: false }), env(), 'menus'), 'menus'), []);
    eq(fillStyle(resolve(snap({ liquid: false }), env(), 'menus')), '');
});

test('roles: bars for the menu bar and dock, content elsewhere, callers may say', () => {
    eq([roleFor('panel'), roleFor('dock'), roleFor('menus'), roleFor('overlays')], ['bar', 'bar', 'content', 'content']);
    eq(roleFor('overlays', 'bar'), 'bar');
    eq(roleFor('menus', 'large'), 'content', 'legacy role names map to the surface default');
});

test('Clear <-> Tinted slider spans the role range', () => {
    eq(sliderAlpha(0, 'content'), ALPHA_RANGE.content[0]);
    eq(sliderAlpha(100, 'content'), ALPHA_RANGE.content[1]);
    ok(sliderAlpha(50, 'bar') > ALPHA_RANGE.bar[0] && sliderAlpha(50, 'bar') < ALPHA_RANGE.bar[1], 'bar mid');
    eq(sliderAlpha(-5, 'content'), ALPHA_RANGE.content[0], 'clamped');
    ok(resolve(snap({ tint: 100 }), env(), 'menus').alpha > resolve(snap(), env(), 'menus').alpha, 'tinted is denser');
});

test('the fill is a gradient: lighter top (sheen), denser darker bottom (shade)', () => {
    for (const dark of [true, false]) {
        const l = resolve(snap(), env({ dark }), 'menus');
        ok(l.top && l.bottom, 'two stops');
        ok(l.top[0] > l.bottom[0], `top lighter (${dark ? 'dark' : 'light'})`);
        ok(l.bottom[3] > l.top[3], 'bottom denser');
        const s = fillStyle(l);
        ok(s.includes('background-gradient-direction: vertical') && s.includes('background-gradient-end'), s);
    }
});

test('text stays readable over the worst backdrop at the clearest setting (4.5:1)', () => {
    for (const dark of [true, false]) {
        for (const surface of ['overlays', 'panel']) {
            const l = resolve(snap({ tint: 0 }), env({ dark }), surface);
            ok(worstCaseContrast(l) >= 4.5, `${surface} ${dark ? 'dark' : 'light'}: ${worstCaseContrast(l).toFixed(2)}`);
        }
    }
});

test('a bright or dark wallpaper never takes the text below 4.5:1 (the tint floor)', () => {
    for (const dark of [true, false]) {
        for (const wallpaper of [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 0, 255], [128, 128, 128]]) {
            for (const surface of ['panel', 'dock', 'menus', 'overlays']) {
                for (const noise of [false, true]) {
                    const l = resolve(snap({ tint: 0, noise }), env({ dark, wallpaper }), surface);
                    ok(worstCaseContrast(l) >= 4.5, `${surface} ${dark} ${wallpaper} ${noise}: ${worstCaseContrast(l).toFixed(2)}`);
                }
            }
        }
    }
    const plain = resolve(snap({ tint: 0 }), env({ dark: true }), 'panel');
    const bright = resolve(snap({ tint: 0 }), env({ dark: true, wallpaper: [255, 255, 255] }), 'panel');
    ok(bright.alpha > plain.alpha, 'denser on a bright wallpaper');
});

test('wallpaper tint: 8 % of the wallpaper colour, only when wanted and translucent', () => {
    const red = [255, 0, 0];
    const tinted = resolve(snap(), env({ wallpaper: red }), 'menus');
    const plain = resolve(snap(), env(), 'menus');
    ok(tinted.top[0] > plain.top[0] && tinted.top[2] < plain.top[2], 'redder');
    const expectBase = Math.round(TINT.dark[0] + (255 - TINT.dark[0]) * WALLPAPER_MIX);
    ok(Math.abs(resolve(snap({ noise: true }), env({ wallpaper: red }), 'menus').top[0] - expectBase) <= 1, 'mix share');
    eq(resolve(snap({ wallpaperTint: false }), env({ wallpaper: red }), 'menus').top, plain.top, 'off');
    eq(resolve(snap({ reduceTransparency: true }), env({ wallpaper: red }), 'menus').top,
        resolve(snap({ reduceTransparency: true }), env(), 'menus').top, 'not under Reduce Transparency');
});

test('Reduce Transparency: opaque, rim kept, no grain', () => {
    const l = resolve(snap({ reduceTransparency: true, noise: true }), env(), 'menus');
    eq([l.tier, l.alpha, l.top[3], l.noise], ['solid', 1, 1, false]);
    const c = glassClasses(l, 'menus');
    ok(c.includes('guava-glass-solid') && !c.includes('guava-glass-contrast'), c.join());
});

test('Increase Contrast and GNOME high contrast: flat, opaque, strong edge', () => {
    for (const l of [resolve(snap({ increaseContrast: true }), env(), 'menus'),
        resolve(snap(), env({ highContrast: true }), 'menus')]) {
        eq([l.tier, l.alpha, l.bottom, l.edge], ['solid', 1, null, 'contrast']);
        ok(glassClasses(l, 'menus').includes('guava-glass-contrast'), 'class');
        ok(fillStyle(l).includes('background-gradient-direction: none'), 'no gradient');
        ok(worstCaseContrast(l) >= 7, 'AAA');
    }
});

test('Show Borders adds the borders edge; contrast wins over it', () => {
    ok(glassClasses(resolve(snap({ showBorders: true }), env(), 'dock'), 'dock').includes('guava-glass-borders'), 'borders');
    eq(resolve(snap({ showBorders: true, increaseContrast: true }), env(), 'dock').edge, 'contrast');
});

test('grain: a flat fill (St draws an image or a gradient, not both)', () => {
    const l = resolve(snap({ noise: true }), env(), 'menus');
    eq([l.noise, l.bottom], [true, null]);
    ok(glassClasses(l, 'menus').includes('guava-glass-noise'), 'class');
});

test('classes: scheme, surface, role, motion', () => {
    const c = glassClasses(resolve(snap(), env({ dark: false, reducedMotion: true }), 'dock'), 'dock');
    eq(c.slice(0, 4), ['guava-glass', 'guava-glass-dock', 'guava-glass-bar', 'guava-glass-light']);
    ok(c.includes('guava-glass-static'), 'reduced motion');
    eq(hostClasses(resolve(snap(), env(), 'menus')), ['guava-glass-shadow', 'guava-glass-dark']);
    eq(hostClasses(resolve(snap({ liquid: false }), env(), 'menus')), []);
});

test('a content surface writes its rim inline, over the theme outer shadow', () => {
    ok(fillStyle(resolve(snap(), env({ dark: true }), 'menus')).includes('box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.22)'), 'dark rim');
    ok(fillStyle(resolve(snap(), env({ dark: false }), 'menus')).includes('rgba(255, 255, 255, 0.95)'), 'light rim');
    ok(!fillStyle(resolve(snap(), env(), 'panel')).includes('box-shadow'), 'a bar keeps the stylesheet');
    ok(fillStyle(resolve(snap({ increaseContrast: true }), env(), 'menus')).includes('box-shadow: none'), 'contrast: no rim');
});

test('fragments are fenced, so they come off wherever they ended up', () => {
    const f = fillStyle(resolve(snap(), env(), 'menus'), 24);
    ok(f.includes('border-radius: 24px;'), 'radius');
    const other = 'min-width: 300px;';
    eq(stripFragments(other + f), other);
    eq(stripFragments(f + other + f), other, 'a stale copy in the middle goes too');
    eq(stripFragments(other + hostStyle(18)), other);
    eq(wrapFragment(''), '');
    eq(stripFragments(null), '');
});

test('readSnapshot reads typed keys, defaults for missing ones', () => {
    const values = { 'liquid-glass': false, 'glass-tint': 70, 'liquid-glass-surfaces': ['dock'] };
    const gs = {
        settings_schema: { has_key: k => k in values },
        get_boolean: k => values[k], get_int: k => values[k], get_strv: k => values[k],
    };
    const s = readSnapshot(gs);
    eq([s.liquid, s.tint, s.surfaces, s.reduceTransparency], [false, 70, ['dock'], false]);
    eq(readSnapshot(null).liquid, true);
});


if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
