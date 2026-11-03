// Run: gjs -m tests/appMenusSetup.test.js
import {
    FLAGS_MARK, X11_FLAG, hasX11Flag, withX11Flag, withoutX11Flag, detectFlagApps, execProgram,
    isFlatpakId, flatpakOverrideArgv, parseFlatpakList, overrideAllows,
} from '../src/core/appMenus/setupModel.js';

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

test('flag line is added once and removed exactly', () => {
    const user = '--enable-features=UseOzonePlatform\n# mine\n';
    const on = withX11Flag(user);
    eq(on, `${user}${X11_FLAG} ${FLAGS_MARK}\n`);
    eq(hasX11Flag(on), true);
    eq(withX11Flag(on), on);
    eq(withoutX11Flag(on), user);
});
test('a flags file without a final newline, or empty or missing', () => {
    eq(withX11Flag('--a'), `--a\n${X11_FLAG} ${FLAGS_MARK}\n`);
    eq(withoutX11Flag(withX11Flag('--a')), '--a\n');
    eq(withX11Flag(''), `${X11_FLAG} ${FLAGS_MARK}\n`);
    eq(withoutX11Flag(withX11Flag(null)), '');
    eq(hasX11Flag(null), false);
});
test('the user own --ozone-platform line is never touched', () => {
    const t = `${X11_FLAG}\n`;
    eq(hasX11Flag(t), false);
    eq(withoutX11Flag(t), t);
});
test('detects installed apps by the program of their desktop entry', () => {
    eq(detectFlagApps(['firefox', 'code', 'chromium-browser']).map(a => a.id), ['chromium', 'code']);
    eq(detectFlagApps([]), []);
    eq(execProgram('/usr/bin/code --unity-launch %F'), 'code');
    eq(execProgram('env GDK_BACKEND=x11 /opt/brave/brave-browser %U'), 'brave-browser');
    eq(execProgram(''), '');
});
test('flatpak ids and override commands', () => {
    eq(isFlatpakId('org.mozilla.firefox'), true);
    eq(isFlatpakId('x; rm -rf'), false);
    eq(isFlatpakId('--filesystem=host'), false);
    eq(flatpakOverrideArgv('org.kde.kate', true),
        ['flatpak', 'override', '--user', '--talk-name=com.canonical.AppMenu.Registrar', 'org.kde.kate']);
    eq(flatpakOverrideArgv('org.kde.kate', false)[3], '--no-talk-name=com.canonical.AppMenu.Registrar');
    eq(flatpakOverrideArgv('--evil', true), null);
});
test('flatpak list and override output', () => {
    eq(parseFlatpakList('org.b.App\norg.a.App\n\norg.b.App\nnot an id\n'), ['org.a.App', 'org.b.App']);
    eq(overrideAllows('[Session Bus Policy]\ncom.canonical.AppMenu.Registrar=talk\n'), true);
    eq(overrideAllows('[Session Bus Policy]\n'), false);
});

if (failed > 0)
    imports.system.exit(1);
