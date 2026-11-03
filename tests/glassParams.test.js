// SPDX-License-Identifier: GPL-3.0-or-later
// gjs -m tests/glassParams.test.js
// lib/glassParams.js: the Liquid Glass look (fill, edge, rim, variants) for every surface.
import {
    ALPHA_RANGE, BLUR_ALPHA_RANGE, LoadGovernor, SETTING_FIELDS, captureMargin, captureMode, downscaleFor,
    effectColors, TINT, WALLPAPER_MIX, fillStyle, glassClasses, hostClasses,
    hostStyle, readSnapshot, liveCaptureDue, LIVE_CAPTURE_MS, LIVE_CAPTURE_DEGRADED_MS, resolve, roleFor, sliderAlpha,
    clipCovers, clipToDevice, captureRects, intersectRect, textureSide, TEXTURE_STEP,
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


test('blur: a lighter tint over a blurred, darkened or lifted backdrop, still 4.5:1', () => {
    for (const dark of [true, false]) {
        for (const wallpaper of [null, [255, 255, 255], [0, 0, 0]]) {
            for (const surface of ['panel', 'dock', 'menus', 'overlays']) {
                const l = resolve(snap({ tint: 0 }), env({ dark, wallpaper, blur: true }), surface);
                ok(l.blur && l.blur.sigma > 0, `${surface} has blur`);
                ok(worstCaseContrast(l) >= 4.5, `${surface} ${dark} ${wallpaper}: ${worstCaseContrast(l).toFixed(2)}`);
                const faux = resolve(snap({ tint: 0 }), env({ dark, wallpaper }), surface);
                ok(l.alpha < faux.alpha, `${surface} ${dark}: blur ${l.alpha} < faux ${faux.alpha}`);
            }
        }
    }
    eq(sliderAlpha(0, 'bar', true), BLUR_ALPHA_RANGE.bar[0]);
});

test('blur off under Reduce Transparency and contrast; the effect makes St transparent', () => {
    eq(resolve(snap({ reduceTransparency: true }), env({ blur: true }), 'menus').blur, null);
    eq(resolve(snap({ increaseContrast: true }), env({ blur: true }), 'menus').blur, null);
    const l = resolve(snap(), env({ blur: true }), 'menus');
    ok(fillStyle(l, null, true).includes('background-color: transparent;'), 'transparent');
    ok(!fillStyle(l, null, true).includes('gradient-end'), 'no St gradient');
    const c = effectColors(l);
    eq(c.top.length, 4);
    ok(c.top[0] <= 1 && c.bottom[3] <= 1, 'floats');
});

test('capture: static for bar and dock, live for floating; margin; downscale keeps detail', () => {
    eq(captureMode('panel'), 'auto');
    eq(captureMode('dock'), 'auto');
    eq(captureMode('menus'), 'live');
    eq(captureMargin('panel', 20), 0);
    eq(captureMargin('menus', 20.2), 21);
    eq(downscaleFor(4, 400, 300), 1);
    eq(downscaleFor(44, 400, 300), 8);
    eq(downscaleFor(36, 2560, 64), 8, 'thin bar still downscales');
    eq(downscaleFor(36, 2560, 8), 2, 'never below 4 px a side');
});

test('governor: sustained slow frames freeze live blur, fast frames bring it back', () => {
    const g = new LoadGovernor({ window: 8, recoverMs: 1000 });
    let t = 0;
    for (let i = 0; i < 20; i++)
        g.frame(t += 16, 16.7);
    ok(!g.frozen, 'fast frames');
    for (let i = 0; i < 4; i++)
        g.frame(t += 60, 16.7);
    ok(!g.frozen, 'a few slow frames are not load');
    for (let i = 0; i < 10; i++)
        g.frame(t += 60, 16.7);
    ok(g.frozen, 'sustained slow frames freeze');
    g.frame(t += 2000, 16.7);
    ok(g.frozen, 'an idle gap is no evidence');
    for (let i = 0; i < 70; i++)
        g.frame(t += 16, 16.7);
    ok(!g.frozen, 'recovers after 1 s of fast frames');
});

test('governor: idle() reads the governor clock, so a frozen governor stays frozen under load', () => {
    let now = 5e6;          // monotonic ms, as the frames are timed
    const g = new LoadGovernor({ window: 8, recoverMs: 3000, clock: () => now });
    for (let i = 0; i < 20; i++)
        g.frame(now += 16, 16.7);
    for (let i = 0; i < 14; i++)
        g.frame(now += 60, 16.7);
    ok(g.frozen, 'frozen');
    now += 1000;
    g.idle();
    ok(g.frozen, 'one second later (< recoverMs) it stays frozen');
    now += 3000;
    g.idle();
    ok(!g.frozen, 'no live frame for recoverMs: reset');
    // the wall clock (1.7e12) against the monotonic one is the bug this guards: it always resets
    const h = new LoadGovernor({ window: 8, recoverMs: 3000 });
    let t = 5e6;
    for (let i = 0; i < 20; i++)
        h.frame(t += 16, 16.7);
    for (let i = 0; i < 14; i++)
        h.frame(t += 60, 16.7);
    h.idle(Date.now());
    ok(!h.frozen, 'documents why the clocks must match');
});

test('clipToDevice: shrinks inwards, one logical px more at fractional scale', () => {
    eq(clipToDevice([{ x: 10, y: 20, width: 100, height: 50 }], { x: 0, y: 0 }, 2),
        [{ x1: 20, y1: 40, x2: 220, y2: 140 }]);
    eq(clipToDevice([{ x: 10, y: 20, width: 100, height: 50 }], { x: 0, y: 0 }, 1.25),
        [{ x1: 14, y1: 27, x2: 136, y2: 86 }]);
    eq(clipToDevice([{ x: 1280, y: 0, width: 10, height: 10 }], { x: 1280, y: 0 }, 1),
        [{ x1: 0, y1: 0, x2: 10, y2: 10 }], 'relative to the view');
    eq(clipToDevice([{ x: 0, y: 0, width: 1, height: 1 }], { x: 0, y: 0 }, 1.25), [], 'too thin to trust');
    eq(clipToDevice([{ x: 10, y: 20, width: 100, height: 50 }], { x: 0, y: 0 }, 1.25, 0),
        [{ x1: 13, y1: 25, x2: 137, y2: 87 }], 'exact: for the coverage test');
});

test('clipCovers: the redraw clip must cover the whole surface box to trust a full capture', () => {
    const box = { x1: 100, y1: 100, x2: 300, y2: 160 };
    ok(clipCovers(box, null), 'null clip: everything redrawn');
    ok(clipCovers(box, [{ x1: 0, y1: 0, x2: 1280, y2: 800 }]), 'full');
    ok(clipCovers(box, [{ x1: 90, y1: 90, x2: 200, y2: 200 }, { x1: 200, y1: 90, x2: 400, y2: 200 }]), 'two rects');
    ok(!clipCovers(box, [{ x1: 120, y1: 110, x2: 150, y2: 130 }]), 'a hover highlight does not');
    ok(!clipCovers(box, []), 'empty clip');
});

test('captureRects: inside the box only the redraw clip is read, the margin always', () => {
    const cap = { x1: 90, y1: 90, x2: 310, y2: 170 };
    const box = { x1: 100, y1: 100, x2: 300, y2: 160 };
    eq(captureRects(cap, box, null), [cap], 'no clip: everything');
    const hover = { x1: 120, y1: 110, x2: 150, y2: 130 };
    const rects = captureRects(cap, box, [hover]);
    eq(rects.length, 5, '4 margin strips and the hover rect');
    eq(rects[4], hover);
    // nothing read inside the box outside the clip
    for (const r of rects.slice(0, 4))
        eq(intersectRect(r, box), null, 'strip is outside the box');
    eq(captureRects(cap, box, []).length, 4, 'empty clip: margin only');
    eq(captureRects(cap, box, [{ x1: 0, y1: 0, x2: 2000, y2: 2000 }]).slice(4), [box], 'clip clamps to the box');
});

test('textureSide: rounds up only when asked, so a growing dock reuses its textures', () => {
    eq(textureSide(1000, 1), 1000);
    eq(textureSide(1000, TEXTURE_STEP), 1024);
    eq(textureSide(1024, TEXTURE_STEP), 1024);
    eq(textureSide(1025, TEXTURE_STEP), 1088);
});

test('liveCaptureDue: first capture at once, then throttled; slower while degraded', () => {
    ok(liveCaptureDue(-1, 1000), 'no capture yet');
    ok(!liveCaptureDue(1000, 1000 + LIVE_CAPTURE_MS - 1), 'too soon');
    ok(liveCaptureDue(1000, 1000 + LIVE_CAPTURE_MS), 'due');
    ok(!liveCaptureDue(1000, 1000 + LIVE_CAPTURE_MS, true), 'degraded waits longer');
    ok(liveCaptureDue(1000, 1000 + LIVE_CAPTURE_DEGRADED_MS, true), 'degraded due');
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
