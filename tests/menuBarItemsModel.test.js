// Run: gjs -m tests/menuBarItemsModel.test.js
import {
    argbToRgba, barOrder, hostMode, itemAddress, moveItem, parseItemAddress,
    parseMenu, parseRegistry, pickPixmap, planBar, sniId, sniVisible, updateRegistry,
} from '../features/menuBarItems/model.js';
import { PINNABLE, batteryText, parsePins, pinMode, pinShown, setPin } from '../lib/menuBarPins.js';

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

test('pins parse, set and default to never', () => {
    eq([...parsePins(['wifi=always', 'sound=active', 'bogus=always', 'wifi=active', 'focus=sometimes'])],
        [['wifi', 'always'], ['sound', 'active']]);
    eq([...parsePins(['battery=active'])], [['battery', 'always']]);
    let s = setPin([], 'wifi', 'always');
    s = setPin(s, 'sound', 'active');
    eq(s, ['wifi=always', 'sound=active']);
    eq(setPin(s, 'wifi', 'never'), ['sound=active']);
    eq([pinMode(s, 'sound'), pinMode(s, 'battery')], ['active', 'never']);
    eq(PINNABLE.map(p => p.id).includes('screen-recording'), true);
});

test('pinShown and the battery text', () => {
    eq([pinShown('always', false), pinShown('active', false), pinShown('active', true), pinShown('never', true)],
        [true, false, true, false]);
    eq([batteryText(59.6, false), batteryText(59.6, true), batteryText(NaN, true)], ['', '60%', '']);
});

test('host mode defers to AppIndicator and joins a foreign watcher', () => {
    eq(hostMode({ enabled: true, appIndicator: true, otherOwner: true }), 'defer');
    eq(hostMode({ enabled: true, appIndicator: false, otherOwner: false }), 'own');
    eq(hostMode({ enabled: true, appIndicator: false, otherOwner: true }), 'client');
    eq(hostMode({ enabled: false, appIndicator: true, otherOwner: false }), 'off');
});

test('item addresses in all three registration forms', () => {
    eq(parseItemAddress('/org/ayatana/NotificationItem/x', ':1.5'), { bus: ':1.5', path: '/org/ayatana/NotificationItem/x' });
    eq(parseItemAddress('org.kde.StatusNotifierItem-12-1', ':1.5'), { bus: 'org.kde.StatusNotifierItem-12-1', path: '/StatusNotifierItem' });
    eq(parseItemAddress(':1.9/StatusNotifierItem', ':1.5'), { bus: ':1.9', path: '/StatusNotifierItem' });
    eq(parseItemAddress('', ':1.5'), { bus: ':1.5', path: '/StatusNotifierItem' });
    eq(itemAddress({ bus: ':1.9', path: '/x' }), ':1.9/x');
});

test('sni ids are stable and safe', () => {
    eq(sniId('Discord', '', ':1.2'), 'sni:discord');
    eq(sniId('', 'Steam Client', ':1.2'), 'sni:steam-client');
    eq(sniId('', '', ':1.2'), 'sni:1.2');
    eq([sniVisible('Active'), sniVisible('NeedsAttention'), sniVisible('Passive')], [true, true, false]);
});

test('pickPixmap prefers the smallest that is big enough', () => {
    const p = [{ width: 16, height: 16 }, { width: 64, height: 64 }, { width: 32, height: 32 }, { width: 0, height: 0 }];
    eq(pickPixmap(p, 24), 2);
    eq(pickPixmap(p, 16), 0);
    eq(pickPixmap(p, 128), 1);
    eq(pickPixmap([], 16), -1);
});

test('argbToRgba swaps the channels', () => {
    eq([...argbToRgba(new Uint8Array([255, 1, 2, 3, 128, 10, 20, 30, 9]))], [1, 2, 3, 255, 10, 20, 30, 128]);
});

test('parseMenu keeps the tree, drops invisible items and stray separators', () => {
    const tree = parseMenu([0, {}, [
        [9, { type: 'separator' }, []],
        [1, { label: '_Open', 'icon-name': 'document-open' }, []],
        [2, { label: 'Hidden', visible: false }, []],
        [3, { type: 'separator' }, []],
        [4, { type: 'separator' }, []],
        [5, { label: 'Mute', 'toggle-type': 'checkmark', 'toggle-state': 1, enabled: false }, []],
        [6, { label: 'More', 'children-display': 'submenu' }, [[7, { label: 'Sub' }, []]]],
        [8, { type: 'separator' }, []],
    ]]);
    eq(tree.children.map(c => c.id), [1, 3, 5, 6]);
    eq([tree.children[0].label, tree.children[0].icon], ['Open', 'document-open']);
    eq([tree.children[2].toggle, tree.children[2].checked, tree.children[2].enabled], ['checkmark', true, false]);
    eq(tree.children[3].children[0].label, 'Sub');
});

test('parseMenu is bounded in depth and in item count', () => {
    let deep = [99, { label: 'leaf' }, []];
    for (let i = 0; i < 40; i++)
        deep = [i, { label: 'n' }, [deep]];
    let depth = 0;
    for (let n = parseMenu(deep); n.children.length; n = n.children[0])
        depth++;
    eq(depth <= 8, true);
    const wide = [0, {}, Array.from({ length: 10000 }, (_v, i) => [i + 1, { label: `i${i}` }, []])];
    eq(parseMenu(wide).children.length, 3000);
});

test('barOrder puts new items first and keeps the saved order', () => {
    eq(barOrder(['pin:wifi', 'sni:steam', 'sni:gone'], ['sni:steam', 'sni:discord', 'pin:wifi']),
        ['sni:discord', 'pin:wifi', 'sni:steam']);
    eq(moveItem(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
    eq(moveItem(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
    eq(moveItem(['a'], 'x', 1), ['a']);
});

test('the registry remembers titles and is capped', () => {
    let r = updateRegistry([], [{ id: 'sni:a', title: 'A\tpp' }, { id: 'pin:wifi', title: 'Wi-Fi' }]);
    eq(r, ['sni:a\tA pp', 'pin:wifi\tWi-Fi']);
    r = updateRegistry(r, [{ id: 'sni:a', title: 'App' }]);
    eq(parseRegistry(r), [{ id: 'sni:a', title: 'App' }, { id: 'pin:wifi', title: 'Wi-Fi' }]);
    eq(updateRegistry(['x\t1', 'y\t2', 'z\t3'], [], 2), ['y\t2', 'z\t3']);
});

test('planBar collapses the left end behind a chevron when crowded', () => {
    const widths = new Map([['a', 30], ['b', 30], ['c', 30], ['d', 30], ['h', 30]]);
    const base = { order: ['a', 'b', 'c', 'd', 'h'], hidden: ['h'], idle: [], widths, chevron: 20 };
    eq(planBar({ ...base, available: 120 }), { shown: ['a', 'b', 'c', 'd'], overflow: [], chevron: false });
    eq(planBar({ ...base, available: 100 }), { shown: ['c', 'd'], overflow: ['a', 'b'], chevron: true });
    eq(planBar({ ...base, available: 100, idle: ['a'] }), { shown: ['b', 'c', 'd'], overflow: [], chevron: false });
    eq(planBar({ ...base, available: 10 }), { shown: [], overflow: ['a', 'b', 'c', 'd'], chevron: true });
    eq(planBar({ ...base, available: 10, overflow: false }).chevron, false);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
