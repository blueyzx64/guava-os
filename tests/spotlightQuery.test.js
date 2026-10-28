// Run: gjs -m tests/spotlightQuery.test.js
import {
    VIEWS, viewForDigit, toggleView, FILTERS, filterSuggestions, parseQuery, filterText, filterById,
    fileQuery, fileScore, displayFolder, validAlias, parseQuickKeys, serializeQuickKeys, addQuickKey,
    removeQuickKey, quickKeyHit, pushHistory, historyStep, encodeRecent, decodeRecent, pushRecent,
    appsBrowse, moveIn, HISTORY_MAX,
} from '../features/spotlight/queryModel.js';
import { buildEmptySections, buildSections, groupOf } from '../features/spotlight/model.js';

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(a, b) {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(c, msg = 'not true') {
    if (!c)
        throw new Error(msg);
}
const ALL = new Set(['files', 'clipboard', 'menu']);

// --- views
test('four views in Super+1..4 order', () => eq(VIEWS.map(v => v.id), ['apps', 'files', 'actions', 'clipboard']));
test('viewForDigit maps 1..4 and nothing else', () => eq([0, 1, 2, 3, 4, 5].map(viewForDigit), [null, 'apps', 'files', 'actions', 'clipboard', null]));
test('toggleView closes the open view', () => {
    eq(toggleView(null, 'apps'), 'apps');
    eq(toggleView('apps', 'apps'), null);
    eq(toggleView('apps', 'files'), 'files');
});

// --- filters
test('a typed filter applies with or without text', () => {
    const a = parseQuery('/pdf tax 2024', { available: ALL });
    eq([a.filter?.id, a.text], ['pdf', 'tax 2024']);
    const b = parseQuery('/pdf', { available: ALL });
    eq([b.filter?.id, b.text, b.suggest], ['pdf', '', null]);
});
test('aliases: /images, /pictures, /folder', () => {
    eq(parseQuery('/pictures cat', { available: ALL }).filter.id, 'images');
    eq(parseQuery('/folder x', { available: ALL }).filter.id, 'folders');
    eq(parseQuery('/APPS', { available: ALL }).filter.id, 'apps');
});
test('a partial filter suggests', () => {
    const p = parseQuery('/f', { available: ALL });
    eq(p.filter, null);
    eq(p.suggest.map(f => f.id), ['files', 'folders']);
});
test('an unknown filter with text is a plain search', () => {
    const p = parseQuery('/usr/bin', { available: ALL });
    eq([p.filter, p.suggest, p.text], [null, null, '/usr/bin']);
});
test('filters that need a missing capability are hidden', () => {
    eq(parseQuery('/menu quit', { available: new Set() }).filter, null);
    eq(parseQuery('/pdf', { available: new Set() }).filter, null);
    eq(parseQuery('/apps', { available: new Set() }).filter.id, 'apps');
    ok(!filterSuggestions('m', new Set()).some(f => f.id === 'menu'));
    ok(filterSuggestions('m', ALL).some(f => f.id === 'menu'));
});
test('plain text has no filter', () => {
    const p = parseQuery('  firefox  ');
    eq([p.raw, p.text, p.filter, p.suggest], ['firefox', 'firefox', null, null]);
});
test('filterText round-trips through parseQuery', () => {
    const t = filterText(filterById('pdf'), 'tax');
    eq(t, '/pdf tax');
    eq(parseQuery(t, { available: ALL }).text, 'tax');
    eq(filterText(filterById('menu')), '/menu ');
});
test('every filter has a unique id and aliases', () => {
    const ids = FILTERS.map(f => f.id);
    eq(new Set(ids).size, ids.length);
    const aliases = FILTERS.flatMap(f => f.aliases);
    eq(new Set(aliases).size, aliases.length);
});

// --- SPARQL
test('fileQuery binds each word and never pastes it', () => {
    const { sparql, bindings } = fileQuery({ text: 'Tax "x" } DROP', filter: null });
    eq(bindings, { q0: 'tax', q1: '"x"', q2: '}', q3: 'drop' });
    ok(!sparql.includes('DROP') && !sparql.includes('"x"'), 'user text in the query');
    ok(sparql.includes('~q0') && sparql.includes('~q3'));
});
test('fileQuery: mime filters for pdf and images', () => {
    ok(fileQuery({ filter: filterById('pdf') }).sparql.includes('?mime = "application/pdf"'));
    ok(fileQuery({ filter: filterById('images') }).sparql.includes('STRSTARTS(?mime, "image/")'));
    ok(fileQuery({ filter: filterById('folders') }).sparql.includes('"inode/directory"'));
    ok(!fileQuery({ filter: filterById('files') }).sparql.includes('?mime ='));
});
test('fileQuery: empty text lists recent files, limit clamped', () => {
    const { sparql, bindings } = fileQuery({ limit: 5000 });
    eq(bindings, {});
    ok(sparql.includes('ORDER BY DESC(?modified) LIMIT 100'));
    ok(fileQuery({ limit: 0 }).sparql.endsWith('LIMIT 1'));
});
test('fileScore: exact > prefix > contains > newer', () => {
    ok(fileScore('tax', 'tax', 5) > fileScore('tax.pdf', 'tax', 0));
    ok(fileScore('tax.pdf', 'tax', 0) > fileScore('my tax.pdf', 'tax', 0));
    ok(fileScore('a', '', 0) > fileScore('b', '', 3));
});
test('displayFolder is home-relative and decoded', () => {
    eq(displayFolder('file:///home/u/My%20Docs/a.pdf', '/home/u'), '~/My Docs');
    eq(displayFolder('file:///srv/x.txt', '/home/u'), '/srv');
    eq(displayFolder('file:///home/u/a.txt', '/home/u'), '~');
});

// --- quick keys
test('alias rule: 1-12 lowercase letters/digits', () => {
    eq(['sd', 'a', 'abc123def456', 'abc123def4567', 'Sd', 's d', 's-d', ''].map(validAlias),
        [true, true, true, false, false, false, false, false]);
});
test('parseQuickKeys drops invalid, keeps shared aliases', () => {
    const q = parseQuickKeys(['sd=action:show-desktop', 'SD=app:org.gnome.Nautilus.desktop', 'bad', '=x',
        'sd=action:show-desktop', 'x y=action:lock', 'tm=rm -rf', 'tm=action:timer']);
    eq(q, [{ alias: 'sd', target: 'action:show-desktop' }, { alias: 'sd', target: 'app:org.gnome.Nautilus.desktop' },
        { alias: 'tm', target: 'action:timer' }]);
});
test('add / remove / serialize quick keys', () => {
    let s = addQuickKey([], 'sd', 'action:show-desktop');
    s = addQuickKey(s, 'sd', 'action:show-desktop');
    s = addQuickKey(s, 'lk', 'action:lock');
    eq(s, ['sd=action:show-desktop', 'lk=action:lock']);
    eq(removeQuickKey(s, 'sd', 'action:show-desktop'), ['lk=action:lock']);
    eq(serializeQuickKeys([{ alias: 'BAD!', target: 'action:lock' }]), []);
});
test('quickKeyHit: first word, args after it', () => {
    const list = parseQuickKeys(['sd=action:show-desktop', 'tm=action:timer', 'sd=action:lock']);
    eq(quickKeyHit(list, 'sd'), { alias: 'sd', targets: ['action:show-desktop', 'action:lock'], args: '' });
    eq(quickKeyHit(list, 'TM 5 m'), { alias: 'tm', targets: ['action:timer'], args: '5 m' });
    eq(quickKeyHit(list, 'sdx'), null);
    eq(quickKeyHit(list, ''), null);
});

// --- history
test('pushHistory: newest first, no repeats, capped', () => {
    eq(pushHistory(['b', 'a'], 'A'), ['A', 'b']);
    eq(pushHistory(['a'], '  '), ['a']);
    let h = [];
    for (let i = 0; i < 60; i++)
        h = pushHistory(h, `q${i}`);
    eq(h.length, HISTORY_MAX);
    eq(h[0], 'q59');
});
test('historyStep walks like a shell', () => {
    const h = ['new', 'mid', 'old'];
    let s = historyStep(h, -1, -1);
    eq(s, { index: 0, text: 'new' });
    s = historyStep(h, s.index, -1);
    s = historyStep(h, s.index, -1);
    eq(s, { index: 2, text: 'old' });
    eq(historyStep(h, 2, -1), { index: 2, text: 'old' });
    eq(historyStep(h, 0, 1), { index: -1, text: '' });
    eq(historyStep([], -1, -1), { index: -1, text: '' });
});
test('recent results encode, decode and dedupe', () => {
    const file = { id: 'file:file:///a.pdf', kind: 'file', title: 'a.pdf', subtitle: '~', uri: 'file:///a.pdf', mime: 'application/pdf' };
    eq(decodeRecent(encodeRecent(file)), { kind: 'file', id: file.id, title: 'a.pdf', subtitle: '~', uri: 'file:///a.pdf', mime: 'application/pdf' });
    eq(encodeRecent({ id: 'calc', kind: 'calc', title: '4' }), null);
    eq(encodeRecent({ id: 'clip:1', kind: 'clipboard', title: 'secret' }), null, 'clipboard text is never kept');
    eq(decodeRecent('not json'), null);
    eq(decodeRecent(JSON.stringify({ k: 'file', i: 'x', t: 'x', u: 'http://evil' })), null);
    let list = pushRecent([], file);
    list = pushRecent(list, { id: 'app:a', kind: 'app', title: 'A' });
    list = pushRecent(list, file);
    eq(list.map(s => decodeRecent(s).id), [file.id, 'app:a']);
});

// --- apps view and movement
test('appsBrowse: most used first, then A to Z, as grids', () => {
    const apps = [{ id: 'app:b', appId: 'b', title: 'Beta' }, { id: 'app:a', appId: 'a', title: 'alpha' }, { id: 'app:c', appId: 'c', title: 'Gamma' }];
    const s = appsBrowse(apps, ['c', 'zz', 'a'], 6);
    eq(s.map(x => [x.id, x.layout, x.items.map(i => i.appId)]),
        [['suggestions', 'grid', ['c', 'a']], ['all-apps', 'grid', ['a', 'b', 'c']]]);
    ok(s[0].items[0].id !== s[1].items[2].id, 'ids unique across sections');
    eq(appsBrowse([], []), []);
});
test('moveIn: grid keeps the column across rows and sections', () => {
    const grid = n => ({ layout: 'grid', items: Array.from({ length: n }, (_, i) => ({ id: i })) });
    const sections = [grid(3), grid(8)];   // cols 4: rows [0..2], [3..6], [7..10]
    eq(moveIn(sections, 1, 'down', 4), 4);
    eq(moveIn(sections, 4, 'down', 4), 8);
    eq(moveIn(sections, 8, 'up', 4), 4);
    eq(moveIn(sections, 2, 'down', 4), 5);
    eq(moveIn(sections, 6, 'down', 4), 10, 'clamped to the shorter row');
    eq(moveIn(sections, 4, 'right', 4), 5);
    eq(moveIn(sections, 6, 'right', 4), 6, 'stops at the row end');
    eq(moveIn(sections, 3, 'left', 4), 3);
    eq(moveIn(sections, 0, 'up', 4), 7, 'wraps to the last row');
});
test('moveIn: lists step and wrap; left/right do nothing', () => {
    const list = { items: [{}, {}, {}] };
    eq(moveIn([list], 2, 'down', 6), 0);
    eq(moveIn([list], 0, 'up', 6), 2);
    eq(moveIn([list], 1, 'left', 6), 1);
    eq(moveIn([list], -1, 'down', 6), 0);
    eq(moveIn([list], -1, 'up', 6), 2);
    eq(moveIn([], 0, 'down', 6), -1);
});

// --- grouping of the new kinds
test('actions and menu items get their own sections', () => {
    eq(['command', 'app-action', 'menu', 'action', 'setting'].map(kind => groupOf({ kind })),
        ['actions', 'actions', 'menu', 'settings', 'settings']);
    const s = buildSections({
        apps: [{ id: 'a', score: 500 }],
        actions: [{ id: 'q', score: 2000 }, { id: 'r', score: 300 }],
        menu: [{ id: 'm', score: 400 }],
    });
    eq(s.map(x => [x.id, x.items.map(i => i.id)]), [['top', ['q']], ['apps', ['a']], ['actions', ['r']], ['menu', ['m']]]);
});
test('empty sections: recents, history, then suggestions without repeats', () => {
    const s = buildEmptySections([{ id: 'app:a' }, { id: 'app:b' }], [], {
        recent: [{ id: 'app:a' }], history: [{ id: 'history:x' }],
    });
    eq(s.map(x => [x.id, x.items.map(i => i.id)]), [['recent', ['app:a']], ['history', ['history:x']], ['suggestions', ['app:b']]]);
    eq(buildEmptySections([], []), []);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
