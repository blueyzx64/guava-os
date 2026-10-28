// Run: gjs -m tests/notificationCenterModel.test.js
import {
    COLLAPSED_GROUPS, age, groupByApp, monthGrid, orderWidgets, pruneExpanded, shiftMonth,
    stackView, visibleGroups,
} from '../features/notificationCenter/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const n = (key, appId, time) => ({ key, appId, appName: appId.toUpperCase(), title: key, body: '', time, urgency: 1 });

test('groups by app, newest app first, newest item first', () => {
    const groups = groupByApp([n('a1', 'a', 1), n('b1', 'b', 5), n('a2', 'a', 9), n('c1', 'c', 3)]);
    eq(groups.map(g => g.key), ['a', 'b', 'c']);
    eq(groups[0].items.map(i => i.key), ['a2', 'a1']);
    eq(groups[0].appName, 'A');
});
test('items without an app id group by name', () => {
    const groups = groupByApp([{ key: 'x', appId: null, appName: 'Mail', time: 1 }, { key: 'y', appId: null, appName: 'Mail', time: 2 }]);
    eq(groups.length, 1);
    eq(groups[0].key, 'Mail');
});
test('stack: collapsed shows the newest with up to two peeking; expanded shows all', () => {
    const g = groupByApp([n('1', 'a', 1), n('2', 'a', 2), n('3', 'a', 3), n('4', 'a', 4)])[0];
    eq(stackView(g, false), { shown: [g.items[0]], peek: 2, stacked: true, count: 4 });
    eq(stackView(g, true).shown.length, 4);
    const single = groupByApp([n('1', 'a', 1)])[0];
    eq(stackView(single, false).stacked, false);
});
test('only a few groups before "N more"', () => {
    const items = [];
    for (let i = 0; i < COLLAPSED_GROUPS + 2; i++)
        items.push(n(`k${i}`, `app${i}`, i), n(`j${i}`, `app${i}`, i));
    const groups = groupByApp(items);
    const v = visibleGroups(groups, false);
    eq(v.shown.length, COLLAPSED_GROUPS);
    eq(v.more, 4);
    eq(visibleGroups(groups, true).more, 0);
});
test('expanded state forgets cleared apps', () => {
    eq([...pruneExpanded(new Set(['a', 'gone']), groupByApp([n('1', 'a', 1)]))], ['a']);
});
test('age', () => {
    eq(age(1000, 1000), { unit: 'now', n: 0 });
    eq(age(5 * 60_000, 0), { unit: 'min', n: 5 });
    eq(age(3 * 3600_000 + 5, 0), { unit: 'hour', n: 3 });
    eq(age(50 * 3600_000, 0), { unit: 'day', n: 2 });
    eq(age(0, 1000), { unit: 'now', n: 0 }, 'clock skew');
});
test('month grid: October 2026, Monday first', () => {
    const g = monthGrid(2026, 9, 1, { year: 2026, month: 9, day: 27 });
    eq(g.weekdays, [1, 2, 3, 4, 5, 6, 0]);
    eq(g.weeks.length, 5);
    eq(g.weeks[0].map(c => c.day), [28, 29, 30, 1, 2, 3, 4], 'starts Thursday');
    eq(g.weeks[0][0].inMonth, false);
    eq(g.weeks.flat().filter(c => c.today).map(c => c.day), [27]);
    eq(g.weeks[4].map(c => c.day), [26, 27, 28, 29, 30, 31, 1]);
});
test('month grid: Sunday first, February', () => {
    const g = monthGrid(2026, 1, 0, { year: 2000, month: 0, day: 1 });
    eq(g.weeks.length, 4, 'Feb 2026 starts on Sunday: exactly four weeks');
    eq(g.weeks.flat().some(c => c.today), false);
});
test('shift month across years', () => {
    eq(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
    eq(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
});
test('widgets ordered', () => {
    eq(orderWidgets([{ id: 'b', order: 1 }, { id: 'a', order: 1 }, { id: 'z' }]).map(w => w.id), ['z', 'a', 'b']);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
