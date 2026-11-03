# GNOME JavaScript style and lint

Summary: the conventions GNOME's own JavaScript follows (gjs style guide plus gnome-shell's ESLint flat config built on `eslint-config-gnome`), and how to apply them to Guava without fighting its existing style.
It also covers naming, imports, JSDoc, and how to set up ESLint locally even though `eslint-config-gnome` is not on npm.
Verified against gjs `doc/Style_Guide.md` (master), gnome-shell `tools/eslint.config.js` and `tools/package.json` (main), the npm registry (no `eslint-config-gnome`; `@girs/*` present), and the Guava sources.

## Contents
1. Conventions (from the gjs style guide)
2. gnome-shell ESLint config (what CI enforces upstream)
3. Guava house style (follow this first)
4. Setting up ESLint for Guava (optional)
5. JSDoc and types
6. Sources

## 1. Conventions (gjs doc/Style_Guide.md)
- "The style guide for JS code in GJS is, by definition, the eslint config
  file". The guide only adds what lint can't check.
- Imports: CamelCase names for modules (`import St from 'gi://St'`,
  `import * as Main from …`).
- `const` by default and `let` when reassigned. Avoid `var` (it is only needed
  for legacy exports).
- `this` is not captured by closures. Use arrow functions or `.bind(this)`.
- Object literals: `{bar: 42}` for "member variables". Use brackets
  `foo['bar']` only for hash-table-like use.
- Naming: `lowerCamelCase` for variables and methods, `CamelCase` for types,
  `_leadingUnderscore` for private members and module-private variables.
  Keep C names as-is when calling introspected API (`get_children()`).
  Avoid true globals. If unavoidable, namespace them.

## 2. gnome-shell ESLint config (tools/eslint.config.js, flat config)
```js
import gnome from 'eslint-config-gnome';
export default defineConfig([
  gnome.configs.recommended, gnome.configs.jsdoc,
  {rules: {
    camelcase: ['error', {properties: 'never'}],
    'consistent-return': 'error',
    eqeqeq: ['error', 'smart'],
    'key-spacing': ['error', {mode: 'minimum', beforeColon: false, afterColon: true}],
    'prefer-arrow-callback': 'error',
    'prefer-const': ['error', {destructuring: 'all'}],
    'jsdoc/require-param-description': 'off',
    'jsdoc/require-jsdoc': ['error', {exemptEmptyFunctions: true, publicOnly: {esm: true}}],
  }},
  {files: ['js/**'], languageOptions: {globals: {global: 'readonly', _: 'readonly',
    C_: 'readonly', N_: 'readonly', ngettext: 'readonly'}}},
  {files: ['tests/unit/**'], languageOptions: {globals: {...globals.jasmine}}},
]);
```
- `eslint-config-gnome` comes from
  `git+https://gitlab.gnome.org/World/javascript/eslint-config-gnome.git` (pinned
  commit in `tools/package.json`). `npm view eslint-config-gnome` returns 404.
- Upstream Shell style visible in the source: 4-space indent, single quotes,
  semicolons, **no spaces inside braces** (`{a, b}`), trailing commas in
  multiline literals, `const` arrow callbacks, and early returns.

## 3. Guava house style (follow this first)
From `extension.js` and `features/*/index.js`:
- `// SPDX-License-Identifier: GPL-3.0-or-later` header in apps modules, plus
  a one-line comment saying what the module does. `extension.js` carries the
  full GPL header.
- Each feature module exports `enable(...)` and `disable()`, and keeps
  module-level `let` state (`_enabled`, ids, actors) with `_`-prefixed
  names. `extension.js` imports them as `{ enable as fooEnable, disable as fooDisable }`.
- Guava uses **spaces inside import braces** (`import { Extension } from …`)
  while upstream doesn't. Match the file you're editing.
- Constants are `UPPER_SNAKE` at module top (`ANIM_IN_MS`, `HIDE_DELAY_MS`).
- Comments explain *why*, citing GNOME issues or Guava issue numbers
  ("Fixes #109"), and explain version quirks next to the code (see
  `(Kiwi: apps/windowTiling.js; Guava equivalent not verified)` `MAXIMIZE_ARGS`).
- Commit style: `fix: …` and `feat: …` (conventional commits, from git log).
- Don't leave LLM-prompt-like comments or dead code. EGO rejects them under
  the AI rule.

## 4. Setting up ESLint for Guava (optional)
No config is committed today. A minimal local setup:
```sh
npm init -y >/dev/null
npm i -D eslint globals @eslint/config-helpers \
  'git+https://gitlab.gnome.org/World/javascript/eslint-config-gnome.git'
```
```js
// eslint.config.js
import {defineConfig} from '@eslint/config-helpers';
import gnome from 'eslint-config-gnome';
export default defineConfig([
  gnome.configs.recommended,
  {languageOptions: {globals: {global: 'readonly'}}},
  {ignores: ['advanced/**', 'po/**', 'icons/**']},
  {rules: {'object-curly-spacing': 'off'}},   // tolerate Guava's "{ a }" import style
]);
```
gitlab.gnome.org must be reachable. Otherwise vendor the config. Adding these
files changes the repo, so only do it when asked, and keep `node_modules` out
of the extension zip (`gnome-extensions pack` only includes the default files
plus `--extra-source` paths).

## 5. JSDoc and types
- Upstream requires JSDoc on public ESM exports (`publicOnly: {esm: true}`).
  Document `@param` types such as `{Meta.Window}` or `{Clutter.Actor}` and
  `@returns`.
- Editor types: `npm i -D @girs/gnome-shell @girs/gjs` (GIR typings;
  `@girs/gnome-shell` 50.0.4 at research time). gjs.guide "TypeScript and LSP"
  loads them through an `ambient.d.ts` listed in the tsconfig/jsconfig
  `include`, containing `import "@girs/gjs"; import "@girs/gjs/dom";
  import "@girs/gnome-shell/ambient"; import "@girs/gnome-shell/extensions/global";`
  (its tsconfig: `module`/`moduleResolution` `NodeNext`, `target` `ES2023`).
- Since gjs 1.83.1, GJS supports source maps if you ever compile from
  TypeScript (gjs NEWS). Ship only the compiled JS, unminified (EGO-A-001).

## 6. Sources
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Style_Guide.md
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/tools/eslint.config.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/tools/package.json
- https://gitlab.gnome.org/World/javascript/eslint-config-gnome
- https://gjs.guide/extensions/development/typescript.html
- https://www.npmjs.com/package/@girs/gnome-shell
