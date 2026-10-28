// Run: gjs -m tests/clipboardStore.test.js   (real Gio async I/O in a temp dir)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ClipboardStore } from '../features/clipboard/store.js';
import { History, imageFileName, makeEntry, orphanFiles } from '../features/clipboard/model.js';

let failed = 0;
const loop = new GLib.MainLoop(null, false);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function eq(a, b, msg = '') {
    if (a !== b)
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const H = n => String(n).padStart(64, '0');
const mode = path => Gio.File.new_for_path(path).query_info('unix::mode', 0, null)
    .get_attribute_uint32('unix::mode') & 0o777;

test('save, load, modes 0600/0700, clear', async () => {
    const base = GLib.dir_make_tmp('guava-clip-XXXXXX');
    const dir = GLib.build_filenamev([base, 'guava', 'clipboard']);
    const store = new ClipboardStore(dir);
    eq((await store.load()).entries.length, 0, 'empty load');

    const h = new History();
    h.add(makeEntry({ kind: 'text', hash: 'a', mime: 't', size: 3, time: 1, text: 'abc' }));
    const name = imageFileName(H(1), 'image/png');
    h.add(makeEntry({ kind: 'image', hash: H(1), mime: 'image/png', size: 4, time: 2, file: name, width: 1, height: 1 }));
    await store.writeImage(name, new GLib.Bytes(new Uint8Array([1, 2, 3, 4])));
    await store.saveIndex(h);

    eq(mode(dir), 0o700, 'dir mode');
    eq(mode(GLib.build_filenamev([dir, 'images'])), 0o700, 'images dir mode');
    eq(mode(GLib.build_filenamev([dir, 'history.json'])), 0o600, 'index mode');
    eq(mode(GLib.build_filenamev([dir, 'images', name])), 0o600, 'image mode');

    const back = (await new ClipboardStore(dir).load()).entries;
    eq(back.length, 2);
    eq((await store.readImage(name)).get_size(), 4);
    eq(await store.readImage('../history.json'), null, 'path trick refused');

    // orphan sweep removes only store-pattern files, leaves a stray user file alone
    const stray = GLib.build_filenamev([dir, 'images', 'notes.txt']);
    GLib.file_set_contents(stray, 'mine');
    const orphan = imageFileName(H(9), 'image/png');
    await store.writeImage(orphan, new GLib.Bytes(new Uint8Array([9])));
    await store.sweep(h, orphanFiles);
    eq(GLib.file_test(GLib.build_filenamev([dir, 'images', orphan]), GLib.FileTest.EXISTS), false, 'orphan gone');
    eq(GLib.file_test(stray, GLib.FileTest.EXISTS), true, 'user file kept');

    await store.clearAll();
    eq(GLib.file_test(GLib.build_filenamev([dir, 'history.json']), GLib.FileTest.EXISTS), false);
    eq(GLib.file_test(GLib.build_filenamev([dir, 'images', name]), GLib.FileTest.EXISTS), false);
    eq(GLib.file_test(stray, GLib.FileTest.EXISTS), true, 'user file kept after clear');
});

test('prepare repairs a wide mode on Guava dirs; load drops images with no file', async () => {
    const base = GLib.dir_make_tmp('guava-clip-XXXXXX');
    const dir = GLib.build_filenamev([base, 'guava', 'clipboard']);
    GLib.mkdir_with_parents(dir, 0o755);
    GLib.mkdir_with_parents(GLib.build_filenamev([dir, 'images']), 0o755);
    const store = new ClipboardStore(dir);
    await store.prepare();
    eq(mode(dir), 0o700, 'dir');
    eq(mode(GLib.build_filenamev([dir, 'images'])), 0o700, 'images');
    eq(mode(GLib.build_filenamev([base, 'guava'])), 0o755, 'guava/ itself is left alone');
    const h = new History();
    const name = imageFileName(H(5), 'image/png');
    h.add(makeEntry({ kind: 'image', hash: H(5), mime: 'image/png', size: 4, time: 1, file: name }));
    h.add(makeEntry({ kind: 'text', hash: 't', mime: 't', size: 1, time: 2, text: 'x' }));
    await store.saveIndex(h);
    const back = (await store.load()).entries;
    eq(back.length, 1, 'image without a file is dropped');
});

test('corrupt index: moved aside, not intact, images kept; only the newest .bad copy stays', async () => {
    const dir = GLib.dir_make_tmp('guava-clip-XXXXXX');
    GLib.mkdir_with_parents(GLib.build_filenamev([dir, 'images']), 0o700);
    const img = GLib.build_filenamev([dir, 'images', imageFileName(H(3), 'image/png')]);
    GLib.file_set_contents(img, 'x');
    GLib.file_set_contents(GLib.build_filenamev([dir, 'history.json.bad-1']), 'older');
    GLib.file_set_contents(GLib.build_filenamev([dir, 'notes.txt']), 'mine');
    GLib.file_set_contents(GLib.build_filenamev([dir, 'history.json']), '{oops');
    const r = await new ClipboardStore(dir).load();
    eq(r.entries.length, 0);
    eq(r.intact, false);
    const names = [];
    const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
    for (let i; (i = en.next_file(null));)
        names.push(i.get_name());
    eq(names.includes('history.json'), false, 'index moved');
    eq(names.filter(n => n.startsWith('history.json.bad-')).length, 1, 'one bad copy');
    eq(names.includes('history.json.bad-1'), false, 'older bad copy removed');
    eq(names.includes('notes.txt'), true, 'user file kept');
    eq(GLib.file_test(img, GLib.FileTest.EXISTS), true, 'image kept');
});

test('other version and oversize are not intact either; missing index is intact', async () => {
    const dir = GLib.dir_make_tmp('guava-clip-XXXXXX');
    GLib.mkdir_with_parents(GLib.build_filenamev([dir, 'images']), 0o700);
    const s = new ClipboardStore(dir);
    eq((await s.load()).intact, true, 'missing');
    GLib.file_set_contents(GLib.build_filenamev([dir, 'history.json']), '{"version":9,"items":[]}');
    eq((await s.load()).intact, false, 'version');
});

test('symlinked store folder: refuses to persist, writes and deletes nothing', async () => {
    const base = GLib.dir_make_tmp('guava-clip-XXXXXX');
    const target = GLib.build_filenamev([base, 'elsewhere']);
    GLib.mkdir_with_parents(GLib.build_filenamev([target, 'images']), 0o755);
    const victim = GLib.build_filenamev([target, 'images', imageFileName(H(4), 'image/png')]);
    GLib.file_set_contents(victim, 'x');
    GLib.mkdir_with_parents(GLib.build_filenamev([base, 'guava']), 0o755);
    const link = GLib.build_filenamev([base, 'guava', 'clipboard']);
    Gio.File.new_for_path(link).make_symbolic_link(target, null);
    const store = new ClipboardStore(link);
    let refused = false;
    try {
        await store.prepare();
    } catch (_e) {
        refused = true;
    }
    eq(refused, true, 'prepare rejects');
    eq(mode(target), 0o755, 'target not chmodded');
    await store.saveIndex(new History());
    await store.clearAll();
    eq(GLib.file_test(GLib.build_filenamev([target, 'history.json']), GLib.FileTest.EXISTS), false, 'no write');
    eq(GLib.file_test(victim, GLib.FileTest.EXISTS), true, 'no delete');
    eq((await store.load()).intact, false);
});

test('stored image with no size: header checked on load, junk dropped', async () => {
    const dir = GLib.dir_make_tmp('guava-clip-XXXXXX');
    const store = new ClipboardStore(dir);
    const h = new History();
    const name = imageFileName(H(6), 'image/png');
    h.add(makeEntry({ kind: 'image', hash: H(6), mime: 'image/png', size: 4, time: 1, file: name }));
    await store.writeImage(name, new GLib.Bytes(new Uint8Array([1, 2, 3, 4])));
    await store.saveIndex(h);
    eq((await store.load()).entries.length, 0);
});

(async () => {
    for (const [name, fn] of tests) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}: ${e.message}`);
        }
    }
    if (failed) {
        print(`${failed} failed`);
        imports.system.exit(1);
    }
    loop.quit();
})();
loop.run();
