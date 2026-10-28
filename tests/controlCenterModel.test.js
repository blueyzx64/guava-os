// Run: gjs -m tests/controlCenterModel.test.js
import {
    COLUMNS, MORE_HEADER_ID, DISPLAY_HEADER_ID, SOUND_HEADER_ID, SPACER_PREFIX,
    planLayout, place, restoreOrder, batteryTime, BATTERY_STATE,
    GUAVA_COLUMNS, GUAVA_TOGGLES, guavaTiles,
} from '../features/controlCenter/model.js';

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
function eq(a, b) {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const e = (id, key, visible = true, stockSpan = 1, compactable = false) =>
    ({ id, key, visible, stockSpan, compactable });
// A plain on/off stock toggle the shell can make icon-only
const c = (id, key, visible = true) => e(id, key, visible, 1, true);
const ids = plan => plan.map(p => p.id);
const byId = (plan, id) => plan.find(p => p.id === id);

const top = plan => plan.filter(p => p.group === 'top' && p.visible);
const cells = plan => plan.filter(p => p.visible).map(p => [p.id, p.span]);

test('stock items are grouped in block order, whatever the stock order', () => {
    const plan = planLayout([
        e('sys', 'system', true, 2), e('vol', 'volume-out', true, 2), e('bt', 'bluetooth'),
        e('dnd', 'dnd'), e('wifi', 'wifi'), e('br', 'brightness', true, 2),
    ]);
    eq(ids(plan.filter(p => p.visible)),
        ['wifi', 'dnd', 'bt', SPACER_PREFIX + '0', DISPLAY_HEADER_ID, 'br', SOUND_HEADER_ID, 'vol', 'sys']);
});

test('top block: the connectivity stack on the left, DND and squares on the right', () => {
    const plan = planLayout([
        e('wifi', 'wifi'), e('bt', 'bluetooth'), e('vpn', 'vpn'), e('dnd', 'dnd'),
        c('dark', 'dark-style'), c('night', 'night-light'), c('air', 'airplane'), c('rot', 'rotation'),
    ]);
    eq(cells(top(plan)),
        [['wifi', 2], ['dnd', 2], ['bt', 2], ['dark', 1], ['night', 1], ['vpn', 2], ['air', 1], ['rot', 1]]);
});

test('the connectivity stack is one module: joined edges inside, none outside', () => {
    const plan = planLayout([e('wifi', 'wifi'), e('bt', 'bluetooth'), e('vpn', 'vpn'), e('dnd', 'dnd')]);
    const j = id => [byId(plan, id).joinPrev, byId(plan, id).joinNext];
    eq([j('wifi'), j('bt'), j('vpn'), j('dnd')], [[false, true], [true, true], [true, false], [false, false]]);
});

test('a hidden vpn does not leave a hole or a dangling join', () => {
    const plan = planLayout([e('wifi', 'wifi'), e('bt', 'bluetooth'), e('vpn', 'vpn', false), e('dnd', 'dnd')]);
    eq(cells(top(plan)), [['wifi', 2], ['dnd', 2], ['bt', 2], [SPACER_PREFIX + '0', 2]]);
    eq(byId(plan, 'bt').joinNext, false);
});

test('the right half runs out: blank spacers keep the stack in its column', () => {
    const plan = planLayout([e('wifi', 'wifi'), e('bt', 'bluetooth'), e('wired', 'wired')]);
    eq(cells(top(plan)), [['wifi', 2], [SPACER_PREFIX + '0', 2], ['wired', 2], [SPACER_PREFIX + '1', 2],
        ['bt', 2], [SPACER_PREFIX + '2', 2]]);
});

test('no connectivity: one row, DND and two squares', () => {
    const plan = planLayout([e('dnd', 'dnd'), c('dark', 'dark-style'), c('night', 'night-light'), c('air', 'airplane')]);
    eq(cells(top(plan)), [['dnd', 2], ['dark', 1], ['night', 1]]);
    eq(byId(plan, 'air').group, 'toggles');
});

test('squares pair up in the right half even when a labelled toggle ranks between them', () => {
    const plan = planLayout([
        e('wifi', 'wifi'), e('bt', 'bluetooth'), e('vpn', 'vpn'), e('dnd', 'dnd'),
        c('air', 'airplane'), e('power', 'power-saver'), c('rot', 'rotation'),
    ]);
    eq(cells(top(plan)), [['wifi', 2], ['dnd', 2], ['bt', 2], ['air', 1], ['rot', 1], ['vpn', 2], ['power', 2]]);
});

test('a square with no square partner gets its label back', () => {
    const plan = planLayout([e('dnd', 'dnd'), c('dark', 'dark-style')]);
    eq(cells(top(plan)), [['dnd', 2], ['dark', 2]]);
    eq(byId(plan, 'dark').compact, false);
});

test('a secondary toggle the shell cannot compact stays a labelled half tile', () => {
    const plan = planLayout([e('dnd', 'dnd'), e('dark', 'dark-style'), c('night', 'night-light')]);
    eq(cells(top(plan)), [['dnd', 2], ['dark', 2]]);
    eq([byId(plan, 'night').group, byId(plan, 'night').span, byId(plan, 'night').compact], ['toggles', 1, true]);
});

test('display and sound: a caption joined to the sliders', () => {
    const plan = planLayout([e('br', 'brightness', true, 2), e('out', 'volume-out', true, 2), e('in', 'volume-in', true, 2)]);
    const j = id => [byId(plan, id).span, byId(plan, id).joinPrev, byId(plan, id).joinNext];
    eq([j(DISPLAY_HEADER_ID), j('br'), j(SOUND_HEADER_ID), j('out'), j('in')],
        [[4, false, true], [4, true, false], [4, false, true], [4, true, true], [4, true, false]]);
});

test('no slider visible: no caption', () => {
    const plan = planLayout([e('br', 'brightness', false, 2)]);
    eq([byId(plan, DISPLAY_HEADER_ID).visible, byId(plan, SOUND_HEADER_ID).visible], [false, false]);
});

test('leftover toggles: squares first, then labelled; a labelled tile ending a row is widened', () => {
    const plan = planLayout([
        c('air', 'airplane'), e('power', 'power-saver'), c('rot', 'rotation'),
        e('kbd', 'backlight'), c('loc', 'location'), c('cam', 'camera'), c('tb', 'thunderbolt'),
    ]);
    const toggles = plan.filter(p => p.group === 'toggles');
    eq(toggles.map(p => p.id), ['air', 'rot', 'loc', 'cam', 'tb', 'power', 'kbd']);
    eq(toggles.map(p => p.span), [1, 1, 1, 1, 1, 3, 4]);
    eq(planLayout([e('power', 'power-saver')]).find(p => p.id === 'power').span, COLUMNS);
});

test('a single leftover square shares its row with a labelled tile (real laptop set)', () => {
    const plan = planLayout([
        e('wifi', 'wifi'), e('bt', 'bluetooth'), e('dnd', 'dnd'),
        c('dark', 'dark-style'), c('night', 'night-light'), c('air', 'airplane'),
        e('power', 'power-saver'), e('kbd', 'backlight'),
    ]);
    const toggles = plan.filter(p => p.group === 'toggles');
    eq(toggles.map(p => [p.id, p.span]), [['air', 1], ['power', 3], ['kbd', 4]]);
});

test('the Guava module is one full-width block after the toggles', () => {
    const plan = planLayout([e('k', 'guava-toggles'), c('air', 'airplane'), e('sys', 'system', true, 2)]);
    eq(cells(plan), [['air', 1], ['k', 4], ['sys', 4]]);
});

test('guavaTiles: the catalogue covers the Guava features, never the Control Center', () => {
    const keys = GUAVA_TOGGLES.map(t => t.key);
    for (const key of ['notch', 'stage-manager', 'clipboard-history', 'spotlight',
        'liquid-glass', 'rounded-corners'])
        if (!keys.includes(key))
            throw new Error(`missing ${key}`);
    eq(keys.includes('control-center'), false);
    // The auto-hide top bar was removed (the bar houses the notch): no tile for it.
    eq(keys.includes('panel-autohide'), false);
    eq(guavaTiles(() => true).some(t => t.key === 'control-center'), false);
    for (const t of GUAVA_TOGGLES)
        if (!t.icon || !t.label)
            throw new Error(`${t.key} needs an icon and a label`);
});

test('guavaTiles: keys missing from the schema are skipped and cells stay packed', () => {
    const tiles = guavaTiles(key => key !== 'stage-manager');
    eq(tiles.some(t => t.key === 'stage-manager'), false);
    eq(tiles.map(t => [t.column, t.row]), tiles.map((_t, i) => [i % GUAVA_COLUMNS, Math.floor(i / GUAVA_COLUMNS)]));
    eq(guavaTiles(() => false), []);
});

test('unknown items go to extras after the stock toggles, with the header', () => {
    const plan = planLayout([
        e('x', null, true, 1), e('dark', 'dark-style'), e('notif', 'notifications', true, 2),
        e('bg', 'background-apps', true, 2),
    ]);
    eq(ids(plan.filter(p => p.visible)), ['dark', 'bg', MORE_HEADER_ID, 'x', 'notif']);
    eq(byId(plan, MORE_HEADER_ID).visible, true);
});

test('no visible extras: header hidden', () => {
    const plan = planLayout([e('x', null, false), e('dark', 'dark-style')]);
    eq(byId(plan, MORE_HEADER_ID).visible, false);
});

test('an extra with stock span 2 (full width) stays full width', () => {
    eq(place({ key: null, stockSpan: 2 }).span, COLUMNS);
    eq(place({ key: null, stockSpan: 1 }).span, 2);
    eq(place({ key: null }).span, 2);
});

test('order is stable for equal rank (volume out before volume in; same-key keeps stock order)', () => {
    const plan = planLayout([e('b1', 'brightness', true, 2), e('b2', 'brightness', true, 2)]);
    eq(ids(plan.filter(p => p.group === 'display')), [DISPLAY_HEADER_ID, 'b1', 'b2']);
});

test('planLayout does not mutate its input', () => {
    const input = [e('wifi', 'wifi'), e('bt', 'bluetooth')];
    const copy = JSON.stringify(input);
    planLayout(input);
    eq(JSON.stringify(input), copy);
});

test('restoreOrder keeps the saved order of items still alive', () => {
    eq(restoreOrder(['a', 'b', 'c', 'd'], ['d', 'b', 'a', 'c']), ['a', 'b', 'c', 'd']);
});

test('restoreOrder skips items that left the grid (rebuilt grid, dead parent)', () => {
    eq(restoreOrder(['a', 'b', 'c'], ['c', 'a']), ['a', 'c']);
});

test('restoreOrder puts newcomers after the restored items', () => {
    eq(restoreOrder(['a', 'b'], ['n1', 'b', 'a', 'n2']), ['a', 'b', 'n1', 'n2']);
});

test('restoreOrder on an empty grid is empty', () => eq(restoreOrder(['a'], []), []));

test('batteryTime: discharging uses time to empty', () => {
    eq(batteryTime({ state: BATTERY_STATE.DISCHARGING, toEmpty: 3 * 3600 + 20 * 60, toFull: 0 }),
        { kind: 'remaining', hours: 3, minutes: 20 });
});

test('batteryTime: charging uses time to full', () => {
    eq(batteryTime({ state: BATTERY_STATE.CHARGING, toEmpty: 0, toFull: 45 * 60 }),
        { kind: 'until-full', hours: 0, minutes: 45 });
});

test('batteryTime: no estimate or full battery gives null', () => {
    eq(batteryTime({ state: BATTERY_STATE.DISCHARGING, toEmpty: 0, toFull: 0 }), null);
    eq(batteryTime({ state: BATTERY_STATE.FULLY_CHARGED, toEmpty: 0, toFull: 0 }), null);
    eq(batteryTime({ state: BATTERY_STATE.DISCHARGING, toEmpty: NaN, toFull: 0 }), null);
});

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
