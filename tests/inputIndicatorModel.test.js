// Run: gjs -m tests/inputIndicatorModel.test.js
// features/inputIndicator/model.js and lib/caretModel.js: badge text, caret trust, placement.
import {
    CAPS_GLYPH, CARET_GAP, CapsWatch, POINTER_OFFSET, SCREEN_MARGIN, badgeFor, isSourceSwitch, placeBadge,
    readConfig, sourceLabel,
} from '../features/inputIndicator/model.js';
import { CaretTracker } from '../lib/caretModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const on = { enabled: true, capsLock: true, source: true };

test('config reads the three keys', () => {
    const v = { 'input-indicator': true, 'input-indicator-caps-lock': false, 'input-indicator-source': true };
    eq(readConfig({ bool: k => v[k] }), { enabled: true, capsLock: false, source: true });
});
test('badge: accent glyph on, muted glyph off, source short name; settings turn parts off', () => {
    eq(badgeFor({ type: 'caps', on: true }, on), { text: CAPS_GLYPH, style: 'caps-on', key: 'caps-on' });
    eq(badgeFor({ type: 'caps', on: false }, on).style, 'caps-off');
    eq(badgeFor({ type: 'source', source: { shortName: 'de', displayName: 'German' } }, on).text, 'DE');
    eq(badgeFor({ type: 'caps', on: true }, { ...on, capsLock: false }), null);
    eq(badgeFor({ type: 'source', source: { shortName: 'en' } }, { ...on, source: false }), null);
    eq(badgeFor({ type: 'caps', on: true }, { ...on, enabled: false }), null);
    eq(badgeFor({ type: 'source', source: {} }, on), null);
});
test('source label: capitals, at most three, scripts without case unchanged', () => {
    eq([sourceLabel({ shortName: 'en' }), sourceLabel({ shortName: 'あ' }), sourceLabel({ displayName: 'Dvorak' })],
        ['EN', 'あ', 'DVO']);
});
test('source switch: not at startup, not to the same source', () => {
    eq([isSourceSwitch(null, 'us'), isSourceSwitch('us', 'us'), isSourceSwitch('us', 'de')], [false, false, true]);
});
test('caps watch reports only Caps Lock edges', () => {
    const w = new CapsWatch(false);
    eq([w.update(false), w.update(true), w.update(true), w.update(false)], [null, true, null, false]);
});
test('caret: an empty rect clears it; a focus change forgets it', () => {
    const c = new CaretTracker();
    c.report({ x: 10, y: 20, width: 1, height: 18 });
    eq(c.rect, { x: 10, y: 20, width: 1, height: 18 });
    c.report({ x: 0, y: 0, width: 0, height: 0 });
    eq(c.rect, null);
    c.report({ x: 5, y: 6, width: 0, height: 15 });
    c.focusChanged();
    eq(c.rect, null);
    c.report({ x: NaN, y: 1, width: 1, height: 1 });
    eq(c.rect, null);
});
const area = { x: 0, y: 0, width: 1280, height: 800 };
const size = { width: 24, height: 20 };
test('place: under the caret, above it at the bottom, clamped at the sides', () => {
    eq(placeBadge({ caret: { x: 100, y: 200, width: 1, height: 18 }, pointer: { x: 0, y: 0 }, size, area }),
        { x: 100, y: 200 + 18 + CARET_GAP, anchor: 'caret' });
    eq(placeBadge({ caret: { x: 100, y: 780, width: 1, height: 18 }, pointer: { x: 0, y: 0 }, size, area }).y,
        780 - CARET_GAP - 20);
    eq(placeBadge({ caret: { x: 1275, y: 100, width: 1, height: 18 }, pointer: { x: 0, y: 0 }, size, area }).x,
        1280 - 24 - SCREEN_MARGIN);
});
test('place: by the pointer without a caret', () => {
    eq(placeBadge({ caret: null, pointer: { x: 300, y: 400 }, size, area }),
        { x: 300 + POINTER_OFFSET.x, y: 400 + POINTER_OFFSET.y, anchor: 'pointer' });
    const second = { x: 1280, y: 0, width: 1024, height: 768 };
    eq(placeBadge({ caret: null, pointer: { x: 2300, y: 760 }, size, area: second }),
        { x: 1280 + 1024 - 24 - SCREEN_MARGIN, y: 768 - 20 - SCREEN_MARGIN, anchor: 'pointer' });
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
