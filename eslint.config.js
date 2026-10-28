// SPDX-License-Identifier: GPL-3.0-or-later
// Dependency-free flat config. Mirrors gnome-shell's tools/eslint.config.js rule
// set where it does not need eslint-config-gnome (not on npm).
const gjsGlobals = {
    global: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    imports: 'readonly',
    console: 'readonly',
    window: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    AbortController: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    queueMicrotask: 'readonly',
    structuredClone: 'readonly',
    _: 'readonly',
    C_: 'readonly',
    N_: 'readonly',
    ngettext: 'readonly',
};

// EGO: legacy modules are rejected (every file)
const LEGACY = {group: ['resource:///org/gnome/gjs/modules/*'], message: 'Legacy module; EGO rejects it.'};
const restrict = (...patterns) => ['error', {patterns: [LEGACY, ...patterns]}];

export default [
    {ignores: ['po/**', 'icons/**', 'docs/**', 'node_modules/**', 'dist/**', 'tools/harness/**']},
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        linterOptions: {reportUnusedDisableDirectives: 'warn'},
        rules: {
            // correctness
            'no-undef': 'error',
            'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none'}],
            'no-var': 'error',
            'no-redeclare': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-unreachable': 'error',
            'no-self-assign': 'error',
            'no-const-assign': 'error',
            'no-shadow-restricted-names': 'error',
            'no-throw-literal': 'error',
            'no-loss-of-precision': 'error',
            'no-prototype-builtins': 'warn',
            'no-empty': ['warn', {allowEmptyCatch: true}],
            'no-useless-escape': 'warn',
            'no-case-declarations': 'warn',
            // gnome-shell house rules
            'consistent-return': 'warn',
            eqeqeq: ['error', 'smart'],
            'prefer-const': ['warn', {destructuring: 'all'}],
            'prefer-arrow-callback': 'warn',
            camelcase: ['warn', {properties: 'never'}],
            // EGO: legacy modules are rejected
            // Shell code never loads GTK (EGO); prefs override this below
            'no-restricted-imports': restrict({group: ['gi://Gtk', 'gi://Gdk', 'gi://Adw'], message: 'GTK in the Shell process.'}),
            'no-restricted-properties': ['error',
                {object: 'imports', property: 'mainloop', message: 'Use GLib.timeout_add.'},
                {object: 'imports', property: 'lang', message: 'Use native classes.'},
                {object: 'imports', property: 'byteArray', message: 'Use TextDecoder.'},
            ],
            // style (4 spaces, single quotes, semicolons; imports spacing left alone)
            semi: ['warn', 'always'],
            quotes: ['warn', 'single', {avoidEscape: true, allowTemplateLiterals: true}],
            indent: 'off',
            'object-curly-spacing': 'off',
        },
    },
    {
        // prefs runs in its own process: no Shell globals. gettext must be imported
        // (`gettext as _`) or taken from the extension; N_ is not provided there.
        files: ['prefs.js', 'features/**/prefs.js', 'prefs/**/*.js'],
        languageOptions: {
            globals: {global: 'off', _: 'off', C_: 'off', N_: 'off', ngettext: 'off'},
        },
    },
    {
        // Pure models and core logic run under plain `gjs -m` in tests: no Shell, no GTK
        files: ['core/*Model.js', 'core/**/model.js', 'core/appMenus/*Model.js', 'core/events.js', 'core/originals.js', 'features/**/model.js', 'features/**/*Model.js',
            'lib/*Model.js', 'lib/featureRegistry.js', 'lib/settings.js', 'lib/jobQueue.js'],
        rules: {
            'no-restricted-imports': restrict({group: ['gi://*', 'resource://*'], message: 'Pure module: no gi:// or resource:// imports (move it to the adapter).'}),
        },
    },
    {
        // Prefs never load Shell modules, and Shell code never loads GTK (EGO)
        files: ['prefs.js', 'prefs/**/*.js', 'features/**/prefs.js'],
        rules: {
            'no-restricted-imports': restrict({group: ['gi://Clutter', 'gi://Meta', 'gi://St', 'gi://Shell', 'resource:///org/gnome/shell/*'], caseSensitive: true, message: 'Shell module in the prefs process.'}),
        },
    },
];
