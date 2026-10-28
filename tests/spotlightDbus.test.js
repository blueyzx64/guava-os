// Run: gjs -m tests/spotlightDbus.test.js
// Runs a fake SearchProvider2 on a session bus. Without DBUS_SESSION_BUS_ADDRESS the test
// re-runs itself under dbus-run-session, or prints SKIP when that tool is missing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { DBusSearch } from '../features/spotlight/providers/dbusSearch.js';

const BUS = 'org.guava.test.SearchProvider';
const PATH = '/org/guava/test/SearchProvider';
const XML = `<node><interface name="org.gnome.Shell.SearchProvider2">
<method name="GetInitialResultSet"><arg type="as" direction="in"/><arg type="as" direction="out"/></method>
<method name="GetSubsearchResultSet"><arg type="as" direction="in"/><arg type="as" direction="in"/><arg type="as" direction="out"/></method>
<method name="GetResultMetas"><arg type="as" direction="in"/><arg type="aa{sv}" direction="out"/></method>
<method name="ActivateResult"><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="in"/></method>
</interface></node>`;

let failed = 0;
function check(name, cond, extra = '') {
    if (cond) {
        print(`ok   ${name}`);
    } else {
        failed++;
        print(`FAIL ${name} ${extra}`);
    }
}

// No session bus: run again under a private one (dbus-run-session), or skip.
if (!GLib.getenv('DBUS_SESSION_BUS_ADDRESS')) {
    if (!GLib.find_program_in_path('dbus-run-session')) {
        print('SKIP no session bus and no dbus-run-session');
    } else {
        const proc = Gio.Subprocess.new(['dbus-run-session', '--', 'gjs', '-m',
            import.meta.url.replace('file://', '')], Gio.SubprocessFlags.NONE);
        proc.wait(null);
        if (!proc.get_successful())
            throw new Error('dbus test failed under dbus-run-session');
    }
} else {
    await run();
}

async function run() {
const loop = new GLib.MainLoop(null, false);
const connection = Gio.DBus.session;
let activated = null;
let slow = false;

const impl = {
    GetInitialResultSetAsync(params, invocation) {
        if (slow)
            return; // never answers: the client must time out
        const terms = params[0];
        invocation.return_value(new GLib.Variant('(as)', [terms.includes('none') ? [] :
            ['file:///a/report.txt', 'file:///b/other.txt']]));
    },
    GetResultMetas(ids) {
        return ids.map(id => ({
            id: new GLib.Variant('s', id),
            name: new GLib.Variant('s', id.split('/').pop()),
            description: new GLib.Variant('s', 'in ' + id),
            gicon: new GLib.Variant('s', 'text-x-generic'),
        }));
    },
    ActivateResult(id, terms, ts) {
        activated = [id, terms, ts];
    },
};
const fakeApp = { get_name: () => 'Fake Files', get_icon: () => Gio.ThemedIcon.new('folder') };

async function main() {
    const exported = Gio.DBusExportedObject.wrapJSObject(XML, impl);
    exported.export(connection, PATH);
    Gio.bus_own_name_on_connection(connection, BUS, Gio.BusNameOwnerFlags.NONE, null, null);

    const dir = GLib.dir_make_tmp('guava-sp-XXXXXX');
    GLib.file_set_contents(`${dir}/t.ini`, `[Shell Search Provider]
DesktopId=org.gnome.Nautilus.desktop
BusName=${BUS}
ObjectPath=${PATH}
Version=2
`);
    GLib.file_set_contents(`${dir}/bad.ini`, '[Shell Search Provider]\nDesktopId=x.desktop\nBusName=nodots\nObjectPath=/x\nVersion=2\n');

    const search = new DBusSearch({ connection, searchSettings: null, dirs: [dir, '/nonexistent/dir'],
        lookupApp: id => (id === 'org.gnome.Nautilus.desktop' ? fakeApp : null) });
    const infos = await search.load();
    check('loads one valid provider, skips the bad one', infos.length === 1);
    check('files off drops it', search.sessionProviders({ files: false }).length === 0);
    const [prov] = search.sessionProviders({ files: true });
    const cancellable = new Gio.Cancellable();
    const items = await prov.search('report', cancellable);
    check('two items', items.length === 2, JSON.stringify(items.length));
    check('item fields', items[0].title === 'report.txt' && items[0].group === 'documents' &&
        items[0].kind === 'file' && items[0].gicon instanceof Gio.Icon);
    check('provider order kept in score', items[0].score > items[1].score);
    check('empty terms', (await prov.search('   ', cancellable)).length === 0);
    check('no results', (await prov.search('none', cancellable)).length === 0);
    await search.activate(items[0], 7);
    check('activate sent', activated && activated[0] === 'file:///a/report.txt' && activated[1][0] === 'report' && activated[2] === 7);

    slow = true;
    const t0 = GLib.get_monotonic_time();
    let err = null;
    try {
        await prov.search('report', new Gio.Cancellable());
    } catch (e) {
        err = e;
    }
    check('hung provider errors out on its D-Bus timeout', err !== null && (GLib.get_monotonic_time() - t0) < 4e6);

    const c2 = new Gio.Cancellable();
    const p = prov.search('report', c2).then(() => null, e => e);
    c2.cancel();
    const cancelErr = await p;
    check('cancel rejects with cancelled', cancelErr?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
}

    main().catch(e => {
        failed++;
        print(`FAIL exception: ${e}\n${e.stack}`);
    }).finally(() => loop.quit());
    loop.run();
    if (failed > 0)
        throw new Error(`${failed} test(s) failed`);
    print('dbus: done');
}
