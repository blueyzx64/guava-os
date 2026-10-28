// Run: gjs -m tests/spotlightProviderInfo.test.js
import {
    parseProviderIni, selectProviders, normalizeMeta, externalScore, pickIds,
} from '../features/spotlight/providerInfo.js';

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

const NAUTILUS = `[Shell Search Provider]
DesktopId=org.gnome.Nautilus.desktop
BusName=org.gnome.Nautilus.SearchProvider
ObjectPath=/org/gnome/Nautilus/SearchProvider
Version=2
`;

test('parses a valid file', () => eq(parseProviderIni(NAUTILUS), {
    desktopId: 'org.gnome.Nautilus.desktop', busName: 'org.gnome.Nautilus.SearchProvider',
    objectPath: '/org/gnome/Nautilus/SearchProvider', version: 2, defaultDisabled: false,
}));
test('DefaultDisabled', () => eq(parseProviderIni(NAUTILUS + 'DefaultDisabled=true\n').defaultDisabled, true));
test('comments and blank lines', () => eq(parseProviderIni('# x\n\n' + NAUTILUS)?.version, 2));
test('other groups are ignored', () =>
    eq(parseProviderIni('[Other]\nBusName=evil.name\n' + NAUTILUS)?.busName, 'org.gnome.Nautilus.SearchProvider'));
test('version 1 refused', () => eq(parseProviderIni(NAUTILUS.replace('Version=2', 'Version=1')), null));
test('missing version refused', () => eq(parseProviderIni(NAUTILUS.replace('Version=2\n', '')), null));
test('bad bus name refused', () => eq(parseProviderIni(NAUTILUS.replace('org.gnome.Nautilus.SearchProvider', 'no spaces.allowed here')), null));
test('bus name without dot refused', () => eq(parseProviderIni(NAUTILUS.replace('org.gnome.Nautilus.SearchProvider', 'single')), null));
test('bad object path refused', () => eq(parseProviderIni(NAUTILUS.replace('/org/gnome/Nautilus/SearchProvider', 'relative/path')), null));
test('object path with dots refused', () => eq(parseProviderIni(NAUTILUS.replace('/org/gnome/Nautilus/SearchProvider', '/a/../b')), null));
test('desktop id must end with .desktop', () => eq(parseProviderIni(NAUTILUS.replace('Nautilus.desktop', 'Nautilus')), null));
test('huge file refused', () => eq(parseProviderIni(NAUTILUS + '#'.repeat(9000)), null));
test('non string', () => eq(parseProviderIni(null), null));

const mk = (id, extra = {}) => ({ desktopId: `${id}.desktop`, busName: `a.b.${id}`, objectPath: '/a', version: 2, defaultDisabled: false, ...extra });
test('select drops disabled', () =>
    eq(selectProviders([mk('a'), mk('b')], { disabled: ['a.desktop'] }).map(i => i.desktopId), ['b.desktop']));
test('default disabled needs enabled list', () => {
    eq(selectProviders([mk('a', { defaultDisabled: true })], {}).length, 0);
    eq(selectProviders([mk('a', { defaultDisabled: true })], { enabled: ['a.desktop'] }).length, 1);
});
test('disabled beats enabled', () =>
    eq(selectProviders([mk('a', { defaultDisabled: true })], { enabled: ['a.desktop'], disabled: ['a.desktop'] }).length, 0));
test('disable-external drops all', () => eq(selectProviders([mk('a')], { disableExternal: true }), []));
test('sort order, unknown last, ties stable', () =>
    eq(selectProviders([mk('x'), mk('b'), mk('a'), mk('y')], { sortOrder: ['a.desktop', 'b.desktop'] }).map(i => i.desktopId),
        ['a.desktop', 'b.desktop', 'x.desktop', 'y.desktop']));
test('duplicates: first wins', () =>
    eq(selectProviders([mk('a', { busName: 'first.x' }), mk('a', { busName: 'second.x' })]).map(i => i.busName), ['first.x']));
test('skip list', () => eq(selectProviders([mk('a'), mk('b')], { skip: ['b.desktop'] }).length, 1));
test('null entries tolerated', () => eq(selectProviders([null, mk('a')]).length, 1));

test('meta normalised', () => eq(normalizeMeta({ id: '1', name: 'N', description: 'D', icon: 'x' }),
    { id: '1', title: 'N', subtitle: 'D', iconString: 'x', iconData: null, clipboardText: null }));
test('meta without name dropped', () => eq(normalizeMeta({ id: '1' }), null));
test('meta wrong types', () => {
    eq(normalizeMeta({ id: 1, name: 'x' }), null);
    eq(normalizeMeta(null), null);
    eq(normalizeMeta({ id: '1', name: 'x', description: 5, icon: 5 }).subtitle, '');
});
test('meta strings capped', () => eq(normalizeMeta({ id: '1', name: 'x'.repeat(1000) }).title.length, 300));
test('external score stays under the top hit floor unless exact', () => {
    if (!(externalScore(0) < 400 && externalScore(0, true) > 400 && externalScore(5) < externalScore(0)))
        throw new Error('bad');
});
test('pickIds filters and caps', () => {
    eq(pickIds(['a', 1, 'b', 'c'], 2), ['a', 'b']);
    eq(pickIds(null), []);
});

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
print('providerInfo: all passed');
