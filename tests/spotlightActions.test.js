// Run: gjs -m tests/spotlightActions.test.js
import {
    GUAVA_ACTIONS, actionItems, actionChoices, parseDuration, formatDuration, parameterItems,
} from '../features/spotlight/actionsModel.js';
import { rank } from '../features/spotlight/model.js';

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
const _ = s => s;

test('the owner\'s action list', () => eq(GUAVA_ACTIONS.map(a => a.id),
    ['show-desktop', 'lock', 'timer', 'dnd', 'dark-mode', 'empty-trash', 'screenshot']));
test('titles follow the state', () => {
    const off = actionItems(GUAVA_ACTIONS, { dnd: false, dark: false }, _);
    const on = actionItems(GUAVA_ACTIONS, { dnd: true, dark: true }, _);
    eq(off.find(i => i.actionId === 'dnd').title, 'Turn On Do Not Disturb');
    eq(on.find(i => i.actionId === 'dnd').title, 'Turn Off Do Not Disturb');
    eq(on.find(i => i.actionId === 'dark-mode').title, 'Turn Off Dark Mode');
});
test('actions that need a missing capability are left out', () => {
    const ids = actionItems(GUAVA_ACTIONS, {}, _, new Set(['trash'])).map(i => i.actionId);
    eq(ids.includes('show-desktop'), false);
    eq(ids.includes('empty-trash'), true);
    eq(actionItems(GUAVA_ACTIONS, {}, _, new Set()).some(i => i.actionId === 'empty-trash'), false);
});
test('rows are commands with unique ids and match their keywords', () => {
    const items = actionItems(GUAVA_ACTIONS, {}, _);
    eq(new Set(items.map(i => i.id)).size, items.length);
    eq(items.every(i => i.kind === 'command'), true);
    eq(rank(items, 'focus')[0].actionId, 'dnd');
    eq(rank(items, 'show desk')[0].actionId, 'show-desktop');
    eq(rank(items, 'screenshot')[0].actionId, 'screenshot');
});
test('an action beats a Settings panel with the same keyword', () => {
    const panel = { id: 'setting:notifications', kind: 'setting', title: 'Notifications', keywords: ['do not disturb', 'banners'] };
    const items = [panel, ...actionItems(GUAVA_ACTIONS, { dnd: false }, _)];
    eq(rank(items, 'do not disturb')[0].actionId, 'dnd');
    eq(rank(items, 'notifications')[0].id, 'setting:notifications');
});
test('actionChoices lists every action once', () => eq(actionChoices().length, GUAVA_ACTIONS.length));
test('parseDuration forms', () => {
    eq(['5', '5m', '5 min', '90s', '1h', '1h30m', '1 h 30 min', '2:30', '1.5', '10 minutes'].map(parseDuration),
        [300, 300, 300, 90, 3600, 5400, 5400, 150, 90, 600]);
});
test('parseDuration rejects', () => {
    eq(['', 'abc', '5x', '0', '2:75', '25h', '5m banana', '-5', 'm5'].map(parseDuration),
        [null, null, null, null, null, null, null, null, null]);
});
test('formatDuration', () => eq([300, 5400, 45, 150, 3600].map(s => formatDuration(s)),
    ['5 min', '1 h 30 min', '45 s', '2 min 30 s', '1 h']));
test('"timer 5m" makes a top row with its seconds', () => {
    const [row] = parameterItems(GUAVA_ACTIONS, 'timer 5m', _);
    eq([row.actionId, row.args.seconds, row.title, row.score], ['timer', 300, 'Start a 5 min Timer', 1500]);
    eq(parameterItems(GUAVA_ACTIONS, 'tmr 2', _)[0].args.seconds, 120);
});
test('no parameter row for a bare trigger or a bad value', () => {
    eq(parameterItems(GUAVA_ACTIONS, 'timer', _), []);
    eq(parameterItems(GUAVA_ACTIONS, 'timer soon', _), []);
    eq(parameterItems(GUAVA_ACTIONS, 'firefox 5', _), []);
});
test('a quick key passes every word as the parameter', () => {
    eq(parameterItems(GUAVA_ACTIONS, '10', _, 'timer')[0].args.seconds, 600);
    eq(parameterItems(GUAVA_ACTIONS, '10', _, 'lock'), []);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
