// Run: gjs -m tests/emojiModel.test.js
// features/emoji/model.js: catalogue, search, tones, recents, grid moves.
import GLib from 'gi://GLib';
import {
    CATEGORIES, COLUMNS, RECENTS_MAX, buildCatalog, categoryCells, dictLanguages, firstCategory,
    moveInGrid, nextCategory, pushRecent, recentCells, search, withTone,
} from '../features/emoji/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const R = (emoji, description, category, annotations = []) => ({ emoji, description, category, annotations });
const TONES = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'];
const records = [
    R('😀', 'grinning face', 'Smileys & Emotion', ['face', 'grin', 'smile']),
    R('😂', 'face with tears of joy', 'Smileys & Emotion', ['laugh', 'tears']),
    R('👋', 'waving hand', 'People & Body', ['wave', 'hello']),
    ...TONES.map((t, i) => R(`👋${i}`, `waving hand: ${t} skin tone`, 'People & Body')),
    R('🧑‍🤝‍🧑x', 'people holding hands: light skin tone, dark skin tone', 'People & Body'),
    R('👍', 'thumbs up', 'People & Body', ['good', 'yes']),
    R('👍0', 'thumbs up: light skin tone', 'People & Body'),
    R('🏻', 'light skin tone', 'Component'),
    R('🐶', 'dog face', 'Animals & Nature', ['dog', 'pet']),
    R('🍕', 'pizza', 'Food & Drink', ['cheese', 'slice']),
    R('🇩🇪', 'flag: Germany', 'Flags', ['flag']),
    R('😀', 'grinning face', 'Smileys & Emotion'),          // duplicate
];
const cat = buildCatalog(records);

test('languages: locale, language, then English; C and encodings dropped', () => {
    eq(dictLanguages(['de_DE.UTF-8', 'de_DE', 'de', 'C']), ['de_DE', 'de', 'en']);
    eq(dictLanguages(['C']), ['en']);
    eq(dictLanguages(['en_US.UTF-8', 'en_US', 'en']), ['en_US', 'en']);
});
test('catalogue: components and duplicates left out, groups merged into macOS tabs', () => {
    eq(cat.items.map(i => i.char), ['😀', '😂', '👋', '👍', '🐶', '🍕', '🇩🇪']);
    eq(cat.byCategory.get('smileys').map(i => i.char), ['😀', '😂', '👋', '👍']);
    eq(cat.byCategory.get('flags').map(i => i.char), ['🇩🇪']);
    eq(CATEGORIES[0].id, 'recent');
});
test('tones: five variants fold into the base; a partial set is not offered', () => {
    const wave = cat.byChar.get('👋');
    eq(wave.tones, ['👋0', '👋1', '👋2', '👋3', '👋4']);
    eq(cat.byChar.get('👋3'), wave);
    eq(cat.byChar.get('👍').tones, null);
    eq([withTone(wave, 0), withTone(wave, 3), withTone(cat.byChar.get('👍'), 3)], ['👋', '👋2', '👍']);
});
test('search: whole words first, prefixes, keywords; every word must match', () => {
    eq(search(cat, 'face').map(i => i.char), ['😀', '😂', '🐶']);
    eq(search(cat, 'dog').map(i => i.char), ['🐶']);
    eq(search(cat, 'chee')[0]?.char, '🍕');         // keyword prefix
    eq(search(cat, 'grinning face')[0].char, '😀');
    eq(search(cat, 'face pizza'), []);
    eq(search(cat, '   '), []);
    eq(search(cat, 'germ').map(i => i.char), ['🇩🇪']);
});
test('recents: newest first, unique, capped', () => {
    eq(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    eq(pushRecent([], '😀'), ['😀']);
    eq(pushRecent(Array.from({ length: 40 }, (_, i) => `${i}`), 'x').length, RECENTS_MAX);
    eq(recentCells(cat, ['👋2', 'zz', '😀']).map(c => [c.char, c.item.char]), [['👋2', '👋'], ['😀', '😀']]);
});
test('tabs: recents open first when there are any; tones apply to the tab cells', () => {
    eq(firstCategory(cat, []), 'smileys');
    eq(firstCategory(cat, ['😀']), 'recent');
    eq(categoryCells(cat, 'smileys', 2, []).map(c => c.char), ['😀', '😂', '👋1', '👍']);
    eq(categoryCells(cat, 'recent', 2, ['🍕']).map(c => c.char), ['🍕']);
    eq([nextCategory('recent', -1), nextCategory('flags', 1), nextCategory('smileys', 1)], ['flags', 'recent', 'nature']);
});
test('grid: arrows move by one and by a row, clamp at the ends', () => {
    eq(moveInGrid(-1, 'down', 20), 0);
    eq(moveInGrid(0, 'right', 20), 1);
    eq(moveInGrid(0, 'down', 20), COLUMNS);
    eq(moveInGrid(COLUMNS * 2, 'down', 20), COLUMNS * 2);
    eq(moveInGrid(15, 'down', 20), 15);
    eq(moveInGrid(3, 'up', 20), 3);
    eq(moveInGrid(0, 'left', 20), 0);
    eq(moveInGrid(5, 'end', 20), 19);
    eq(moveInGrid(5, 'up', 0), -1);
});

// The real IBus dictionary, when this machine has one (format of features/emoji/data.js)
const DICTS = ['/usr/share/ibus/dicts/emoji-en.dict', '/tmp/x2/arch/usr/share/ibus/dicts/emoji-en.dict'];
const dict = DICTS.find(p => GLib.file_test(p, GLib.FileTest.EXISTS));
if (dict) {
    test(`real dictionary (${dict}): every tab has emoji, tones fold, search finds`, () => {
        const [, bytes] = GLib.file_get_contents(dict);
        const v = GLib.Variant.new_from_bytes(new GLib.VariantType('(sqv)'), new GLib.Bytes(bytes), false);
        const list = v.get_child_value(2).get_variant();
        const recs = [];
        for (let i = 0; i < list.n_children(); i++) {
            const a = list.get_child_value(i).get_variant().deepUnpack();
            const n = a[3];
            recs.push({ emoji: a[2], annotations: a.slice(4, 4 + n), description: a[4 + n], category: a[5 + n] });
        }
        const c = buildCatalog(recs);
        for (const tab of CATEGORIES.slice(1))
            if (!c.byCategory.get(tab.id).length)
                throw new Error(`empty tab ${tab.id}`);
        eq(c.byChar.get('👋').tones.length, 5);
        eq(withTone(c.byChar.get('👋'), 5), '👋🏿');
        eq(search(c, 'grinning face')[0].char, '😀');
        eq(search(c, 'pizza')[0].char, '🍕');
        if (c.items.length < 1500)
            throw new Error(`only ${c.items.length} emoji`);
    });
}

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
