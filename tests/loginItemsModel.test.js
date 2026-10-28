// Run: gjs -m tests/loginItemsModel.test.js
import { backgroundItems, loginItem, loginItems } from '../lib/loginItemsModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const f = fields => ({
    fileName: 'x.desktop', name: null, icon: null, hidden: null, gnomeEnabled: null, guava: null,
    onlyShowIn: [], notShowIn: [], ...fields,
});

test('only Guava\'s own user files are removable', () => {
    eq(loginItem(f({ guava: 'true' }), 'user').removable, true);
    eq(loginItem(f({}), 'user').removable, false);
    // a system file cannot be Guava's, whatever it says
    eq(loginItem(f({ guava: 'true' }), 'system').removable, false);
});
test('enabled follows Hidden, X-GNOME-Autostart-enabled and OnlyShowIn/NotShowIn', () => {
    eq(loginItem(f({}), 'user').enabled, true);
    eq(loginItem(f({ hidden: 'true' }), 'user').enabled, false);
    eq(loginItem(f({ gnomeEnabled: 'false' }), 'user').enabled, false);
    eq(loginItem(f({ onlyShowIn: ['KDE'] }), 'user').enabled, false);
    eq(loginItem(f({ onlyShowIn: ['GNOME', 'KDE'] }), 'user').enabled, true);
    eq(loginItem(f({ notShowIn: ['GNOME'] }), 'user').enabled, false);
});
test('names fall back to the file name', () => {
    eq(loginItem(f({ fileName: 'tool.desktop' }), 'user').name, 'tool');
    eq(loginItem(f({ name: 'Tool' }), 'user').name, 'Tool');
});
test('user files hide system files of the same name; inactive system ones are left out', () => {
    const items = loginItems(
        [f({ fileName: 'b.desktop', name: 'Beta', hidden: 'true' }), f({ fileName: 'k.desktop', name: 'Guava App', guava: 'true' })],
        [f({ fileName: 'b.desktop', name: 'Beta (system)' }), f({ fileName: 'a.desktop', name: 'Alpha' }),
            f({ fileName: 'z.desktop', name: 'KDE only', onlyShowIn: ['KDE'] })],
    );
    eq(items.map(i => [i.id, i.origin, i.enabled, i.removable]), [
        ['a.desktop', 'system', true, false],
        ['b.desktop', 'user', false, false],
        ['k.desktop', 'user', true, true],
    ]);
});
test('background permissions', () => {
    eq(backgroundItems({ 'org.b.App': ['no'], 'org.a.App': ['yes'], 'bad': ['maybe'], 'x': 'yes' }),
        [{ appId: 'org.a.App', state: 'yes' }, { appId: 'org.b.App', state: 'no' }]);
    eq(backgroundItems(null), []);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
