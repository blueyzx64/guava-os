// Run: gjs -m tests/lockScreenModel.test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    TOKENS, bigTime, contrast, hintLine, layout, normalizeOptions, notificationRule, powerActions,
    pressPower, worstCaseContrast, CONFIRM_MS, MESSAGE_MAX,
} from '../features/lockScreen/model.js';

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

test('options: defaults follow macOS System Settings > Lock Screen', () => {
    eq(normalizeOptions({}), {
        enabled: true, clock: 'lock-screen', wallpaper: 'sharp', showUser: true, message: '',
        powerButtons: false, nowPlaying: true, notifications: 'count', hint: false,
    });
});

test('options: unknown choices fall back; the message needs its switch and is cleaned', () => {
    const o = normalizeOptions({ clock: 'always', wallpaper: 'glass', notifications: 'bodies', messageOn: false, message: 'hi' });
    eq([o.clock, o.wallpaper, o.notifications, o.message], ['lock-screen', 'sharp', 'count', '']);
    eq(normalizeOptions({ messageOn: true, message: '  Found  me?\n\tCall 555  ' }).message, 'Found me? Call 555');
    eq(Array.from(normalizeOptions({ messageOn: true, message: 'x'.repeat(500) }).message).length, MESSAGE_MAX);
    eq(normalizeOptions({ messageOn: true, message: '\u{1F600}'.repeat(300) }).message.length, MESSAGE_MAX * 2);
    eq(normalizeOptions({ enabled: false }).enabled, false);
});

test('bigTime: no AM / PM, 24 h text untouched', () => {
    eq(bigTime('10:30 AM'), '10:30');
    eq(bigTime(' 9:05 p.m. '), '9:05');
    eq(bigTime('9:05pm'), '9:05');
    eq(bigTime('21:45'), '21:45');
    eq(bigTime(''), '');
    eq(bigTime(null), '');
});

const input = (over = {}) => ({
    width: 1920, height: 1080, scale: 1, clock: { w: 420, h: 220 }, stack: { w: 320, h: 230 },
    notes: { w: 380, h: 400 }, message: null, power: null, switchUser: null, ...over,
});
const inside = (b, w, h) => b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h;
const apart = (a, b) => a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x;

test('layout: clock in the upper third, password at the bottom centre', () => {
    const l = layout(input());
    ok(l.clock.y + l.clock.h <= 1080 / 3 + 120, 'clock high');
    eq(l.clock.x * 2 + l.clock.w, 1920, 'clock centred');
    eq(l.stack.x * 2 + l.stack.w, 1920, 'stack centred');
    ok(l.stack.y > 1080 / 2, 'stack in the lower half');
    ok(l.stack.y + l.stack.h <= 1080, 'stack on screen');
});

test('layout: nothing overlaps or leaves the screen, for monitors from 1366x768 to 4K and scales', () => {
    for (const [w, h, scale] of [[1366, 768, 1], [1920, 1080, 1], [1920, 1080, 2], [3840, 2160, 2], [1280, 720, 1]]) {
        for (const extra of [{}, { power: { w: 300, h: 90 } }, { message: { w: 500, h: 40 } },
            { power: { w: 300, h: 90 }, message: { w: 500, h: 40 }, switchUser: { w: 48, h: 48 } }]) {
            const l = layout(input({ width: w, height: h, scale, ...extra }));
            const parts = ['clock', 'stack', 'notes', 'message', 'power'].map(k => l[k]).filter(Boolean);
            for (const p of parts)
                ok(inside(p, w, h), `${w}x${h}@${scale} ${JSON.stringify(p)} off screen`);
            for (let i = 0; i < parts.length; i++) {
                for (let j = i + 1; j < parts.length; j++)
                    ok(apart(parts[i], parts[j]), `${w}x${h}@${scale} ${JSON.stringify(parts[i])} overlaps ${JSON.stringify(parts[j])}`);
            }
        }
    }
});

test('layout: notifications shrink to the room left and drop when it is too small', () => {
    const tall = layout(input({ notes: { w: 380, h: 900 } }));
    ok(tall.notes.y + tall.notes.h <= tall.stack.y, 'above the password');
    const tiny = layout(input({ width: 800, height: 420, notes: { w: 380, h: 300 } }));
    eq(tiny.notes, null);
    eq(layout(input({ notes: null })).notes, null);
});

test('layout: no clock leaves the top free; the switch-user button keeps the stock corner (RTL mirrored)', () => {
    eq(layout(input({ clock: null })).clock, null);
    const ltr = layout(input({ switchUser: { w: 48, h: 48 } })).switchUser;
    eq([ltr.x, ltr.y], [1920 - 96, 1080 - 96]);
    eq(layout(input({ switchUser: { w: 48, h: 48 }, rtl: true })).switchUser.x, 48);
});

test('power: the buttons logind allows, in macOS order', () => {
    eq(powerActions({ suspend: true, restart: true, poweroff: true }).map(a => a.id), ['suspend', 'restart', 'poweroff']);
    eq(powerActions({ poweroff: true }).map(a => a.id), ['poweroff']);
    eq(powerActions({}), []);
});

test('power: Sleep runs at once; Restart and Shut Down need a second press in time', () => {
    const [sleep, restart, off] = powerActions({ suspend: true, restart: true, poweroff: true });
    eq(pressPower(null, sleep, 0), { armed: null, run: 'suspend' });
    const first = pressPower(null, restart, 1000);
    eq(first.run, null);
    eq(first.armed, { id: 'restart', until: 1000 + CONFIRM_MS });
    eq(pressPower(first.armed, restart, 1000 + CONFIRM_MS), { armed: null, run: 'restart' });
    eq(pressPower(first.armed, restart, 1001 + CONFIRM_MS).run, null, 'too late re-arms');
    eq(pressPower(first.armed, off, 1500).armed.id, 'poweroff', 'another button re-arms');
});

test('notifications: never a body; never hides the list', () => {
    eq(notificationRule('count'), { sources: true, details: false });
    eq(notificationRule('never'), { sources: false, details: false });
    eq(notificationRule('bodies').details, false);
});

test('hint: off by default, after three failures, only when the account has one', () => {
    eq(hintLine(false, 'My dog', 5), '');
    eq(hintLine(true, 'My dog', 2), '');
    eq(hintLine(true, 'My  dog\n', 3), 'My dog');
    eq(hintLine(true, '   ', 9), '');
    eq(hintLine(true, null, 9), '');
});

test('contrast: small text on the capsule >= 4.5 over a white wallpaper', () => {
    ok(worstCaseContrast([TOKENS.capsule]) >= 4.5, `${worstCaseContrast([TOKENS.capsule])}`);
    ok(worstCaseContrast([TOKENS.capsule]) >= 7, 'AAA');
});

test('contrast: large text (clock, date, name) >= 3 over the sharp wallpaper, any wallpaper', () => {
    ok(worstCaseContrast([TOKENS.scrim]) >= 3, `${worstCaseContrast([TOKENS.scrim])}`);
});

test('contrast: blurred wallpaper (Shell dims it to 0.65) with the light scrim stays >= 3', () => {
    const b = TOKENS.blurBrightness * 255;
    const c = worstCaseContrast([TOKENS.scrimBlurred], TOKENS.text, [b, b, b]);
    ok(c >= 3, `${c}`);
});

test('contrast: sanity (black on white is 21)', () => {
    ok(Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 0.01, 'ratio');
});

test('style.css repeats the tokens', () => {
    const dir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
    const [, bytes] = Gio.File.new_for_path(`${dir}/../features/lockScreen/style.css`).load_contents(null);
    const css = new TextDecoder().decode(bytes);
    const rgba = t => `rgba(${t.rgb.join(', ')}, ${t.alpha})`;
    for (const t of [TOKENS.scrim, TOKENS.capsule, TOKENS.scrimBlurred])
        ok(css.includes(rgba(t)), `style.css lacks ${rgba(t)}`);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
