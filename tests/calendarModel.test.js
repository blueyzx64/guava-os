// Run: gjs -m tests/calendarModel.test.js
import { indicatorStyle, isDndActor, menuWidth, MIN_MENU_WIDTH } from '../features/calendar/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const node = (o = {}) => ({ accessibleName: '', title: '', styleClass: '', typeName: 'Actor', iconName: null, children: [], ...o });

test('menu width: at least the minimum, else the calendar plus padding', () => {
    eq(menuWidth(100), MIN_MENU_WIDTH);
    eq(menuWidth(400.4), 420);
});
test('notification dot styles', () => {
    eq(indicatorStyle('default', false), 'color: red;');
    eq(indicatorStyle('accent', true), 'color: -st-accent-color; margin-right: 12px;');
    eq(indicatorStyle('symbolic', false), null);
    eq(indicatorStyle('symbolic', true), 'margin-right: 12px;');
});
test('DnD toggle found by name, icon, class or type', () => {
    eq(isDndActor(node({ title: 'Do Not Disturb' }), { iconOnly: false }), true);
    eq(isDndActor(node({ children: [node({ iconName: 'notifications-disabled-symbolic' })] }), { iconOnly: false }), true);
    eq(isDndActor(node({ typeName: 'DoNotDisturbToggle' }), { iconOnly: false }), true);
    eq(isDndActor(node({ title: 'Wi-Fi' }), { iconOnly: false }), false);
});
test('DnD indicator: icon or class only (a title does not count)', () => {
    eq(isDndActor(node({ iconName: 'weather-clear-night-symbolic' }), { iconOnly: true }), true);
    eq(isDndActor(node({ styleClass: 'dnd-indicator' }), { iconOnly: true }), true);
    eq(isDndActor(node({ title: 'Do Not Disturb' }), { iconOnly: true }), false);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
