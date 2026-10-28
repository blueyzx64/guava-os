// Run: gjs -m tests/controlCenterCustom.test.js
import {
    CONTROLS, SIZES, addControl, control, fitSize, formatCountdown, gallery, isOwnControl,
    layoutFromPlan, moveControl, moveControlTo, nextSize, packRows, parseLayout, pinOf, planCustom,
    removeControl, serializeLayout, setSize, settingIsOn, settingValue,
} from '../features/controlCenter/customModel.js';
import { MORE_HEADER_ID, planLayout } from '../features/controlCenter/model.js';
import { PINNABLE } from '../lib/menuBarPins.js';

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

test('every control has a unique id, a group, a title, an icon and a default size it allows', () => {
    eq(new Set(CONTROLS.map(c => c.id)).size, CONTROLS.length);
    for (const c of CONTROLS) {
        if (!c.group || !c.title || !c.icon || !c.sizes.includes(c.defaultSize))
            throw new Error(c.id);
        if (c.sizes.some(s => !SIZES.includes(s)))
            throw new Error(`size of ${c.id}`);
    }
});

test('the gallery has the extra controls of the brief', () => {
    for (const id of ['screen-recording', 'screenshot', 'timer', 'dark-style', 'low-power', 'backlight',
        'text-size', 'high-contrast', 'visual-alerts', 'feature:notch', 'feature:stage-manager'])
        eq(!!control(id), true);
    eq(isOwnControl('timer'), true);
    eq(isOwnControl('wifi'), false);
    eq(isOwnControl('feature:notch'), true);
});

test('parseLayout drops unknown ids and duplicates and fits sizes', () => {
    eq(parseLayout(['wifi:medium', 'bogus:small', 'wifi:large', 'volume-out:small', 'dnd', 'feature:notch:medium']),
        [{ id: 'wifi', size: 'medium' }, { id: 'volume-out', size: 'large' }, { id: 'dnd', size: 'small' },
            { id: 'feature:notch', size: 'medium' }]);
});

test('serializeLayout round-trips', () => {
    const l = [{ id: 'feature:spotlight', size: 'small' }, { id: 'wifi', size: 'large' }];
    eq(parseLayout(serializeLayout(l)), l);
});

test('add, remove, move and resize', () => {
    let l = parseLayout(['wifi:medium', 'bluetooth:medium']);
    l = addControl(l, 'timer');
    eq(l.map(e => e.id), ['wifi', 'bluetooth', 'timer']);
    eq(addControl(l, 'timer'), l);
    eq(addControl(l, 'nope'), l);
    l = addControl(l, 'dnd', 0);
    eq(l.map(e => e.id), ['dnd', 'wifi', 'bluetooth', 'timer']);
    l = moveControl(l, 'timer', -2);
    eq(l.map(e => e.id), ['dnd', 'timer', 'wifi', 'bluetooth']);
    eq(moveControl(l, 'dnd', -1), l);
    l = moveControlTo(l, 'dnd', 3);
    eq(l.map(e => e.id), ['timer', 'wifi', 'bluetooth', 'dnd']);
    l = setSize(l, 'wifi', 'small');
    eq(l[1].size, 'medium');
    l = setSize(l, 'wifi', 'large');
    eq(l[1].size, 'large');
    l = removeControl(l, 'bluetooth');
    eq(l.map(e => e.id), ['timer', 'wifi', 'dnd']);
});

test('nextSize cycles through the allowed sizes only', () => {
    eq(nextSize('dnd', 'small'), 'medium');
    eq(nextSize('dnd', 'medium'), 'small');
    eq(nextSize('wifi', 'medium'), 'large');
    eq(nextSize('volume-out', 'large'), 'large');
    eq(fitSize('nope', 'large'), null);
});

test('layoutFromPlan writes the default arrangement down', () => {
    const entries = [
        { id: 'a', key: 'wifi', visible: true, stockSpan: 1 },
        { id: 'b', key: 'dnd', visible: true, stockSpan: 1, compactable: true },
        { id: 'c', key: 'dark-style', visible: true, stockSpan: 1, compactable: true },
        { id: 'd', key: 'volume-out', visible: true, stockSpan: 2 },
        { id: 'e', key: 'bluetooth', visible: false, stockSpan: 1 },
        { id: 'f', key: 'system', visible: true, stockSpan: 2 },
        { id: 'g', key: null, visible: true, stockSpan: 1 },
    ];
    const plan = planLayout(entries);
    const keyOf = new Map(entries.map(e => [e.id, e.key]));
    eq(layoutFromPlan(plan, keyOf), [
        { id: 'wifi', size: 'medium' }, { id: 'dnd', size: 'medium' }, { id: 'bluetooth', size: 'medium' },
        { id: 'dark-style', size: 'small' }, { id: 'volume-out', size: 'large' },
    ].sort((x, y) => plan.findIndex(p => keyOf.get(p.id) === x.id) - plan.findIndex(p => keyOf.get(p.id) === y.id)));
});

test('planCustom orders by the layout, hides removed controls, keeps unknown items', () => {
    const entries = [
        { id: 'w', key: 'wifi', visible: true, stockSpan: 1 },
        { id: 'd', key: 'dnd', visible: true, stockSpan: 1, compactable: true },
        { id: 'n', key: 'night-light', visible: true, stockSpan: 1, compactable: true },
        { id: 'x', key: null, visible: true, stockSpan: 1 },
        { id: 's', key: 'system', visible: true, stockSpan: 2 },
        { id: 'e', key: 'edit-controls', visible: true, stockSpan: 2 },
        { id: 't', key: 'timer', visible: true, stockSpan: 1 },
    ];
    const plan = planCustom(entries, parseLayout(['timer:small', 'dnd:small', 'wifi:large']));
    eq(plan.map(p => p.id), ['t', 'd', 'w', 'n', MORE_HEADER_ID, 'x', 's', 'e']);
    const by = id => plan.find(p => p.id === id);
    eq([by('t').span, by('t').compact], [2, false]);     // not compactable: a labelled half
    eq([by('d').span, by('d').compact], [1, true]);
    eq(by('w').span, 4);
    eq([by('n').hide, by('n').visible], [true, false]);
    eq([by('x').span, by('x').hide], [2, false]);
    eq(by(MORE_HEADER_ID).visible, true);
    eq([by('s').span, by('e').span], [4, 4]);
});

test('packRows flows like the Quick Settings grid', () => {
    eq(packRows(parseLayout(['dnd:small', 'wifi:medium', 'volume-out:large', 'dark-style:small'])), [
        { id: 'dnd', column: 0, row: 0, span: 1 },
        { id: 'wifi', column: 1, row: 0, span: 2 },
        { id: 'volume-out', column: 0, row: 1, span: 4 },
        { id: 'dark-style', column: 0, row: 2, span: 1 },
    ]);
});

test('gallery groups, marks added controls and filters by search', () => {
    const g = gallery(parseLayout(['wifi:medium']), {});
    eq(g[0].group, 'connectivity');
    eq(g[0].controls.find(c => c.id === 'wifi').added, true);
    eq(g[0].controls.find(c => c.id === 'bluetooth').added, false);
    const found = gallery([], { query: 'record' });
    eq(found.flatMap(x => x.controls.map(c => c.id)), ['screen-recording']);
    const fr = gallery([], { query: 'minuteur', titleOf: c => c.id === 'timer' ? 'Minuteur' : c.title });
    eq(fr.flatMap(x => x.controls.map(c => c.id)), ['timer']);
    eq(gallery([], { available: id => id !== 'timer', query: 'timer' }), []);
});

test('setting controls: booleans, inverted booleans and number steps', () => {
    const hc = control('high-contrast').binding;
    const rm = control('reduce-motion').binding;
    const ts = control('text-size').binding;
    eq([settingIsOn(hc, true), settingValue(hc, false)], [true, false]);
    eq([settingIsOn(rm, true), settingValue(rm, true)], [false, false]);
    eq([settingIsOn(ts, 1.0), settingIsOn(ts, 1.25), settingIsOn(ts, 1.5), settingValue(ts, true)], [false, true, true, 1.25]);
});

test('formatCountdown', () => {
    eq([formatCountdown(0), formatCountdown(4.2), formatCountdown(245), formatCountdown(3723)],
        ['0:00', '0:05', '4:05', '1:02:03']);
});

test('pinnable controls map to menu bar items that exist', () => {
    const pins = new Set(PINNABLE.map(p => p.id));
    for (const c of CONTROLS) {
        const pin = pinOf(c.id);
        if (pin && !pins.has(pin))
            throw new Error(c.id);
    }
    eq([pinOf('volume-out'), pinOf('timer')], ['sound', null]);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
