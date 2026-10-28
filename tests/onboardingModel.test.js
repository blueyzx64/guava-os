// Run: gjs -m tests/onboardingModel.test.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    ACCENTS, ONBOARDING_KEY, STATES, STEPS, appearanceChoice, appearanceWrites, offerDecision, shouldPresent,
} from '../features/onboarding/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const root = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..']);
const dir = GLib.dir_make_tmp('guava-onboarding-XXXXXX');
const [, , , status] = GLib.spawn_sync(null, ['glib-compile-schemas', '--targetdir', dir, `${root}/schemas`], null,
    GLib.SpawnFlags.SEARCH_PATH, null);
if (status !== 0)
    throw new Error('glib-compile-schemas failed');
const source = Gio.SettingsSchemaSource.new_from_directory(dir, null, false);
const schema = source.lookup('org.gnome.shell.extensions.guava-os', false);

const TYPES = { appearance: null, accent: 's', choice: 's', size: 'i', switch: 'b' };

test('the state key exists with the four states', () => {
    const key = schema.get_key(ONBOARDING_KEY);
    eq(key.get_value_type().dup_string(), 's');
    eq(key.get_range().recursiveUnpack(), ['enum', STATES]);
    eq(key.get_default_value().unpack(), 'new');
});
test('every step control names a schema key of the right type and values', () => {
    for (const step of STEPS) {
        for (const c of step.controls) {
            if (!(c.type in TYPES))
                throw new Error(`${step.id}: unknown control ${c.type}`);
            if (!TYPES[c.type])
                continue;
            if (!schema.has_key(c.key))
                throw new Error(`${step.id}: no key ${c.key}`);
            const key = schema.get_key(c.key);
            eq(key.get_value_type().dup_string(), TYPES[c.type], c.key);
            const values = c.type === 'accent' ? ACCENTS.map(([v]) => v) : c.values;
            for (const v of values ?? []) {
                if (!key.range_check(new GLib.Variant('s', v)))
                    throw new Error(`${c.key}: '${v}' is not a valid value`);
            }
            if (c.type === 'size') {
                for (const v of [c.lower, c.upper]) {
                    if (!key.range_check(new GLib.Variant('i', v)))
                        throw new Error(`${c.key}: ${v} out of range`);
                }
            }
        }
    }
});
test('the macOS order: welcome first, done last, the asked-for steps in between', () => {
    eq(STEPS.map(s => s.id), ['welcome', 'appearance', 'dock', 'menu-bar', 'windows', 'stage-manager', 'privacy', 'done']);
});
test('offered once, in the user session, never over the overview or another modal', () => {
    const at = fields => offerDecision({ state: 'new', sessionMode: 'user', overviewVisible: false, modalOpen: false, ...fields });
    eq(at({}), 'offer');
    eq(at({ sessionMode: 'initial-setup' }), 'never');
    // GNOME starts in the overview; the welcome dialog is a modal: ask again later
    eq(at({ overviewVisible: true, modalOpen: true }), 'later');
    eq(at({ modalOpen: true }), 'later');
    for (const state of ['requested', 'shown', 'done'])
        eq(at({ state }), 'never', state);
    eq(STATES.map(shouldPresent), [false, true, false, false]);
});
test('Light / Dark / Auto', () => {
    eq(appearanceChoice({ auto: true, colorScheme: 'prefer-light' }), 'auto');
    eq(appearanceChoice({ auto: false, colorScheme: 'prefer-dark' }), 'dark');
    eq(appearanceChoice({ auto: false, colorScheme: 'default' }), 'light');
    eq(appearanceWrites('auto'), [{ schema: 'guava', key: 'appearance-auto', value: true }]);
    // GNOME's key first, so a running Auto takes it as the user's choice before it turns off
    eq(appearanceWrites('dark').map(w => [w.schema, w.key, w.value]),
        [['gnome', 'color-scheme', 'prefer-dark'], ['guava', 'appearance-auto', false]]);
    eq(appearanceWrites('light')[0].value, 'prefer-light');
});

GLib.spawn_command_line_sync(`rm -rf ${dir}`);
if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
