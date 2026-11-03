#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// check-refs.mjs: references that only fail at run time in the Shell, checked statically.
//  1. Every relative import (static and dynamic) points at a file that exists, and every named
//     import is exported by that file.
//  2. Every Guava settings key the code reads or writes exists in the schema.
// Exit 1 with one line per problem. Run by `make check`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'docs', 'tools', '.claude', 'packaging', 'i18n', 'assets']);
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name))
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            walk(p);
        else if (e.name.endsWith('.js'))
            files.push(p);
    }
})(ROOT);

const src = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const problems = [];
const rel = f => path.relative(ROOT, f);

// espree (eslint's parser) gives exact imports and exports. It ships with eslint, which `make lint`
// already needs; look for it next to eslint (global or local) or on NODE_PATH.
const require = createRequire(import.meta.url);
function loadEspree() {
    const roots = [process.env.ESPREE_DIR, process.env.NPM_ROOT && path.join(process.env.NPM_ROOT, 'eslint', 'node_modules', 'espree'),
        process.env.NPM_ROOT && path.join(process.env.NPM_ROOT, 'espree'), '/opt/node-tools/node_modules/espree'].filter(Boolean);
    for (const r of ['espree', ...roots]) {
        try {
            return require(r);
        } catch {}
    }
    throw new Error('check-refs: espree not found (install eslint, or set NPM_ROOT=$(npm root -g))');
}
const espree = loadEspree();
const parse = text => espree.parse(text, { ecmaVersion: 2024, sourceType: 'module' });

const exportCache = new Map();
function exportsOf(file) {
    if (exportCache.has(file))
        return exportCache.get(file);
    const names = new Set();
    for (const n of parse(fs.readFileSync(file, 'utf8')).body) {
        if (n.type === 'ExportDefaultDeclaration')
            names.add('default');
        if (n.type === 'ExportNamedDeclaration') {
            if (n.declaration?.id)
                names.add(n.declaration.id.name);
            for (const d of n.declaration?.declarations ?? []) {
                if (d.id.type === 'Identifier')
                    names.add(d.id.name);
                for (const p of d.id.properties ?? [])
                    names.add(p.value?.name ?? p.key?.name);
            }
            for (const sp of n.specifiers ?? [])
                names.add(sp.exported.name ?? sp.exported.value);
        }
        if (n.type === 'ExportAllDeclaration')
            names.add('*');
    }
    exportCache.set(file, names);
    return names;
}

// Every literal relative module specifier, static or dynamic, with its named imports
function importsOf(ast) {
    const out = [];
    for (const n of ast.body) {
        if (n.type === 'ImportDeclaration' && n.source.value.startsWith('.'))
            out.push({ spec: n.source.value, specifiers: n.specifiers });
        if ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source?.value.startsWith('.'))
            out.push({ spec: n.source.value, specifiers: [] });
    }
    (function visit(node) {
        if (!node || typeof node.type !== 'string')
            return;
        if (node.type === 'ImportExpression' && node.source.type === 'Literal' && String(node.source.value).startsWith('.'))
            out.push({ spec: node.source.value, specifiers: [] });
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (Array.isArray(v))
                v.forEach(visit);
            else if (v && typeof v === 'object' && k !== 'parent')
                visit(v);
        }
    })(ast);
    return out;
}

const asts = new Map();
for (const [file, text] of src) {
    let ast;
    try {
        ast = parse(text);
    } catch (e) {
        problems.push(`${rel(file)}: does not parse: ${e.message}`);
        continue;
    }
    asts.set(file, ast);
    for (const { spec, specifiers } of importsOf(ast)) {
        const target = path.resolve(path.dirname(file), spec.split('?')[0]);
        if (!fs.existsSync(target)) {
            problems.push(`${rel(file)}: imports missing file ${spec}`);
            continue;
        }
        if (!target.endsWith('.js') || !specifiers.length)
            continue;
        const ex = exportsOf(target);
        if (ex.has('*'))
            continue;
        for (const sp of specifiers) {
            if (sp.type === 'ImportSpecifier' && !ex.has(sp.imported.name))
                problems.push(`${rel(file)}: '${sp.imported.name}' is not exported by ${spec}`);
            if (sp.type === 'ImportDefaultSpecifier' && !ex.has('default'))
                problems.push(`${rel(file)}: default import but ${spec} has no default export`);
        }
    }
}

// Settings keys: string literals passed to the Guava settings accessors
const schemaFile = path.join(ROOT, 'src', 'schemas', 'org.gnome.shell.extensions.guava-os.gschema.xml');
const schema = fs.readFileSync(schemaFile, 'utf8');
const keys = new Set([...schema.matchAll(/<key\s+name="([^"]+)"/g)].map(m => m[1]));
// Keys of GNOME 50's own schemas (Fedora 44, /usr/share/glib-2.0/schemas), for code that reads
// org.gnome.* settings through an object also called `settings`. Regenerate with the root build.
const FOREIGN = new Set(fs.readFileSync(path.join(ROOT, 'tools', 'gnome50-keys.txt'), 'utf8').split('\n').filter(Boolean));
const ACCESS = /\b(?:settings|_settings|ks|gs|s)\.(?:get_(?:boolean|int|uint|double|string|strv|enum|flags|value|int64|uint64)|set_(?:boolean|int|uint|double|string|strv|enum|flags|value|int64|uint64)|reset|bind|get|set|watch|is_writable|create_action)\(\s*['"]([a-z0-9-]+)['"]/g;
const CHANGED = /['"]changed::([a-z0-9-]+)['"]/g;
for (const [file, text] of src) {
    const s = text;
    if (file.includes(`${path.sep}tests${path.sep}`))
        continue;
    for (const re of [ACCESS, CHANGED]) {
        for (const m of s.matchAll(re)) {
            const key = m[1];
            if (!keys.has(key) && !FOREIGN.has(key))
                problems.push(`${rel(file)}: settings key '${key}' is not in the Guava schema`);
        }
    }
}

// The harness skips errors that carry GUAVA-TEST-EXPECTED (a scenario throwing on purpose). Shipped
// code must never contain it, or a real error could hide behind it.
for (const [file, text] of src) {
    if (text.includes('GUAVA-TEST-EXPECTED'))
        problems.push(`${rel(file)}: contains the harness's expected-error marker GUAVA-TEST-EXPECTED`);
}

if (problems.length) {
    console.log([...new Set(problems)].join('\n'));
    console.log(`check-refs: ${new Set(problems).size} problem(s)`);
    process.exit(1);
}
console.log(`check-refs OK: ${files.length} files, ${keys.size} schema keys`);
