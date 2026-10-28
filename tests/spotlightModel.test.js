// Run: gjs -m tests/spotlightModel.test.js
import {
    normalize, scoreToken, scoreFields, scoreItem, rank, groupOf, buildSections,
    buildEmptySections, flatten, moveSelection, jumpGroup, locate, reselect, webSearchUrl,
    looksLikeUrl, SearchSession, TOP_HIT_MIN_SCORE, SuperTapTracker, SUPER_TAP_MAX_MS,
} from '../features/spotlight/model.js';

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

// --- normalize / scoreToken
test('normalize strips accents and case', () => eq(normalize('  Café  Écran '), 'cafe ecran'));
test('exact > prefix > word > substring > subsequence', () => {
    const s = [
        scoreToken('fire', 'fire'), scoreToken('fire', 'firefox'),
        scoreToken('fox', 'red fox'), scoreToken('ire', 'firefox'), scoreToken('ffx', 'firefox'),
    ];
    for (let i = 1; i < s.length; i++)
        ok(s[i - 1] > s[i] && s[i] > 0, `order broke at ${i}: ${s}`);
});
test('no match', () => eq(scoreToken('zzz', 'firefox'), -1));
test('two letters never fuzzy match', () => eq(scoreToken('fx', 'firefox'), -1));
test('shorter prefix match wins', () => ok(scoreToken('fire', 'firefox') > scoreToken('fire', 'firefox developer')));
test('empty token matches', () => eq(scoreToken('', 'x'), 0));
test('regex chars in query are literal', () => eq(scoreToken('a.c', 'abc'), -1));
test('separator word start', () => ok(scoreToken('shell', 'gnome-shell') > scoreToken('hell', 'gnome-shell')));

// --- scoreFields / scoreItem
test('every token must match', () => eq(scoreFields('fire zzz', ['Firefox']), -1));
test('tokens across fields', () => ok(scoreFields('web browser', ['Firefox', 'Web Browser']) > 0));
test('title beats keyword', () =>
    ok(scoreFields('mail', ['Mail', 'letters']) > scoreFields('mail', ['Letters', 'mail'])));
test('accent-insensitive', () => ok(scoreFields('cafe', ['Café']) > 0));
test('boost added after match, never rescues no match', () => {
    eq(scoreItem('zzz', { title: 'Firefox', boost: 500 }), -1);
    ok(scoreItem('fire', { title: 'Firefox', boost: 50 }) > scoreItem('fire', { title: 'Firefox' }));
});
test('keywords match', () => ok(scoreItem('browser', { title: 'Firefox', keywords: ['Browser'] }) > 0));

// --- rank
test('rank sorts and drops non matches', () => {
    const items = [
        { id: 1, title: 'Terminal' }, { id: 2, title: 'Files' },
        { id: 3, title: 'Settings' }, { id: 4, title: 'Text Editor' },
    ];
    eq(rank(items, 'te').map(i => i.id), [1, 4]);
});
test('rank is stable on ties', () => {
    const items = [{ id: 1, title: 'Alpha' }, { id: 2, title: 'Alpha' }, { id: 3, title: 'Alpha' }];
    eq(rank(items, 'alpha').map(i => i.id), [1, 2, 3]);
});
test('rank respects limit and does not mutate input', () => {
    const items = [{ id: 1, title: 'ab1' }, { id: 2, title: 'ab2' }, { id: 3, title: 'ab3' }];
    const out = rank(items, 'ab', 2);
    eq(out.length, 2);
    ok(!('score' in items[0]));
});
test('usage boost reorders equal matches', () => {
    const items = [{ id: 1, title: 'Notes' }, { id: 2, title: 'Notes', boost: 30 }];
    eq(rank(items, 'notes').map(i => i.id), [2, 1]);
});
test('typo-free exact title tops long fuzzy', () => {
    const items = [{ id: 'a', title: 'Visual Studio Code' }, { id: 'b', title: 'Code' }];
    eq(rank(items, 'code')[0].id, 'b');
});

// --- groups / sections
test('groupOf by kind and explicit group', () => {
    eq(groupOf({ kind: 'app' }), 'apps');
    eq(groupOf({ kind: 'setting' }), 'settings');
    eq(groupOf({ kind: 'file' }), 'documents');
    eq(groupOf({ kind: 'external' }), 'documents');
    eq(groupOf({ kind: 'calc' }), 'calculator');
    eq(groupOf({ kind: 'external', group: 'clipboard' }), 'clipboard');
    eq(groupOf({ kind: 'x', group: 'bogus' }), 'documents');
});
const it = (id, score, kind = 'app') => ({ id, title: id, score, kind });
test('top hit is the best first item and leaves its group', () => {
    const s = buildSections({ apps: [it('a1', 800), it('a2', 700)], settings: [it('s1', 900, 'setting')] });
    eq(s.map(x => x.id), ['top', 'apps']);
    eq(s[0].items[0].id, 's1');
});
test('top hit removed from its group', () => {
    const s = buildSections({ apps: [it('a1', 800), it('a2', 700)] });
    eq(s.map(x => x.id), ['top', 'apps']);
    eq(s[1].items.map(i => i.id), ['a2']);
});
test('weak match is no top hit', () => {
    const s = buildSections({ apps: [it('a1', TOP_HIT_MIN_SCORE - 1)] });
    eq(s.map(x => x.id), ['apps']);
});
test('calculator result is the top hit', () => {
    const s = buildSections({ apps: [it('a1', 1000)], calculator: [{ id: 'c', kind: 'calc', title: '4', score: 1 }] });
    eq(s[0].items[0].id, 'c');
    eq(s.map(x => x.id), ['top', 'apps']);
});
test('web row is never the top hit', () => {
    const s = buildSections({ web: [it('w', 5000, 'web')] });
    eq(s.map(x => x.id), ['web']);
});
test('group order is fixed and limits apply', () => {
    const many = n => Array.from({ length: n }, (_, i) => it(`x${i}`, 100));
    const s = buildSections({ web: [it('w', 0, 'web')], documents: many(9), apps: many(9) }, { topMin: 9999 });
    eq(s.map(x => x.id), ['apps', 'documents', 'web']);
    eq(s[0].items.length, 6);
    eq(s[1].items.length, 5);
});
test('empty input', () => eq(buildSections({}), []));
test('empty query state', () => {
    eq(buildEmptySections([it('a', 0)], []).map(s => s.id), ['suggestions']);
    eq(buildEmptySections([it('a', 0)], [it('c', 0, 'clipboard')]).map(s => s.id), ['suggestions', 'clipboard']);
    eq(buildEmptySections([], []), []);
});

// --- selection
const secs = [
    { id: 'top', items: [it('t', 1)] },
    { id: 'apps', items: [it('a1', 1), it('a2', 1)] },
    { id: 'web', items: [it('w', 1)] },
];
test('flatten', () => eq(flatten(secs).map(i => i.id), ['t', 'a1', 'a2', 'w']));
test('move wraps', () => {
    eq(moveSelection(secs, 3, 1), 0);
    eq(moveSelection(secs, 0, -1), 3);
    eq(moveSelection(secs, 1, 1), 2);
});
test('move from nothing', () => {
    eq(moveSelection(secs, -1, 1), 0);
    eq(moveSelection(secs, -1, -1), 3);
    eq(moveSelection([], 0, 1), -1);
});
test('Tab jumps to next group start and wraps', () => {
    eq(jumpGroup(secs, 0), 1);
    eq(jumpGroup(secs, 2), 3);
    eq(jumpGroup(secs, 3), 0);
});
test('Shift+Tab goes back', () => {
    eq(jumpGroup(secs, 1, true), 0);
    eq(jumpGroup(secs, 0, true), 3);
});
test('locate', () => {
    eq(locate(secs, 2).section, 'apps');
    eq(locate(secs, 2).item.id, 'a2');
    eq(locate(secs, 9), null);
    eq(locate(secs, -1), null);
});
test('reselect keeps the item when the user moved', () => {
    const after = [{ id: 'apps', items: [it('x', 1), it('a2', 1)] }];
    eq(reselect(secs, 2, after, true), 1);
});
test('reselect resets to first when the user did not move', () => {
    const after = [{ id: 'apps', items: [it('x', 1), it('a2', 1)] }];
    eq(reselect(secs, 2, after, false), 0);
});
test('reselect clamps when the item vanished', () => {
    eq(reselect(secs, 3, [{ id: 'apps', items: [it('x', 1)] }], true), 0);
    eq(reselect(secs, 3, [], true), -1);
});

// --- web
test('web url encodes the query', () =>
    eq(webSearchUrl('duckduckgo', 'a b&c=d#e'), 'https://duckduckgo.com/?q=a%20b%26c%3Dd%23e'));
test('unknown engine falls back', () => ok(webSearchUrl('nope', 'x').startsWith('https://duckduckgo.com/')));
test('custom https template', () => eq(webSearchUrl('https://example.org/s?q=%s', 'hi'), 'https://example.org/s?q=hi'));
test('custom template must be https', () => ok(webSearchUrl('javascript:alert(%s)', 'x').startsWith('https://duckduckgo')));
test('custom http template refused', () => ok(webSearchUrl('http://example.org/%s', 'x').startsWith('https://duckduckgo')));
test('template without %s refused', () => ok(webSearchUrl('https://example.org/', 'x').startsWith('https://duckduckgo')));
test('query with $& is literal', () => eq(webSearchUrl('google', '$&'), 'https://www.google.com/search?q=%24%26'));
test('empty query gives null', () => eq(webSearchUrl('google', '  '), null));
test('looksLikeUrl', () => {
    ok(looksLikeUrl('gnome.org'));
    ok(looksLikeUrl('https://gnome.org/a?b=1'));
    ok(!looksLikeUrl('hello world'));
    ok(!looksLikeUrl('file.txt x'));
    ok(looksLikeUrl('www.example.xyzzy'));
    ok(looksLikeUrl('example.org/path?q=1'));
    ok(looksLikeUrl('http://localhost.lan'));
    for (const name of ['main.py', 'notes.md', 'report.pdf', 'archive.tar.gz', 'a.js', 'v1.2', 'config.json'])
        ok(!looksLikeUrl(name), name);
});

// --- SuperTapTracker
test('bare quick tap', () => {
    const t = new SuperTapTracker();
    t.press(1000);
    eq(t.release(1100), true);
});
test('another key in between is not a tap', () => {
    const t = new SuperTapTracker();
    t.press(1000);
    t.other();
    eq(t.release(1050), false);
});
test('a long hold is not a tap', () => {
    const t = new SuperTapTracker();
    t.press(1000);
    eq(t.release(1000 + SUPER_TAP_MAX_MS + 1), false);
});
test('release without press is not a tap', () => eq(new SuperTapTracker().release(5), false));
test('other() before press does not taint the next tap', () => {
    const t = new SuperTapTracker();
    t.other();
    t.press(10);
    eq(t.release(20), true);
});
test('state resets after release', () => {
    const t = new SuperTapTracker();
    t.press(10);
    t.other();
    t.release(20);
    t.press(30);
    eq(t.release(40), true);
});
test('clock going backwards is not a tap', () => {
    const t = new SuperTapTracker();
    t.press(100);
    eq(t.release(50), false);
});

// --- SearchSession
function env() {
    const timers = [];
    return {
        timers,
        schedule: (ms, fn) => {
            const t = { ms, fn, live: true };
            timers.push(t);
            return () => { t.live = false; };
        },
        fire(i) {
            if (timers[i].live)
                timers[i].fn();
        },
        makeCancellable() {
            return { c: false, cancel() { this.c = true; }, is_cancelled() { return this.c; } };
        },
    };
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
const tick = () => Promise.resolve();

async function atest(name, fn) {
    try {
        await fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}

await atest('session streams results as providers answer', async () => {
    const e = env();
    const a = deferred(), b = deferred();
    const updates = [];
    const s = new SearchSession({
        providers: [{ id: 'a', search: () => a.promise }, { id: 'b', search: () => b.promise }],
        schedule: e.schedule, makeCancellable: e.makeCancellable, onUpdate: x => updates.push([...x.pending]),
    });
    s.start('q');
    eq(s.busy, true);
    b.resolve([{ id: 'b1', title: 'b1', kind: 'app' }]);
    await tick();
    eq(updates, [['a']]);
    a.resolve([]);
    await tick();
    eq(updates, [['a'], []]);
    eq(s.busy, false);
    eq(s.results.get('b').length, 1);
});

await atest('stale answers from an older search are dropped', async () => {
    const e = env();
    const first = deferred();
    let n = 0;
    const seen = [];
    const s = new SearchSession({
        providers: [{ id: 'a', search: () => (n++ === 0 ? first.promise : Promise.resolve([{ id: 'new', title: 'new', kind: 'app' }])) }],
        schedule: e.schedule, makeCancellable: e.makeCancellable, onUpdate: x => seen.push([...x.results.get('a')].map(i => i.id)),
    });
    s.start('one');
    s.start('two');
    await tick();
    first.resolve([{ id: 'old', title: 'old', kind: 'app' }]);
    await tick();
    eq(seen, [['new']]);
});

await atest('start cancels the previous cancellable', async () => {
    const e = env();
    const made = [];
    const s = new SearchSession({
        providers: [{ id: 'a', search: () => new Promise(() => {}) }],
        schedule: e.schedule,
        makeCancellable: () => { const c = e.makeCancellable(); made.push(c); return c; },
        onUpdate: () => {},
    });
    s.start('a');
    s.start('ab');
    eq(made[0].c, true);
    eq(made[1].c, false);
    s.cancel();
    eq(made[1].c, true);
});

await atest('a provider that hangs times out alone', async () => {
    const e = env();
    const errors = [];
    const s = new SearchSession({
        providers: [
            { id: 'slow', timeoutMs: 700, search: () => new Promise(() => {}) },
            { id: 'fast', search: () => Promise.resolve([{ id: 'f', title: 'f', kind: 'app' }]) },
        ],
        schedule: e.schedule, makeCancellable: e.makeCancellable, onUpdate: () => {},
        onError: (id, err) => errors.push([id, err.message]),
    });
    s.start('q');
    await tick();
    eq(s.pending.has('slow'), true);
    eq(e.timers[0].ms, 700);
    e.fire(0);
    eq(s.pending.size, 0);
    eq(errors, [['slow', 'timeout']]);
    eq(s.results.get('fast').length, 1);
    eq(s.results.get('slow'), []);
});

await atest('a rejecting or throwing provider does not break others', async () => {
    const e = env();
    const errors = [];
    const s = new SearchSession({
        providers: [
            { id: 'bad', search: () => Promise.reject(new Error('boom')) },
            { id: 'throws', search: () => { throw new Error('sync'); } },
            { id: 'ok', search: () => Promise.resolve([{ id: 'o', title: 'o', kind: 'app' }]) },
        ],
        schedule: e.schedule, makeCancellable: e.makeCancellable, onUpdate: () => {},
        onError: (id, err) => errors.push(id + ':' + err.message),
    });
    s.start('q');
    await tick(); await tick();
    eq(s.busy, false);
    eq(errors.sort(), ['bad:boom', 'throws:sync']);
});

await atest('timer firing after a newer search is ignored', async () => {
    const e = env();
    let calls = 0;
    const s = new SearchSession({
        providers: [{ id: 'a', search: () => new Promise(() => {}) }],
        schedule: e.schedule, makeCancellable: e.makeCancellable, onUpdate: () => calls++,
    });
    s.start('1');
    const stale = e.timers[0];
    s.start('2');
    stale.fn();
    eq(calls, 0);
});

await atest('byGroup ranks unscored items and keeps scored order', async () => {
    const e = env();
    const s = new SearchSession({
        providers: [
            { id: 'p', search: () => Promise.resolve([{ id: '1', title: 'Zed', kind: 'file' }, { id: '2', title: 'Alpha', kind: 'file' }]) },
            { id: 'x', search: () => Promise.resolve([{ id: 'k', title: 'unrelated', kind: 'external', score: 500 }, { id: 'j', title: 'other', kind: 'external', score: 600 }]) },
        ],
        schedule: e.schedule, makeCancellable: e.makeCancellable, onUpdate: () => {},
    });
    s.start('alp');
    await tick(); await tick();
    const g = s.byGroup('alp');
    // scored external items keep their score; unscored ones are matched on the query
    eq(g.documents.map(i => i.id), ['2', 'j', 'k']);
});

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
print('model: all passed');
