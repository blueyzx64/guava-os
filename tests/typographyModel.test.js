// Run: gjs -m tests/typographyModel.test.js
import GLib from 'gi://GLib';
import {
    FREETYPE_SMOOTHING, MACOS_RENDERING, SMOOTHING_MARKER, fontSize, parseFcList, pickFamily, plan,
    renderingValues, smoothingAction, smoothingText, withFamily,
    LUCIDGLYPH_ENV, LUCIDGLYPH_RULES, RULE_MARKER, ownsRendering, ruleAction, styleOf,
} from '../src/features/typography/model.js';

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

test('macOS rendering: manual (GTK4 follows the keys), unhinted, grayscale', () => {
    eq(MACOS_RENDERING, { 'font-rendering': 'manual', 'font-hinting': 'none', 'font-antialiasing': 'grayscale' });
});

test('smoothing needs light hinting to darken TrueType stems', () => {
    eq(renderingValues(false), MACOS_RENDERING);
    eq(renderingValues(true), { 'font-rendering': 'manual', 'font-hinting': 'slight', 'font-antialiasing': 'grayscale' });
});

test('smoothing file: marked, one FREETYPE_PROPERTIES line', () => {
    const t = smoothingText();
    eq(t.startsWith(SMOOTHING_MARKER + '\n'), true);
    eq(t.split('\n').filter(l => l.startsWith('FREETYPE_PROPERTIES=')), [`FREETYPE_PROPERTIES=${FREETYPE_SMOOTHING}`]);
    eq(t.endsWith('\n'), true);
});

test('smoothing file: written when on, removed when off, a foreign file untouched', () => {
    eq(smoothingAction(null, true), 'write');
    eq(smoothingAction(smoothingText(), true), 'none');
    eq(smoothingAction(smoothingText().replace('500', '600'), true), 'write');
    eq(smoothingAction(smoothingText(), false), 'remove');
    eq(smoothingAction(null, false), 'none');
    eq(smoothingAction('FREETYPE_PROPERTIES=x\n', true), 'none');
    eq(smoothingAction('FREETYPE_PROPERTIES=x\n', false), 'none');
    eq(smoothingAction('', false), 'none');
});

test('lucidglyph style: its environment, slight hinting, grayscale', () => {
    eq(styleOf('lucidglyph'), 'lucidglyph');
    eq(styleOf('nonsense'), 'macos');
    eq(renderingValues(false, 'lucidglyph'), { 'font-rendering': 'manual', 'font-hinting': 'slight', 'font-antialiasing': 'grayscale' });
    eq(ownsRendering(false, 'lucidglyph'), true, 'the style owns the keys even with macOS Text Rendering off');
    eq(ownsRendering(false, 'macos'), false);
    const t = smoothingText('lucidglyph');
    eq(t.includes(`FREETYPE_PROPERTIES=${LUCIDGLYPH_ENV.FREETYPE_PROPERTIES}`), true);
    eq(t.includes('QT_NO_SYNTHESIZED_BOLD=1'), true);
    eq(smoothingAction(null, false, 'lucidglyph'), 'write', 'wanted without Font Smoothing');
    eq(smoothingAction(smoothingText(), true, 'lucidglyph'), 'write', 'the macOS file becomes the lucidglyph one');
    eq(smoothingAction(t, false, 'macos'), 'remove', 'back to macOS without smoothing: gone');
    eq(smoothingAction(t, true, 'macos'), 'write', 'back to macOS with smoothing: rewritten');
});

test('lucidglyph rules: written for the style, removed after, the user\'s never touched', () => {
    const shipped = `<?xml version="1.0"?>\n${RULE_MARKER} ... -->\n<fontconfig/>\n`;
    eq(ruleAction(null, shipped, 'lucidglyph'), 'write');
    eq(ruleAction(shipped, shipped, 'lucidglyph'), 'none');
    eq(ruleAction(shipped.replace('<fontconfig/>', '<fontconfig></fontconfig>'), shipped, 'lucidglyph'), 'write', 'an update');
    eq(ruleAction(shipped, shipped, 'macos'), 'remove');
    eq(ruleAction('<fontconfig/>', shipped, 'lucidglyph'), 'none', 'a file the user put there');
    eq(ruleAction('<fontconfig/>', shipped, 'macos'), 'none');
    eq(LUCIDGLYPH_RULES.length, 6);
});

test('the shipped lucidglyph rules are the listed ones, each with Guava\'s marker', () => {
    const dir = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', 'src', 'features', 'typography', 'lucidglyph']);
    const d = GLib.Dir.open(dir, 0);
    const names = [];
    for (let n = d.read_name(); n !== null; n = d.read_name())
        names.push(n);
    eq(names.sort(), [...LUCIDGLYPH_RULES].sort());
    for (const n of names) {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, n]));
        eq(new TextDecoder().decode(bytes).includes(RULE_MARKER), true, n);
    }
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
