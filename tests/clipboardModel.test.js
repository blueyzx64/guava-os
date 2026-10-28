// Run: gjs -m tests/clipboardModel.test.js
import {
    DEFAULTS, History, MiB, ageOf, checkSize, classifyText, hasSecretHint, historyFrom,
    imageFileName, isBlankText, isPasswordManagerApp, isSecret, isStoreFileName, makeEntry,
    mergeLoaded, orphanFiles, parseHistory, pasteChordFor, pickMime, previewOf, serializeHistory, shouldRecord,
    TYPE_ICON, tileIconProps,
} from '../features/clipboard/model.js';

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
function eq(a, b, msg = '') {
    if (a !== b)
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const H64 = n => String(n).padStart(64, '0');
let clock = 1000;
const text = (s, extra = {}) => makeEntry({
    kind: 'text', hash: `h-${s}`, mime: 'text/plain;charset=utf-8', size: s.length, time: clock++, text: s, ...extra,
});
const image = (n, extra = {}) => makeEntry({
    kind: 'image', hash: H64(n), mime: 'image/png', size: 1000, time: clock++,
    file: imageFileName(H64(n), 'image/png'), ...extra,
});

/* ---- secrets ---- */
test('hint mime marks a secret', () => {
    eq(hasSecretHint(['text/plain', 'x-kde-passwordManagerHint']), true);
    eq(hasSecretHint(['text/plain']), false);
    eq(isSecret({ mimes: ['x-kde-passwordManagerHint'] }), true);
});
test('known password manager apps are secret, ids and classes alike', () => {
    for (const a of ['KeePassXC', 'org.keepassxc.KeePassXC', 'Bitwarden', '1password', 'org.gnome.World.Secrets',
        'com.bitwarden.desktop', 'org.keepassxc.KeePassXC.desktop'])
        eq(isPasswordManagerApp(a), true, a);
});
test('ordinary apps are not secret', () => {
    for (const a of ['firefox', 'org.gnome.TextEditor', 'gedit', '', null, undefined, 'org.gnome.Passport'])
        eq(isPasswordManagerApp(a), false, String(a));
});
test('user excluded apps extend the list', () => {
    eq(isPasswordManagerApp('myvault', []), false);
    eq(isPasswordManagerApp('MyVault', ['myvault']), true);
});
test('ignoreSensitive=false records secrets', () => {
    eq(isSecret({ mimes: ['x-kde-passwordManagerHint'], app: 'keepassxc', ignoreSensitive: false }), false);
});

/* ---- mime and size ---- */
test('pickMime: text wins over image, order of preference', () => {
    eq(pickMime(['image/png', 'text/plain']).kind, 'text');
    eq(pickMime(['STRING', 'UTF8_STRING']).mime, 'UTF8_STRING');
    eq(pickMime(['image/jpeg', 'image/png']).mime, 'image/png');
});
test('pickMime: images off, unknown types', () => {
    eq(pickMime(['image/png'], { images: false }), null);
    eq(pickMime(['application/x-foo']), null);
    eq(pickMime(undefined), null);
});
test('checkSize limits', () => {
    eq(checkSize('text', 0), 'empty');
    eq(checkSize('text', 256 * 1024), 'ok');
    eq(checkSize('text', 256 * 1024 + 1), 'too-large');
    eq(checkSize('image', 5 * MiB), 'ok');
    eq(checkSize('image', 5 * MiB + 1), 'too-large');
    eq(checkSize('image', 10, { images: false }), 'disabled');
    eq(checkSize('image', 3 * MiB, { maxImageBytes: 2 * MiB }), 'too-large');
});
test('blank text', () => {
    eq(isBlankText('  \n\t'), true);
    eq(isBlankText('a'), false);
    eq(isBlankText(null), true);
});
test('shouldRecord needs enabled, recording and unlocked', () => {
    eq(shouldRecord({ enabled: true, recording: true, locked: false }), true);
    eq(shouldRecord({ enabled: true, recording: true, locked: true }), false);
    eq(shouldRecord({ enabled: true, recording: false, locked: false }), false);
    eq(shouldRecord({ enabled: false, recording: true, locked: false }), false);
});

/* ---- classify ---- */
test('classifyText', () => {
    eq(classifyText('https://example.org/a?b=1'), 'link');
    eq(classifyText('www.example.org'), 'link');
    eq(classifyText('mailto:a@b.co'), 'link');
    eq(classifyText('#ff8800'), 'color');
    eq(classifyText('rgb(1, 2, 3)'), 'color');
    eq(classifyText('hello https://x.org'), 'text');
    eq(classifyText('https://x.org\nmore'), 'text');
    eq(classifyText('#xyz'), 'text');
});
test('previewOf collapses and cuts', () => {
    eq(previewOf('a\n\n  b\tc'), 'a b c');
    eq(previewOf('x'.repeat(50), 10), 'xxxxxxxxx…');
});

/* ---- history ---- */
test('dedupe: same content bumps to top, keeps pin', () => {
    const h = new History();
    h.add(text('a')); h.add(text('b'));
    h.togglePin('text:h-a');
    const r = h.add(text('a', { app: 'gedit' }));
    eq(r.status, 'bumped');
    eq(h.size, 2);
    eq(h.items[0].id, 'text:h-a');
    eq(h.items[0].pinned, true);
    eq(h.items[0].app, 'gedit');
});
test('copying the newest item again is "same" (our own paste)', () => {
    const h = new History();
    h.add(text('a'));
    eq(h.add(text('a')).status, 'same');
    eq(h.size, 1);
});
test('same text and same image bytes are distinct kinds', () => {
    const h = new History();
    h.add(makeEntry({ kind: 'text', hash: 'x', mime: 'text/plain', size: 1, time: 1, text: 'x' }));
    h.add(makeEntry({ kind: 'image', hash: 'x', mime: 'image/png', size: 1, time: 2, file: '' }));
    eq(h.size, 2);
});
test('cap evicts the oldest unpinned and reports it', () => {
    const h = new History({ maxItems: 3 });
    for (const s of ['a', 'b', 'c']) h.add(text(s));
    const r = h.add(text('d'));
    eq(r.evicted.length, 1);
    eq(r.evicted[0].text, 'a');
    eq(h.size, 3);
    eq(h.items.map(e => e.text).join(), 'd,c,b');
});
test('pinned never evicted and do not count toward the cap', () => {
    const h = new History({ maxItems: 2 });
    h.add(text('a')); h.togglePin('text:h-a');
    for (const s of ['b', 'c', 'd', 'e']) h.add(text(s));
    eq(h.size, 3);
    eq(h.get('text:h-a') !== null, true);
    eq(h.view().pinned.length, 1);
    eq(h.view().recent.map(e => e.text).join(), 'e,d');
});
test('setMaxItems shrinks and clamps', () => {
    const h = new History({ maxItems: 10 });
    for (let i = 0; i < 6; i++) h.add(text(`t${i}`));
    eq(h.setMaxItems(2).length, 4);
    eq(h.size, 2);
    h.setMaxItems(0);
    eq(h.maxItems, 1);
    h.setMaxItems(99999);
    eq(h.maxItems, 500);
    h.setMaxItems('junk');
    eq(h.maxItems, DEFAULTS.maxItems);
});
test('clear keeps pinned by default, all on request', () => {
    const h = new History();
    h.add(text('a')); h.add(text('b')); h.togglePin('text:h-a');
    eq(h.clear().length, 1);
    eq(h.size, 1);
    eq(h.clear({ keepPinned: false }).length, 1);
    eq(h.size, 0);
});
test('remove and togglePin on unknown id', () => {
    const h = new History();
    eq(h.remove('nope'), null);
    eq(h.togglePin('nope'), null);
});
test('expire drops old unpinned only; off by default', () => {
    const h = new History({ maxAgeMs: 100 });
    const a = text('a'); a.time = 0;
    const b = text('b'); b.time = 0;
    const c = text('c'); c.time = 950;
    [a, b, c].forEach(e => h.add(e));
    h.togglePin(b.id);
    eq(h.expire(1000).length, 1);
    eq(h.size, 2);
    eq(new History().expire(1e12).length, 0);
});
test('view filters and search', () => {
    const h = new History();
    h.add(text('hello world', { app: 'Firefox' }));
    h.add(text('https://x.org'));
    h.add(image(1));
    eq(h.view({ filter: 'text' }).recent.length, 1);
    eq(h.view({ filter: 'links' }).recent.length, 1);
    eq(h.view({ filter: 'images' }).recent.length, 1);
    eq(h.view({ query: 'WORLD' }).recent.length, 1);
    eq(h.view({ query: 'firefox' }).recent.length, 1);
    eq(h.view({ filter: 'all' }).recent.length, 3);
});

/* ---- byte budget ---- */
const img = (n, size, extra = {}) => ({ ...image(n), size, ...extra });
test('image budget evicts the oldest unpinned images', () => {
    const h = new History({ maxItems: 50, maxTotalImageBytes: 3000 });
    for (let i = 1; i <= 3; i++) h.add(img(i, 1000));
    const r = h.add(img(4, 1000));
    eq(r.status, 'added');
    eq(r.evicted.length, 1);
    eq(r.evicted[0].hash, H64(1));
    eq(h.size, 3);
});
test('budget never evicts pinned; new image refused if only pinned remain', () => {
    const h = new History({ maxItems: 50, maxTotalImageBytes: 2000 });
    h.add(img(1, 1000)); h.add(img(2, 1000));
    h.togglePin(`image:${H64(1)}`); h.togglePin(`image:${H64(2)}`);
    const r = h.add(img(3, 1000));
    eq(r.status, 'refused');
    eq(h.size, 2);
});
test('text and image budgets are separate', () => {
    const h = new History({ maxItems: 50, maxTotalImageBytes: 1000, maxTotalTextBytes: 10 });
    h.add(img(1, 1000));
    h.add(text('12345678'));
    eq(h.size, 2);
    h.add(text('abcdefgh'));
    eq(h.size, 2, 'oldest text evicted, image kept');
    eq(h.items.some(e => e.kind === 'image'), true);
});
test('pin cap by count', () => {
    const h = new History({ maxPinned: 2, maxTotalImageBytes: 1500 });
    ['a', 'b', 'c'].forEach(s => h.add(text(s)));
    eq(h.togglePin('text:h-a'), true);
    eq(h.togglePin('text:h-b'), true);
    eq(h.togglePin('text:h-c'), null, 'count cap');
    eq(h.togglePin('text:h-a'), false, 'unpin always works');
});
test('configure shrinks the budget live', () => {
    const h = new History({ maxItems: 50 });
    for (let i = 1; i <= 4; i++) h.add(img(i, 1000));
    eq(h.configure({ maxTotalImageBytes: 2000 }).length, 2);
});
test('historyFrom applies budgets to loaded entries', () => {
    const es = [1, 2, 3].map(i => img(i, 1000));
    const { history, evicted } = historyFrom(es, { maxTotalImageBytes: 2000 });
    eq(history.size, 2);
    eq(evicted.length, 1);
});

/* ---- persistence ---- */
test('round trip keeps pin, order, text and image fields', () => {
    const h = new History();
    h.add(text('one')); h.add(image(2)); h.add(text('three'));
    h.togglePin('text:h-one');
    const back = parseHistory(serializeHistory(h));
    eq(back.length, 3);
    eq(back[0].text, 'three');
    eq(back[2].pinned, true);
    eq(back.find(e => e.kind === 'image').file, `${H64(2)}.png`);
});
test('parse: garbage and wrong version give empty, never throw', () => {
    eq(parseHistory('not json').length, 0);
    eq(parseHistory('{"version":99,"items":[]}').length, 0);
    eq(parseHistory('null').length, 0);
    eq(parseHistory('{"version":1,"items":"x"}').length, 0);
});
test('parse drops malformed, blank, oversize and duplicate items', () => {
    const items = [
        { kind: 'text', hash: 'a', text: 'ok', size: 2, time: 5 },
        { kind: 'text', hash: 'a', text: 'ok', size: 2, time: 4 },
        { kind: 'text', hash: 'b', text: '   ', size: 3, time: 3 },
        { kind: 'text', hash: 'c', text: 'big', size: 2 * MiB, time: 2 },
        { kind: 'text', text: 'nohash' },
        { kind: 'image', hash: 'd', file: '../../etc/passwd', size: 10, time: 1 },
        { kind: 'image', hash: H64(7), file: `${H64(7)}.png`, mime: 'image/png', size: 10, time: 1 },
        'junk', null,
    ];
    const out = parseHistory(JSON.stringify({ version: 1, items }));
    eq(out.length, 2);
    eq(out[0].text, 'ok');
    eq(out[1].kind, 'image');
});
test('parse re-applies lowered limits', () => {
    const items = [{ kind: 'image', hash: H64(1), file: `${H64(1)}.png`, size: 3 * MiB, time: 1 }];
    const json = JSON.stringify({ version: 1, items });
    eq(parseHistory(json).length, 1);
    eq(parseHistory(json, { maxImageBytes: MiB }).length, 0);
    eq(parseHistory(json, { images: false }).length, 0);
});
test('historyFrom applies cap and sorts newest first', () => {
    const es = [text('a'), text('b'), text('c')];
    const { history, evicted } = historyFrom([es[0], es[2], es[1]], { maxItems: 2 });
    eq(history.items.map(e => e.text).join(), 'c,b');
    eq(evicted.length, 1);
});
test('store file names: only hash.ext, no path tricks', () => {
    eq(isStoreFileName(`${H64(1)}.png`), true);
    eq(isStoreFileName('../x.png'), false);
    eq(isStoreFileName(`${H64(1)}.png/../a`), false);
    eq(isStoreFileName('history.json'), false);
    eq(imageFileName(H64(1), 'image/jpeg'), `${H64(1)}.jpg`);
    eq(imageFileName(H64(1), 'image/x-foo'), '');
});
test('orphanFiles lists only our own unreferenced files', () => {
    const h = new History();
    h.add(image(1));
    const o = orphanFiles([`${H64(1)}.png`, `${H64(2)}.png`, 'history.json', 'notes.txt'], h);
    eq(o.join(), `${H64(2)}.png`);
});

test('mergeLoaded keeps saved history and copies made during the load', () => {
    const saved = [text('old1'), text('old2'), text('both')];
    saved[2].pinned = true;
    const liveBoth = text('both');
    const live = [text('new'), liveBoth];
    const { history } = mergeLoaded(live, saved, { maxItems: 25 });
    eq(history.size, 4);
    eq(history.items[0].text, 'new');
    eq(history.items[1].text, 'both', 'live copy is newer than the saved ones');
    eq(history.get('text:h-both').pinned, false, 'live state wins');
    eq(history.items.map(e => e.text).includes('old1'), true, 'saved entries kept');
});

/* ---- paste ---- */
test('terminals paste with Ctrl+Shift+V', () => {
    eq(pasteChordFor('Gnome-terminal'), 'ctrl-shift-v');
    eq(pasteChordFor('org.gnome.Ptyxis'), 'ctrl-shift-v');
    eq(pasteChordFor('kitty'), 'ctrl-shift-v');
    eq(pasteChordFor('firefox'), 'ctrl-v');
    eq(pasteChordFor(null), 'ctrl-v');
});
test('ageOf buckets', () => {
    eq(ageOf(0, 10_000)[0], 'now');
    eq(ageOf(0, 5 * 60_000)[1], 5);
    eq(ageOf(0, 3 * 3600_000)[0], 'hours');
    eq(ageOf(0, 3 * 86400_000)[0], 'days');
});

/* ---- row tile: GJS on GNOME 50 throws on an `undefined` constructor property ---- */
test('tileIconProps never carries an undefined value', () => {
    const fake = { fake: 'gicon' };
    for (const type of ['text', 'link', 'color', 'image', 'bogus']) {
        for (const g of [null, undefined, fake]) {
            const p = tileIconProps(type, 34, g);
            for (const [k, v] of Object.entries(p))
                eq(v === undefined, false, `${type}/${g ? 'gicon' : 'glyph'} ${k}`);
        }
    }
});
test('tileIconProps: glyph for text, thumbnail for images', () => {
    const glyph = tileIconProps('link', 34);
    eq(glyph.icon_name, TYPE_ICON.link);
    eq('gicon' in glyph, false);
    eq(glyph.icon_size, 19);
    eq(tileIconProps('bogus', 30).icon_name, TYPE_ICON.text);
    const fake = { fake: 'gicon' };
    const thumb = tileIconProps('image', 30, fake);
    eq(thumb.gicon, fake);
    eq('icon_name' in thumb, false);
    eq(thumb.icon_size, 30);
});

/* ---- ordinary copies from ordinary apps are recorded ---- */
const CHROME_MIMES = ['chromium/x-source-url', 'text/html', 'text/plain;charset=utf-8', 'UTF8_STRING',
    'text/plain', 'STRING', 'TEXT', 'chromium/x-internal-source-rfh-token'];
const GTK4_MIMES = ['text/plain', 'text/plain;charset=ANSI_X3.4-1968', 'text/plain;charset=utf-8'];
const FIREFOX_MIMES = ['text/html', 'text/_moz_htmlinfo', 'text/_moz_htmlcontext', 'text/plain;charset=utf-8',
    'application/x-moz-nativehtml', 'text/x-moz-url-priv'];
const LIBREOFFICE_MIMES = ['application/x-openoffice-embed-source-xml;windows_formatname="Star Embed Source (XML)"',
    'text/rtf', 'text/html', 'text/plain;charset=utf-8', 'UTF8_STRING', 'image/png'];
test('normal apps and their mime sets are not secrets', () => {
    const apps = ['google-chrome', 'Google-chrome', 'google-chrome.desktop', 'Google Chrome', 'chromium-browser',
        'org.chromium.Chromium', 'org.gnome.TextEditor', 'org.gnome.TextEditor.desktop', 'Text Editor',
        'firefox', 'org.mozilla.firefox.desktop', 'org.gnome.Ptyxis', 'code', 'com.visualstudio.code',
        'libreoffice-writer', 'org.gnome.Nautilus', 'Files', 'Terminal', 'org.gnome.Console', 'Passport Photos',
        'org.gnome.Settings', 'Settings', 'Keep Notes', 'org.gnome.World.PikaBackup', '', null];
    for (const app of apps) {
        eq(isPasswordManagerApp(app), false, `app ${app}`);
        for (const mimes of [CHROME_MIMES, GTK4_MIMES, FIREFOX_MIMES, LIBREOFFICE_MIMES])
            eq(isSecret({ mimes, app }), false, `${app} ${mimes[0]}`);
    }
});
test('text mime is picked from browser and GTK4 offers (html first)', () => {
    eq(pickMime(CHROME_MIMES).mime, 'text/plain;charset=utf-8');
    eq(pickMime(GTK4_MIMES).mime, 'text/plain;charset=utf-8');
    eq(pickMime(FIREFOX_MIMES).mime, 'text/plain;charset=utf-8');
    eq(pickMime(LIBREOFFICE_MIMES).kind, 'text');
    eq(pickMime(['text/html', 'UTF8_STRING']).mime, 'UTF8_STRING');
    eq(pickMime(['text/html']), null);
});
test('only the hint mime marks a secret, not any application/x-* type', () => {
    eq(hasSecretHint(['application/x-moz-nativehtml', 'application/x-qt-image', 'text/plain']), false);
    eq(hasSecretHint(['x-kde-passwordManagerHint', 'text/plain']), true);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
