// Run: gjs -m tests/stageManagerModel.test.js
// Scenario tests of the Stage Manager state machine (features/stageManager/model.js).
import { GRACE_MS, QUIET_MS, StageMachine, exemptReason } from '../features/stageManager/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}\n${e.stack}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// A small desktop: windows by name, a clock, and the effects of the last event
function desk(config = {}) {
    const sm = new StageMachine(config);
    const t = { sm, now: 1000, fx: [], timers: new Map(), ids: new Map(), n: 0 };
    t.win = (name, fields = {}) => {
        const id = ++t.n;
        t.ids.set(name, id);
        return { id, appId: fields.app ?? `${name.replace(/\d+$/, '')}.desktop`, type: 'normal', parent: null,
            workspace: 0, monitor: 0, fullscreen: false, above: false, skipTaskbar: false, title: name,
            minimized: false, ...fields };
    };
    t.id = name => t.ids.get(name);
    t.send = ev => {
        t.fx = sm.dispatch({ now: t.now, ...ev });
        for (const f of t.fx) {
            if (f.type === 'timer')
                t.timers.set(f.key, t.now + f.ms);
            if (f.type === 'cancel')
                t.timers.delete(f.key);
        }
        const bad = sm.checkInvariants();
        if (bad.length)
            throw new Error(`invariants after ${ev.type}: ${bad.join('; ')}`);
        return t.fx;
    };
    t.open = (name, fields) => t.send({ type: 'add', window: t.win(name, fields) });
    t.close = name => t.send({ type: 'remove', id: t.id(name) });
    t.focus = name => t.send({ type: 'focus', id: t.id(name) });
    t.later = ms => {
        t.now += ms;
        for (const [key, at] of [...t.timers]) {
            if (at <= t.now) {
                t.timers.delete(key);
                t.send({ type: 'timer', key });
            }
        }
    };
    const names = ids => ids.map(id => [...t.ids].find(([, v]) => v === id)?.[0] ?? id);
    t.stage = (ws = 0) => names(sm.stageWindows(ws));
    t.strip = (ws = 0) => sm.strip(ws).map(e => names(sm.entry(e).windows).join('+'));
    t.hidden = () => names(sm.hidden()).sort();
    t.entryOf = name => sm.entryOf(t.id(name));
    t.fxOf = type => t.fx.filter(f => f.type === type);
    t.focusFx = () => {
        const f = t.fxOf('focus')[0];
        return f ? names([f.id])[0] ?? null : undefined;
    };
    return t;
}

test('opening an app replaces the stage; the old stage goes to the strip as one entry', () => {
    const t = desk();
    t.open('editor');
    eq(t.stage(), ['editor']);
    t.later(QUIET_MS);
    t.open('files');
    eq(t.stage(), ['files']);
    eq(t.strip(), ['editor']);
    eq(t.hidden(), ['editor']);
    eq(t.fxOf('hide')[0].ids, [t.id('editor')]);
    eq(t.focusFx(), 'files');
});

test('All at Once: a second window of the stage app joins it; of a strip app, brings the app back', () => {
    const t = desk();
    t.open('editor1', { app: 'ed' });
    t.open('files');
    t.later(QUIET_MS);
    t.open('editor2', { app: 'ed' });
    eq(t.stage(), ['editor2', 'editor1']);
    eq(t.strip(), ['files']);
    t.open('files2', { app: 'files.desktop' });
    eq(t.stage(), ['files2', 'files']);
});

test('One at a Time: every window is its own entry', () => {
    const t = desk({ allAtOnce: false });
    t.open('a1', { app: 'a' });
    t.open('a2', { app: 'a' });
    eq(t.stage(), ['a2']);
    eq(t.strip(), ['a1']);
});

test('new windows "join": a new app joins the set on the stage', () => {
    const t = desk({ newWindows: 'join' });
    t.open('editor');
    t.open('files');
    eq(t.stage(), ['files', 'editor']);
    eq(t.sm.entry(t.entryOf('files')).set, true);
});

test('a strip click swaps in place: the old stage takes the slot of the clicked entry', () => {
    const t = desk();
    for (const n of ['a', 'b', 'c', 'd'])
        t.open(n);
    eq(t.strip(), ['c', 'b', 'a']);
    t.later(QUIET_MS);
    t.send({ type: 'activate', entry: t.entryOf('b') });
    eq(t.stage(), ['b']);
    eq(t.strip(), ['c', 'd', 'a']);
    eq(t.hidden(), ['a', 'c', 'd']);
    const show = t.fxOf('show')[0];
    eq(show.ids, [t.id('b')]);
    eq(t.focusFx(), 'b');
});

test('Shift-click (or a drop on the stage) adds the entry to the set; it comes back whole', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.open('calc');
    t.send({ type: 'activate', entry: t.entryOf('files'), add: true });
    eq(t.stage(), ['files', 'calc']);
    eq(t.sm.entry(t.entryOf('calc')).set, true);
    eq(t.strip(), ['editor']);
    t.later(QUIET_MS);
    t.open('music');
    eq(t.strip(), ['files+calc', 'editor']);
    eq(t.hidden(), ['calc', 'editor', 'files']);
    t.send({ type: 'activate', entry: t.entryOf('calc') });
    eq(t.stage(), ['files', 'calc']);
    eq(t.fxOf('show')[0].ids.length, 2);
    eq(t.fxOf('show')[0].ids.at(-1), t.id('files'), 'lead shown last (on top)');
});

test('remove from set: the window gets its own strip entry; a set of one is no set', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.send({ type: 'activate', entry: t.entryOf('editor'), add: true });
    t.send({ type: 'remove-from-set', id: t.id('files') });
    eq(t.stage(), ['editor']);
    eq(t.strip(), ['files']);
    eq(t.sm.entry(t.entryOf('editor')).set, false);
    eq(t.focusFx(), 'editor');
    t.send({ type: 'remove-from-set', id: t.id('editor') });
    eq(t.stage(), ['editor'], 'a lone window stays');
});

test('drag a stage window onto a strip entry: it joins that set', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.open('calc');
    t.send({ type: 'activate', entry: t.entryOf('files'), add: true });
    t.send({ type: 'move-to-entry', id: t.id('calc'), entry: t.entryOf('editor') });
    eq(t.stage(), ['files']);
    eq(t.strip(), ['editor+calc']);
    eq(t.hidden(), ['calc', 'editor']);
});

test('minimize: alone, the entry goes to the strip and the stage stays empty; in a set, it splits', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.later(QUIET_MS);
    t.send({ type: 'minimize', id: t.id('files') });
    eq(t.stage(), []);
    eq(t.strip(), ['files', 'editor']);
    eq(t.focusFx(), null);
    t.later(GRACE_MS * 2);
    eq(t.stage(), [], 'no grace promotion after a minimize');
    t.send({ type: 'activate', entry: t.entryOf('files') });
    t.send({ type: 'activate', entry: t.entryOf('editor'), add: true });
    t.later(QUIET_MS);
    t.send({ type: 'change', window: { id: t.id('editor'), minimized: true } });
    eq(t.fxOf('unminimize').map(f => f.id), [t.id('editor')]);
    eq(t.stage(), ['files']);
    eq(t.strip(), ['editor']);
});

test('Mutter default focus right after a minimize does not switch the stage', () => {
    const t = desk();
    t.open('editor');
    t.later(QUIET_MS);
    t.open('files');
    t.later(QUIET_MS);
    t.send({ type: 'change', window: { id: t.id('files'), minimized: true } });
    t.focus('editor');
    eq(t.stage(), []);
    eq(t.focusFx(), null);
});

test('focus from outside (Alt-Tab, the dock) brings the window\'s whole set; popbacks are damped', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.send({ type: 'activate', entry: t.entryOf('editor'), add: true });
    t.later(QUIET_MS);
    t.open('calc');
    t.later(QUIET_MS);
    t.focus('editor');
    eq(t.stage(), ['editor', 'files']);
    eq(t.focusFx(), undefined, 'the focused window keeps the focus');
    t.later(50);
    t.focus('calc');
    eq(t.stage(), ['editor', 'files'], 'a raise within the quiet time is ignored');
    eq(t.focusFx(), 'editor');
    t.later(QUIET_MS);
    t.focus('calc');
    eq(t.stage(), ['calc']);
});

test('closing the last stage window: a grace period, then the next entry (no flash on a dialog swap)', () => {
    const t = desk();
    t.open('editor');
    t.later(QUIET_MS);
    t.open('launcher', { app: 'pages' });
    t.later(QUIET_MS);
    t.close('launcher');
    eq(t.stage(), []);
    t.focus('editor');              // Mutter's default focus
    eq(t.stage(), [], 'deferred');
    t.later(100);
    t.open('doc', { app: 'pages' });
    eq(t.stage(), ['doc']);
    eq(t.hidden(), ['editor'], 'the old stage never came back');
    t.later(GRACE_MS);
    eq(t.stage(), ['doc']);
    t.later(QUIET_MS);
    t.close('doc');
    t.later(GRACE_MS);
    eq(t.stage(), ['editor']);
    eq(t.focusFx(), 'editor');
});

test('dialogs follow their parent and never make an entry; an orphan dialog is left alone', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.open('props', { type: 'dialog', parent: t.id('files'), app: 'files.desktop' });
    eq(t.strip(), ['editor']);
    eq(t.sm.kindOf(t.id('props')), 'attached');
    t.later(QUIET_MS);
    t.send({ type: 'activate', entry: t.entryOf('editor') });
    eq(t.hidden(), ['files', 'props']);
    t.later(QUIET_MS);
    t.focus('props');               // the dialog asks for attention from the strip
    eq(t.stage(), ['files']);
    eq(t.hidden(), ['editor']);
    t.open('portal', { type: 'dialog', app: 'portal.desktop' });
    eq(t.sm.kindOf(t.id('portal')), 'exempt');
    eq(t.stage(), ['files']);
    t.open('progress', { skipTaskbar: true, app: 'files.desktop' });
    eq(t.stage(), ['files'], 'skip-taskbar helpers do not steal the stage');
});

test('an app with no windows makes no entry; sticky, above, PiP, other monitor are exempt', () => {
    const t = desk();
    t.open('editor');
    for (const [n, f] of [['sticky', { workspace: -1 }], ['above', { above: true }],
        ['pip', { title: 'Picture-in-Picture' }], ['other', { monitor: 1 }]]) {
        t.open(n, f);
        eq(t.sm.kindOf(t.id(n)), 'exempt', n);
    }
    eq(t.stage(), ['editor']);
    eq(t.strip(), []);
    eq(exemptReason({ workspace: 0, monitor: 0, title: 'x' }, 0), null);
});

test('full screen: a window that opens full screen stays out; a stage window keeps its entry', () => {
    const t = desk();
    t.open('editor');
    t.open('video', { fullscreen: true });
    eq(t.sm.kindOf(t.id('video')), 'exempt');
    eq(t.stage(), ['editor']);
    t.send({ type: 'change', window: { id: t.id('editor'), fullscreen: true } });
    eq(t.stage(), ['editor']);
    t.later(QUIET_MS);
    t.send({ type: 'change', window: { id: t.id('video'), fullscreen: false } });
    eq(t.stage(), ['video']);
    eq(t.strip(), ['editor']);
});

test('show desktop: the stage goes to the strip and comes back; a strip click or new window ends it', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.send({ type: 'toggle-desktop' });
    eq(t.sm.desktopShown(), true);
    eq(t.stage(), []);
    eq(t.strip(), ['files', 'editor']);
    eq(t.fxOf('desktop')[0].shown, true);
    t.send({ type: 'toggle-desktop' });
    eq(t.stage(), ['files']);
    eq(t.strip(), ['editor']);
    t.send({ type: 'toggle-desktop' });
    t.send({ type: 'activate', entry: t.entryOf('editor') });
    eq(t.sm.desktopShown(), false);
    eq(t.stage(), ['editor']);
    eq(t.fxOf('desktop')[0].shown, false);
    t.send({ type: 'toggle-desktop' });
    t.open('calc');
    eq(t.sm.desktopShown(), false);
    eq(t.stage(), ['calc']);
});

test('workspaces: a strip per workspace; moving a window takes it to the other one', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.send({ type: 'activate', entry: t.entryOf('editor'), add: true });
    t.send({ type: 'change', window: { id: t.id('files'), workspace: 1 } });
    eq(t.stage(0), ['editor']);
    eq(t.stage(1), ['files']);
    eq(t.hidden(), []);
    t.send({ type: 'workspace', active: 1 });
    eq(t.fxOf('strip').map(f => f.ws), [1]);
    t.open('calc', { workspace: 1 });
    eq(t.strip(1), ['files']);
    eq(t.strip(0), []);
});

test('keyboard: cycle sets in a stable ring, jump to slot n', () => {
    const t = desk();
    for (const n of ['a', 'b', 'c'])
        t.open(n);
    t.send({ type: 'cycle', dir: 1 });
    eq(t.stage(), ['a']);
    t.send({ type: 'cycle', dir: 1 });
    eq(t.stage(), ['b']);
    t.send({ type: 'cycle', dir: -1 });
    eq(t.stage(), ['a']);
    const second = t.strip()[1];
    t.send({ type: 'slot', n: 2 });
    eq(t.stage(), [second], 'slot 2 switches');
    const before = t.stage();
    t.send({ type: 'slot', n: 9 });
    eq(t.stage(), before, 'an empty slot does nothing');
});

test('open in current stage: the next window of the app joins the set; the arm expires', () => {
    const t = desk();
    t.open('editor');
    t.send({ type: 'join-next', appId: 'files.desktop' });
    t.open('calc');
    eq(t.stage(), ['calc'], 'another app is not caught');
    t.send({ type: 'join-next', appId: 'files.desktop' });
    t.open('files');
    eq(t.stage(), ['files', 'calc']);
    t.send({ type: 'join-next', appId: null });
    t.later(20000);
    t.open('music');
    eq(t.stage(), ['music']);
});

test('init: entries by app, the focused window\'s entry on the stage, minimized ones unminimized', () => {
    const t = desk();
    const ws = [t.win('a1', { app: 'a' }), t.win('b'), t.win('a2', { app: 'a', minimized: true }), t.win('c')];
    t.send({ type: 'init', windows: ws, focus: t.id('b'), active: 0, primary: 0 });
    eq(t.stage(), ['b']);
    eq(t.strip(), ['a1+a2', 'c']);
    eq(t.fxOf('unminimize').map(f => f.id), [t.id('a2')]);
    eq(t.fxOf('hide')[0].animate, false);
});

test('monitor change: windows that end up on another monitor leave their entry', () => {
    const t = desk();
    t.open('editor');
    t.open('files', { monitor: 1 });
    eq(t.sm.kindOf(t.id('files')), 'exempt');
    t.later(QUIET_MS);
    t.send({ type: 'monitors', primary: 1 });
    eq(t.stage(), ['files']);
    eq(t.sm.kindOf(t.id('editor')), 'exempt');
    eq(t.hidden(), []);
});

test('the strip lists every entry, however many; any is reachable', () => {
    const t = desk();
    const names = [...'abcdefghijkl'];
    for (const n of names)
        t.open(n);
    eq(t.sm.shownStrip().length, 11);
    eq(t.strip().length, 11);
    t.later(QUIET_MS);
    t.focus('a');
    eq(t.stage(), ['a']);
});

test('a new dialog of a strip window brings its entry onto the stage', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.later(QUIET_MS);
    t.open('save', { type: 'dialog', parent: t.id('editor'), app: 'editor.desktop' });
    eq(t.stage(), ['editor']);
    eq(t.hidden(), ['files']);
    eq(t.focusFx(), 'save');
});

test('open in current stage on a running app: its window joins the set when it gets the focus', () => {
    const t = desk();
    t.open('editor');
    t.open('files');
    t.send({ type: 'join-next', appId: null });
    t.focus('editor');
    eq(t.stage(), ['editor', 'files']);
    eq(t.sm.entry(t.entryOf('files')).set, true);
    eq(t.fxOf('cancel').map(f => f.key), ['join']);
});

test('Quick Look and windows other features set aside (Hide, Split View) stay out of the strip', () => {
    const t = desk();
    t.open('files');
    t.open('sushi', { app: 'org.gnome.NautilusPreviewer.desktop' });
    eq(t.sm.kindOf(t.id('sushi')), 'exempt');
    eq(t.stage(), ['files']);
    t.later(QUIET_MS);
    t.open('editor');
    t.send({ type: 'change', window: { id: t.id('files'), flagged: true } });
    eq(t.sm.kindOf(t.id('files')), 'exempt');
    eq(t.hidden(), []);
    t.later(QUIET_MS);
    t.send({ type: 'change', window: { id: t.id('files'), flagged: false } });
    eq(t.stage(), ['files']);
});

function setOf(t, names) {
    const t0 = t;
    t0.open(names[0]);
    for (const n of names.slice(1)) {
        t0.later(QUIET_MS);
        t0.open(n);
        t0.later(QUIET_MS);
    }
}

test('maximizing a window of a 2-window set leaves it alone on the stage; the other goes to the strip', () => {
    const t = desk({ newWindows: 'join' });
    setOf(t, ['editor', 'files']);
    eq(t.stage(), ['files', 'editor']);
    t.send({ type: 'change', window: { id: t.id('editor'), maximized: true } });
    eq(t.stage(), ['editor']);
    eq(t.strip(), ['files']);
    eq(t.fxOf('hide')[0].ids, [t.id('files')]);
    eq(t.focusFx(), 'editor');
    eq(t.sm.entry(t.entryOf('editor')).set, false);
});

test('maximizing one of a 3-window set sends the other two to the strip together, still a set', () => {
    const t = desk({ newWindows: 'join' });
    setOf(t, ['editor', 'files', 'music']);
    eq(t.stage().length, 3);
    t.send({ type: 'change', window: { id: t.id('files'), maximized: true } });
    eq(t.stage(), ['files']);
    eq(t.strip().length, 1);
    eq(t.sm.entry(t.sm.strip()[0]).windows.length, 2);
    eq(t.sm.entry(t.sm.strip()[0]).set, true);
    eq(t.fxOf('hide')[0].ids.length, 2);
    // Unmaximizing does not regroup
    t.send({ type: 'change', window: { id: t.id('files'), maximized: false } });
    eq(t.stage(), ['files']);
    eq(t.strip().length, 1);
});

test('maximizing a lone window, or one already maximized, splits nothing', () => {
    const t = desk();
    t.open('editor');
    t.send({ type: 'change', window: { id: t.id('editor'), maximized: true } });
    eq(t.stage(), ['editor']);
    eq(t.fxOf('hide'), []);
    t.send({ type: 'change', window: { id: t.id('editor'), maximized: true, title: 'x' } });
    eq(t.fxOf('hide'), []);
});

test('group: a strip entry dropped on another opens both as a set, tiled by the chosen side', () => {
    const t = desk();
    t.open('editor');
    t.later(QUIET_MS);
    t.open('files');
    t.later(QUIET_MS);
    t.open('music');
    t.later(QUIET_MS);
    t.open('calc');
    eq(t.strip(), ['music', 'files', 'editor']);
    const [music, files] = t.sm.strip();
    t.send({ type: 'group', dragged: music, target: files, side: 'left' });
    eq(t.stage(), ['music', 'files']);
    eq(t.strip(), ['calc', 'editor']);
    const tile = t.fxOf('tile')[0];
    eq(tile.left, [t.id('music')]);
    eq(tile.right, [t.id('files')]);
    eq(t.fxOf('show')[0].ids.length, 2);
    eq(t.fxOf('hide')[0].ids, [t.id('calc')]);
    eq(t.focusFx(), 'music');
    eq(t.sm.entry(t.entryOf('music')).set, true);
});

test('group: the right side, and onto an existing set', () => {
    const t = desk();
    for (const n of ['a', 'b', 'c', 'd']) {
        t.open(n);
        t.later(QUIET_MS);
    }
    const [c, b] = t.sm.strip();
    t.send({ type: 'group', dragged: c, target: b, side: 'left' });
    eq(t.stage(), ['c', 'b']);
    t.later(QUIET_MS);
    t.send({ type: 'activate', entry: t.sm.strip()[0], add: false });
    eq(t.stage(), ['d']);
    eq(t.strip(), ['c+b', 'a']);
    const [set, lone] = t.sm.strip();
    t.send({ type: 'group', dragged: lone, target: set, side: 'right' });
    eq(t.stage(), ['a', 'c', 'b']);
    const tile = t.fxOf('tile')[0];
    eq(tile.right, [t.id('a')]);
    eq(tile.left, [t.id('c'), t.id('b')]);
});

test('group: ignored for the stage entry, itself, or entries of other workspaces', () => {
    const t = desk();
    t.open('editor');
    t.later(QUIET_MS);
    t.open('files');
    const stage = t.sm.stage();
    const other = t.sm.strip()[0];
    eq(t.send({ type: 'group', dragged: other, target: stage, side: 'left' }), []);
    eq(t.send({ type: 'group', dragged: other, target: other, side: 'left' }), []);
    eq(t.send({ type: 'group', dragged: 'nope', target: other, side: 'left' }), []);
    eq(t.stage(), ['files']);
});

if (failed) {
    print(`${failed} test(s) failed`);
    imports.system.exit(1);
}
