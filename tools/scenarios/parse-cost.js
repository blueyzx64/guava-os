// parse-cost.js: login parse cost of Guava's modules (B34). Parses every module under the
// given paths with SpiderMonkey (`new Function(source)` once `import` / `export` are stripped:
// the same syntax pass a module gets at import, nothing runs) and prints, per file, the median of
// several parses, plus the total of the files a feature graph pulls in.
//
//   gjs -m tools/scenarios/parse-cost.js [--top N] [--graph file.js ...]
//
// Without --graph: every .js file of the extension, slowest first. With --graph: the static
// import closure of those entry files (what `import()` of them parses), slowest first, and the
// total. Host numbers (no llvmpipe, idle CPU): compare files with each other, not with a Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// The extension's sources live under src/ (the zip's root)
const ROOT = `${GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace('file://', ''))))}/src`;
const SKIP = new Set(['node_modules', 'tests', 'tools', 'docs', 'schemas', '.git', '.claude', 'dist']);
const RUNS = 7;

const read = rel => new TextDecoder().decode(Gio.File.new_for_path(`${ROOT}/${rel}`).load_contents(null)[1]);

function listFiles(rel = '') {
    const out = [];
    const dir = Gio.File.new_for_path(`${ROOT}/${rel}`);
    const en = dir.enumerate_children('standard::name,standard::type', 0, null);
    let info;
    while ((info = en.next_file(null))) {
        const name = info.get_name();
        const path = rel ? `${rel}/${name}` : name;
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            if (!SKIP.has(name))
                out.push(...listFiles(path));
        } else if (name.endsWith('.js')) {
            out.push(path);
        }
    }
    return out;
}

const IMPORT = /^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?/gms;
const EXPORT_FROM = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]\s*;?/gms;

function strip(src) {
    return src
        .replace(IMPORT, '')
        .replace(EXPORT_FROM, '')
        .replace(/^export\s+default\s+/gm, '')
        .replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '')
        .replace(/^export\s*\{[^}]*\}\s*;?/gm, '');
}

function staticImports(rel, src) {
    const dir = GLib.path_get_dirname(rel);
    const out = [];
    for (const re of [IMPORT, EXPORT_FROM]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
            if (!m[1].startsWith('.'))
                continue;
            const p = GLib.build_filenamev([dir, m[1]]);
            out.push(p.replace(/(^|\/)\.\//g, '$1').split('/').reduce((a, s) => {
                if (s === '..')
                    a.pop();
                else if (s !== '.' && s !== '')
                    a.push(s);
                return a;
            }, []).join('/'));
        }
    }
    return out;
}

function parseMs(src) {
    const body = strip(src);
    const times = [];
    for (let i = 0; i < RUNS; i++) {
        const a = GLib.get_monotonic_time();
        // A unique suffix keeps SpiderMonkey's source cache from answering
        new Function(`${body}\n//${i}-${a}`);
        times.push((GLib.get_monotonic_time() - a) / 1000);
    }
    return times.sort((x, y) => x - y)[RUNS >> 1];
}

const args = System.programArgs.slice();
let top = 40;
const graph = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top')
        top = Number(args[++i]);
    else if (args[i] === '--graph')
        while (i + 1 < args.length && !args[i + 1].startsWith('--'))
            graph.push(args[++i]);
}

let files;
if (graph.length) {
    const seen = new Set();
    const walk = rel => {
        if (seen.has(rel))
            return;
        seen.add(rel);
        try {
            for (const d of staticImports(rel, read(rel)))
                walk(d);
        } catch {
            // a path that is not a file (resource: URL, typo): ignore
        }
    };
    graph.forEach(walk);
    files = [...seen];
} else {
    files = listFiles();
}

const rows = files.map(f => {
    const src = read(f);
    try {
        return { f, ms: parseMs(src), bytes: src.length };
    } catch (e) {
        print(`SKIP ${f}: ${e.message}`);
        return { f, ms: 0, bytes: src.length };
    }
}).sort((a, b) => b.ms - a.ms);
const total = rows.reduce((s, r) => s + r.ms, 0);
for (const r of rows.slice(0, top))
    print(`${r.ms.toFixed(2).padStart(7)} ms ${String(r.bytes).padStart(7)} B  ${r.f}`);
print(`TOTAL ${total.toFixed(1)} ms over ${rows.length} files, ${rows.reduce((s, r) => s + r.bytes, 0)} B`);
System.exit(0);
