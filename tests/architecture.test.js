// Run: gjs -m tests/architecture.test.js
// Rules of the code layout (docs/architecture/conventions.md) that a reviewer would otherwise
// have to remember:
//   1. A feature never imports another feature's files (it asks ctx.features or ctx.events);
//      only prefs pages compose feature prefs.
//   2. Every St.Button Guava builds has an accessible name (or a label).
//   3. Every St.Entry has an accessible name, and every ModalSurface announces itself
//      (a hint_text alone is not a name for a screen reader).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}

const root = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..']);
const read = rel => new TextDecoder().decode(Gio.File.new_for_path(`${root}/${rel}`).load_contents(null)[1]);
const exists = rel => GLib.file_test(`${root}/${rel}`, GLib.FileTest.EXISTS);

// Every .js file the extension ships, relative to the root
function sources() {
    const out = [];
    const walk = dir => {
        const e = Gio.File.new_for_path(`${root}/${dir}`).enumerate_children('standard::name,standard::type', 0, null);
        for (let info; (info = e.next_file(null));) {
            const rel = dir ? `${dir}/${info.get_name()}` : info.get_name();
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                walk(rel);
            else if (rel.endsWith('.js'))
                out.push(rel);
        }
    };
    for (const dir of ['lib', 'core', 'features', 'prefs'])
        walk(dir);
    return [...out, 'extension.js', 'prefs.js', 'features.js'];
}

test('Reset Everything: bookkeeping and caches are marked (internal), user toggles are not', () => {
    const xml = Gio.File.new_for_path(GLib.build_filenamev([root, 'schemas', 'org.gnome.shell.extensions.guava-os.gschema.xml'])).load_contents(null)[1];
    const text = new TextDecoder().decode(xml);
    const summary = k => text.match(new RegExp(`<key name="${k}"[\\s\\S]*?<summary>([^<]*)</summary>`))[1];
    for (const k of ['saved-originals', 'saved-originals-backup', 'dock-recent-apps'])
        if (!summary(k).endsWith('(internal)'))
            throw new Error(`${k} must be marked (internal)`);
    if (summary('clipboard-recording').endsWith('(internal)'))
        throw new Error('clipboard-recording is a user toggle');
});
test('features do not import each other', () => {
    const hits = [];
    for (const f of sources().filter(s => s.startsWith('features/') && !s.endsWith('/prefs.js'))) {
        const own = f.split('/')[1];
        for (const m of read(f).matchAll(/from '([^']+)'/g)) {
            const target = GLib.canonicalize_filename(m[1], `${root}/${GLib.path_get_dirname(f)}`)
                .slice(GLib.canonicalize_filename(root, null).length + 1);
            const parts = target.split('/');
            if (parts[0] === 'features' && parts[1] !== own)
                hits.push(`${f} -> ${target}`);
        }
    }
    if (hits.length)
        throw new Error(hits.join('; '));
});

test('every St.Button has an accessible name or a label', () => {
    const hits = [];
    for (const f of sources()) {
        const text = read(f);
        for (const m of text.matchAll(/new St\.Button\(\{/g)) {
            // The constructor's object literal, by brace depth
            let i = m.index + m[0].length;
            for (let depth = 1; depth && i < text.length; i++)
                depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
            const props = text.slice(m.index, i);
            const after = text.slice(i, i + 600);
            if (!/accessible_name|\blabel\b/.test(props) && !/accessible_name\s*=|set_accessible_name/.test(after))
                hits.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
        }
    }
    if (hits.length)
        throw new Error(`unnamed buttons at ${hits.join(', ')}`);
});

// The object literal after `new <ctor>({`, by brace depth
function literalAfter(text, index, length) {
    let i = index + length;
    for (let depth = 1; depth && i < text.length; i++)
        depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    return [text.slice(index, i), i];
}

test('every St.Entry has an accessible name', () => {
    const hits = [];
    for (const f of sources()) {
        const text = read(f);
        for (const m of text.matchAll(/new St\.Entry\(\{/g)) {
            const [props, end] = literalAfter(text, m.index, m[0].length);
            if (!/accessible_name/.test(props) && !/accessible_name\s*=|set_accessible_name/.test(text.slice(end, end + 600)))
                hits.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
        }
    }
    if (hits.length)
        throw new Error(`unnamed entries at ${hits.join(', ')}`);
});

test('every ModalSurface has an accessibleName', () => {
    const hits = [];
    for (const f of sources()) {
        if (f === 'lib/modalSurface.js')
            continue;
        const text = read(f);
        for (const m of text.matchAll(/new ModalSurface\(\w+, \{/g)) {
            const [props] = literalAfter(text, m.index, m[0].length);
            if (!/accessibleName/.test(props))
                hits.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
        }
    }
    if (hits.length)
        throw new Error(`unnamed modals at ${hits.join(', ')}`);
});

test('every feature folder has an index.js', () => {
    const e = Gio.File.new_for_path(`${root}/features`).enumerate_children('standard::name', 0, null);
    for (let info; (info = e.next_file(null));) {
        if (!exists(`features/${info.get_name()}/index.js`))
            throw new Error(`features/${info.get_name()} has no index.js`);
    }
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
