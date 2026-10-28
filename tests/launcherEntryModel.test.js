// Run: gjs -m tests/launcherEntryModel.test.js
// lib/launcherEntryModel.js and lib/backgroundAppsModel.js: badges and background apps.
import { LauncherEntries, appIdFromUri, isBlank } from '../lib/launcherEntryModel.js';
import { backgroundAppIds, gApplicationPath } from '../lib/backgroundAppsModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('uri: application:// ids, .desktop added; anything else ignored', () => {
    eq(appIdFromUri('application://org.gnome.Geary.desktop'), 'org.gnome.Geary.desktop');
    eq(appIdFromUri('application://telegram'), 'telegram.desktop');
    eq([appIdFromUri('file:///x'), appIdFromUri('application://'), appIdFromUri(null), appIdFromUri('application://a/b')], [null, null, null, null]);
});
test('update: fields merge over earlier ones', () => {
    const e = new LauncherEntries();
    eq(e.update(':1.5', 'application://mail.desktop', { 'count': 4, 'count-visible': true }), 'mail.desktop');
    e.update(':1.5', 'application://mail.desktop', { 'progress': 0.5, 'progress-visible': true, 'bogus': 1 });
    eq(e.get('mail.desktop'), { count: 4, countVisible: true, progress: 0.5, progressVisible: true, urgent: false });
    eq(e.update(':1.5', 'nope', {}), null);
    eq(isBlank(e.get('mail.desktop')), false);
    eq(isBlank(null), true);
});
test('sender gone: its entries go, unless another sender still holds the app', () => {
    const e = new LauncherEntries();
    e.update(':1.1', 'application://a.desktop', { urgent: true });
    e.update(':1.1', 'application://b.desktop', { 'count': 1, 'count-visible': true });
    e.update(':1.2', 'application://b.desktop', { 'count': 2 });
    eq(e.senderGone(':1.1'), ['a.desktop']);
    eq(e.get('a.desktop'), null);
    eq(e.get('b.desktop').count, 2);
    eq(e.senderGone(':1.9'), []);
    eq(e.senders(), [':1.2']);
});
test('background apps: desktop ids, deduplicated, bad entries skipped', () => {
    eq(backgroundAppIds([{ app_id: 'org.gnome.Calculator' }, { app_id: 'org.gnome.Calculator', instance: '2' },
        { app_id: 'x.desktop' }, { app_id: '' }, { message: 'm' }, null, { app_id: 'a/b' }]),
    ['org.gnome.Calculator.desktop', 'x.desktop']);
    eq(backgroundAppIds(undefined), []);
});
test('background apps: the GApplication name and path of a desktop id', () => {
    eq(gApplicationPath('org.gnome.Text-Editor.desktop'), { name: 'org.gnome.Text-Editor', path: '/org/gnome/Text_Editor' });
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
