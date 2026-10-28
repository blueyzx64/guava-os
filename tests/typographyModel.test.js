// Run: gjs -m tests/typographyModel.test.js
import {
    MACOS_RENDERING, fontSize, parseFcList, pickFamily, plan, withFamily,
} from '../features/typography/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

test('fc-list output: one family per name, localized names split', () => {
    eq(parseFcList('Adwaita Sans\nInter Variable,Inter Variable Text\n\nDejaVu Sans\nAdwaita Sans\n'),
        ['Adwaita Sans', 'Inter Variable', 'Inter Variable Text', 'DejaVu Sans']);
    eq(parseFcList(''), []);
    eq(parseFcList(null), []);
    eq(parseFcList('Noto Sans CJK\\-JP'), ['Noto Sans CJK-JP']);
});

test('SF Pro wins over Inter; the installed spelling is kept', () => {
    eq(pickFamily(['Inter Variable', 'SF Pro'], ['SF Pro', 'Inter Variable']), 'SF Pro');
    eq(pickFamily(['inter variable'], ['SF Pro', 'Inter Variable']), 'inter variable');
    eq(pickFamily(['Adwaita Sans'], ['SF Pro', 'Inter Variable']), null);
    eq(pickFamily(undefined, ['SF Pro']), null);
});

test('the plan: UI and mono families from what is installed', () => {
    eq(plan(['Adwaita Sans', 'Adwaita Mono']), { ui: null, mono: null });
    eq(plan(['Inter', 'Inter Variable']), { ui: 'Inter Variable', mono: null });
    eq(plan(['SF Pro Text', 'SF Mono', 'Inter']), { ui: 'SF Pro Text', mono: 'SF Mono' });
});

test('the user\'s size is kept, styles in the family dropped', () => {
    eq(fontSize('Adwaita Sans 11'), 11);
    eq(fontSize('Cantarell Bold 10.5'), 10.5);
    eq(fontSize('Inter'), null);
    eq(fontSize('Inter 14px'), null);
    eq(withFamily('Adwaita Sans 11', 'Inter Variable', 11), 'Inter Variable 11');
    eq(withFamily('Cantarell Bold 12.5', 'SF Pro', 11), 'SF Pro 12.5');
    eq(withFamily('', 'SF Mono', 10), 'SF Mono 10');
});

test('macOS rendering: unhinted, grayscale', () => {
    eq(MACOS_RENDERING, { 'font-hinting': 'none', 'font-antialiasing': 'grayscale' });
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
