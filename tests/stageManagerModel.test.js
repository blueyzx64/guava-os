// Run: gjs -m tests/stageManagerModel.test.js
// Scenario tests of the Stage Manager state machine (features/stageManager/model.js), one per
// rule of docs/features/stage-manager.md (the SM-n in the test names).
import {
    DWELL_MS, FLASH_MS, LEAVE_MS, MAX_SHOWN, QUIET_MS, StageModel, exemptReason,
} from '../features/stageManager/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}\n${e.stack}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// A small desktop: windows by name, a clock, timers, and the effects of the last event
function desk(config = {}) {
    const sm = new StageModel(config);
    const t = { sm, now: 1000, fx: [], timers: new Map(), ids: new Map(), n: 0, info: new Map() };
    t.win = (name, fields = {}) => {
        const id = ++t.n;
        t.ids.set(name, id);
        const w = {
            id, appId: fields.app ?? name.replace(/\d+$/, ''), type: 'normal', parent: null, workspace: 0,
            monitor: 0, fullscreen: false, above: false, skipTaskbar: false, title: name, minimized: false, ...fields,
        };
        t.info.set(name, w);
        return w;
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
        sm.checkInvariants();
        return t.fx;
    };
    t.open = (name, fields) => t.send({ type: 'add', window: t.win(name, fields) });
    t.close = name => t.send({ type: 'remove', id: t.id(name) });
    t.focus = name => t.send({ type: 'focus', id: t.id(name) });
    t.change = (name, fields) => {
        const w = { ...t.info.get(name), ...fields };
        t.info.set(name, w);
        return t.send({ type: 'change', window: w });
    };
    t.later = ms => {
        t.now += ms;
        for (const [key, at] of [...t.timers]) {
            if (at <= t.now) {
                t.timers.delete(key);
                t.send({ type: 'timer', key });
            }
        }
    };
    const nameOf = id => [...t.ids].find(([, v]) => v === id)?.[0] ?? id;
    t.stage = (ws = 0) => sm.stage(ws)?.windows.map(nameOf).sort() ?? [];
    t.strip = (ws = 0) => sm.strip(ws).map(s => s.windows.map(nameOf).sort().join('+'));
    t.hidden = () => [...sm.hiddenIds()].map(nameOf).sort();
    t.fxOf = type => t.fx.filter(f => f.type === type);
    t.focusFx = () => {
        const f = t.fxOf('focus')[0];
        return f ? nameOf(f.id) : undefined;
    };
    t.setOf = name => sm.stage(0)?.windows.includes(t.id(name)) ? 'stage' : 'strip';
    t.setId = name => [sm.stage(0), ...sm.waiting(0)].find(s => s?.windows.includes(t.id(name)))?.id;
    return t;
}

// Three apps open in turn: C on the stage, B then A in the strip
function three(config) {
    const t = desk(config);
    t.open('a');
    t.open('b');
    t.open('c');
    return t;
}

// ---- sets and the stage ---------------------------------------------------------------------

test('SM-1 the newest app is the stage, the others are hidden', () => {
    const t = three();
    eq(t.stage(), ['c']);
    eq(t.strip(), ['b', 'a']);
    eq(t.hidden(), ['a', 'b']);
});

test('SM-2 focusing a hidden set swaps it with the stage', () => {
    const t = three();
    t.later(QUIET_MS + 1);
    const fx = t.focus('a');
    eq(t.stage(), ['a']);
    eq(t.strip(), ['c', 'b']);
    eq(t.fxOf('show')[0].ids, [t.id('a')]);
    eq(t.fxOf('hide')[0].ids, [t.id('c')]);
    eq(fx.find(f => f.type === 'show').animate, true);
});

test('SM-2 activating a thumbnail does the same and focuses the lead window', () => {
    const t = three();
    t.send({ type: 'activate', set: t.setId('a') });
    eq(t.stage(), ['a']);
    eq(t.focusFx(), 'a');
});

test('SM-2 focus moves right after a switch the model made are not obeyed', () => {
    const t = three();
    t.send({ type: 'activate', set: t.setId('a') });
    t.now += 50;
    t.focus('b');   // windows raising each other
    eq(t.stage(), ['a']);
    eq(t.focusFx(), 'a');
});

test('SM-3 a new window of the stage app joins the stage set', () => {
    const t = three();
    t.open('c2', { app: 'c' });
    eq(t.stage(), ['c', 'c2']);
    eq(t.strip(), ['b', 'a']);
});

test('SM-3 a new window of a hidden app brings that set to the stage', () => {
    const t = three();
    t.open('a2', { app: 'a' });
    eq(t.stage(), ['a', 'a2']);
    eq(t.strip(), ['c', 'b']);
});

test('SM-3 join mode adds a new window of another app to the stage set', () => {
    const t = desk({ newWindows: 'join' });
    t.open('a');
    t.open('b');
    eq(t.stage(), ['a', 'b']);
    eq(t.strip(), []);
});

test('SM-3 one window per set when not grouping by app', () => {
    const t = desk({ allAtOnce: false });
    t.open('a');
    t.open('a2', { app: 'a' });
    eq(t.stage(), ['a2']);
    eq(t.strip(), ['a']);
});

test('SM-3 a dialog follows its parent', () => {
    const t = three();
    t.later(QUIET_MS + 1);
    t.open('d', { type: 'dialog', parent: t.id('c') });
    eq(t.sm.stageWindows().map(id => t.info.get('d').id === id ? 'd' : 'c').sort(), ['c', 'd']);
    t.focus('a');
    eq(t.hidden().sort(), ['b', 'c', 'd']);
    t.later(QUIET_MS + 1);
    t.focus('c');
    eq(t.hidden(), ['a', 'b']);
});

test('SM-4 closing a window of the stage set keeps the set and the focus on it', () => {
    const t = three();
    t.open('c2', { app: 'c' });
    t.close('c2');
    eq(t.stage(), ['c']);
    eq(t.focusFx(), 'c');
});

test('SM-4 closing the last stage window: the most recent set takes the stage at once (D-017)', () => {
    const t = three();
    t.close('c');
    eq(t.stage(), ['b']);
    eq(t.strip(), ['a']);
    eq(t.focusFx(), 'b');
    eq(t.fx.filter(f => f.type === 'timer').length, 0, 'no grace timer');
});

test('SM-4 a window that opens right after the close takes the stage', () => {
    const t = three();
    t.close('c');
    t.open('c2', { app: 'c' });
    eq(t.stage(), ['c2']);
    eq(t.strip(), ['b', 'a']);
});

test('SM-4 closing the only set leaves the stage empty; the next window takes it', () => {
    const t = desk();
    t.open('a');
    t.close('a');
    eq(t.stage(), []);
    t.open('b');
    eq(t.stage(), ['b']);
});

test('SM-4 closing a window of a hidden set removes it; an empty set disappears', () => {
    const t = three();
    t.close('a');
    eq(t.strip(), ['b']);
    eq(t.stage(), ['c']);
});

test('SM-5 Shift-click joins a set to the stage', () => {
    const t = three();
    t.send({ type: 'activate', set: t.setId('a'), add: true });
    eq(t.stage(), ['a', 'c']);
    eq(t.strip(), ['b']);
    eq(t.hidden(), ['b']);
});

test('SM-6 the strip lists at most six sets; older ones stay hidden and come back', () => {
    const t = desk();
    for (const n of 'abcdefghi')
        t.open(n);
    eq(t.sm.strip().length, MAX_SHOWN);
    eq(t.sm.waiting().length, 8);
    eq(t.stage(), ['i']);
    t.close('h');
    eq(t.sm.strip().length, MAX_SHOWN);
    eq(t.hidden().length, 7);
});

test('SM-7 exempt windows are never managed', () => {
    const base = { type: 'normal', workspace: 0, monitor: 0, above: false, skipTaskbar: false };
    eq(exemptReason({ ...base, workspace: -1 }, 0), 'sticky');
    eq(exemptReason({ ...base, above: true }, 0), 'above');
    eq(exemptReason({ ...base, skipTaskbar: true }, 0), 'skip-taskbar');
    eq(exemptReason({ ...base, title: 'Picture in picture' }, 0), 'pip');
    eq(exemptReason({ ...base, appId: 'org.gnome.NautilusPreviewer' }, 0), 'floating');
    eq(exemptReason({ ...base, monitor: 1 }, 0), 'monitor');
    eq(exemptReason({ ...base, flagged: true }, 0), 'flagged');
    eq(exemptReason({ ...base, type: 'dialog' }, 0), 'type');
    eq(exemptReason(base, 0), null);
    const t = three();
    t.open('p', { above: true });
    t.open('o', { monitor: 1 });
    eq(t.stage(), ['c']);
    eq(t.hidden(), ['a', 'b']);
});

// ---- minimize --------------------------------------------------------------------------------

test('SM-8 a minimized window leaves its set and is never hidden by Stage Manager', () => {
    const t = three();
    t.later(QUIET_MS + 1);
    t.change('c', { minimized: true });
    eq(t.sm.isManaged(t.id('c')), false);
    eq(t.hidden().includes('c'), false);
    eq(t.fxOf('hide').some(f => f.ids.includes(t.id('c'))), false);
    eq(t.fx.filter(f => f.type === 'unminimize').length, 0);
});

test('SM-9 minimizing the last stage window: the most recent set follows at once', () => {
    const t = three();
    t.change('c', { minimized: true });
    eq(t.stage(), ['b']);
    eq(t.strip(), ['a']);
});

test('SM-9 minimizing a window of a multi-window stage set keeps the set and focus', () => {
    const t = three();
    t.open('c2', { app: 'c' });
    t.change('c2', { minimized: true });
    eq(t.stage(), ['c']);
    eq(t.focusFx(), 'c');
});

test('SM-9 a minimized hidden window leaves its thumbnail', () => {
    const t = three();
    t.change('a', { minimized: true });
    eq(t.strip(), ['b']);
    eq(t.fxOf('show').some(f => f.ids.includes(t.id('a'))), true, 'a is not hidden any more (the Dock owns it)');
});

test('SM-10 restoring from the Dock makes the window the stage', () => {
    const t = three();
    t.change('c', { minimized: true });
    const fx = t.change('c', { minimized: false });
    eq(t.stage(), ['c']);
    eq(t.strip(), ['b', 'a']);
    eq(fx.find(f => f.type === 'hide').animate, false, 'the Genie is the animation');
});

test('SM-10 minimize all then restore all: the last restored is the stage', () => {
    const t = three();
    for (const n of ['c', 'b', 'a'])
        t.change(n, { minimized: true });
    eq(t.stage(), []);
    eq(t.hidden(), []);
    for (const n of ['c', 'b', 'a'])
        t.change(n, { minimized: false });
    eq(t.stage(), ['a']);
    eq(t.strip(), ['b', 'c']);
});

test('SM-11 a window minimized before start is in no set', () => {
    const t = desk();
    t.send({
        type: 'init', active: 0, primary: 0, focus: null,
        windows: [t.win('a', { minimized: true }), t.win('b')],
    });
    eq(t.stage(), ['b']);
    eq(t.hidden(), []);
});

// ---- maximize, full screen -------------------------------------------------------------------

test('SM-12 maximize changes nothing in the sets', () => {
    const t = three();
    const before = JSON.stringify([t.stage(), t.strip()]);
    t.change('c', { maximized: true });
    eq(JSON.stringify([t.stage(), t.strip()]), before);
    t.focus('c');
    t.change('c', { maximized: false });
    eq(JSON.stringify([t.stage(), t.strip()]), before);
});

test('SM-12 a hidden zoomed window comes back as it was', () => {
    const t = three();
    t.change('b', { maximized: true });
    t.later(QUIET_MS + 1);
    t.focus('b');
    eq(t.stage(), ['b']);
    t.focus('c');
    eq(t.stage(), ['b']);   // quiet
    t.later(QUIET_MS + 1);
    t.focus('c');
    eq(t.stage(), ['c']);
});

test('SM-12 a stage window that goes full screen or above stays in its set', () => {
    const t = three();
    t.change('c', { fullscreen: true });
    t.change('c', { above: true });
    eq(t.stage(), ['c']);
    eq(t.sm.isManaged(t.id('c')), true);
});

test('SM-14 a full screen stage window hides the strip and it cannot be revealed', () => {
    const t = three();
    eq(t.sm.stripVisible, true);
    t.change('c', { fullscreen: true });
    eq(t.fxOf('strip-visible'), [{ type: 'strip-visible', visible: false }]);
    t.send({ type: 'push' });
    eq(t.sm.stripVisible, false);
    t.change('c', { fullscreen: false });
    eq(t.sm.stripVisible, true);
});

// ---- the strip -------------------------------------------------------------------------------

test('SM-15 show-recent off keeps the strip hidden until revealed', () => {
    const t = three({ showRecent: false });
    eq(t.sm.stripVisible, false);
    t.send({ type: 'push' });
    eq(t.sm.stripVisible, true);
});

test('SM-16 a stage window over the strip area hides it, autohide off keeps it', () => {
    const t = three();
    t.send({ type: 'overlap', on: true });
    eq(t.sm.stripVisible, false);
    t.send({ type: 'overlap', on: false });
    eq(t.sm.stripVisible, true);
    t.send({ type: 'config', config: { autohide: false } });
    t.send({ type: 'overlap', on: true });
    eq(t.sm.stripVisible, true);
});

test('SM-17 a push reveals; it goes after the pointer left for LEAVE_MS', () => {
    const t = three();
    t.send({ type: 'overlap', on: true });
    t.send({ type: 'push' });
    eq(t.sm.stripVisible, true);
    eq(t.timers.has('leave'), true);
    t.later(LEAVE_MS + 1);
    eq(t.sm.stripVisible, false);
});

test('SM-17 resting on the edge for DWELL_MS reveals; leaving early does not', () => {
    const t = three();
    t.send({ type: 'overlap', on: true });
    t.send({ type: 'edge', on: true });
    t.later(DWELL_MS - 10);
    eq(t.sm.stripVisible, false);
    t.send({ type: 'edge', on: false });
    t.later(DWELL_MS);
    eq(t.sm.stripVisible, false);
    t.send({ type: 'edge', on: true });
    t.later(DWELL_MS + 1);
    eq(t.sm.stripVisible, true);
});

test('SM-18 the strip stays while the pointer is on it, then goes', () => {
    const t = three();
    t.send({ type: 'overlap', on: true });
    t.send({ type: 'edge', on: true });
    t.later(DWELL_MS + 1);
    t.send({ type: 'edge', on: false });
    t.send({ type: 'strip-hover', on: true });
    t.later(LEAVE_MS * 3);
    eq(t.sm.stripVisible, true);
    t.send({ type: 'strip-hover', on: false });
    t.later(LEAVE_MS + 1);
    eq(t.sm.stripVisible, false);
});

test('SM-18 reveal and hide reverse in any order without state left over', () => {
    const t = three();
    t.send({ type: 'overlap', on: true });
    t.send({ type: 'push' });
    t.send({ type: 'edge', on: true });
    t.send({ type: 'edge', on: false });
    t.later(LEAVE_MS + 1);
    t.send({ type: 'push' });
    t.later(LEAVE_MS + 1);
    eq(t.sm.stripVisible, false);
});

test('SM-19 the cycle shortcut reveals the strip for FLASH_MS', () => {
    const t = three();
    t.send({ type: 'overlap', on: true });
    t.send({ type: 'cycle', dir: 1 });
    eq(t.sm.stripVisible, true);
    t.later(FLASH_MS - 10);
    eq(t.sm.stripVisible, true);
    t.later(20);
    eq(t.sm.stripVisible, false);
});

test('SM-15 an empty strip is not shown; the overview hides it', () => {
    const t = desk();
    t.open('a');
    eq(t.sm.stripVisible, false);
    t.open('b');
    eq(t.sm.stripVisible, true);
    t.send({ type: 'overview', on: true });
    eq(t.sm.stripVisible, false);
});

// ---- switching -------------------------------------------------------------------------------

test('SM-24 next brings the most recent set, previous the oldest', () => {
    const t = three();
    t.send({ type: 'cycle', dir: 1 });
    eq(t.stage(), ['b']);
    t.later(QUIET_MS + 1);
    const u = three();
    u.send({ type: 'cycle', dir: -1 });
    eq(u.stage(), ['a']);
    eq(u.strip(), ['c', 'b']);
});

test('SM-24 slot n activates the nth strip entry', () => {
    const t = three();
    t.send({ type: 'slot', n: 2 });
    eq(t.stage(), ['a']);
    t.send({ type: 'slot', n: 9 });
    eq(t.stage(), ['a']);
});

test('SM-24 remove takes a window out of its set into the strip', () => {
    const t = three();
    t.open('c2', { app: 'c' });
    t.send({ type: 'unset', id: t.id('c2') });
    eq(t.stage(), ['c']);
    eq(t.strip(), ['c2', 'b', 'a']);
});

test('SM-25 stash sends a stage window to the strip as its own set', () => {
    const t = three();
    t.open('c2', { app: 'c' });
    t.send({ type: 'stash', id: t.id('c2') });
    eq(t.stage(), ['c']);
    eq(t.strip()[0], 'c2');
    t.send({ type: 'stash', id: t.id('c') });
    eq(t.stage(), ['c2'], 'the most recent other set; the stashed one does not come back');
    eq(t.strip()[0], 'c');
});

test('SM-34 a window dropped on a thumbnail joins that set', () => {
    const t = three();
    t.open('c2', { app: 'c' });
    const target = { id: t.setId('a') };
    t.send({ type: 'move-to', id: t.id('c2'), set: target.id });
    eq(t.stage(), ['c']);
    eq(t.strip().includes('a+c2'), true);
    eq(t.sm.hiddenIds().has(t.id('c2')), true, 'the window is hidden with its new set');
    eq(t.sm.strip().find(x => x.id === target.id).windows.length, 2);
});

test('SM-34 dropping the only stage window on a thumbnail brings the most recent set up', () => {
    const t = three();
    const target = { id: t.setId('a') };
    t.send({ type: 'move-to', id: t.id('c'), set: target.id });
    eq(t.stage().length > 0, true, 'the stage is never left empty');
    eq(t.sm.isManaged(t.id('c')), true);
});

test('SM-34 a drop on its own set or an unknown set changes nothing', () => {
    const t = three();
    const own = { id: t.setId('c') };
    t.send({ type: 'move-to', id: t.id('c'), set: own.id });
    t.send({ type: 'move-to', id: t.id('c'), set: 9999 });
    eq(t.stage(), ['c']);
    eq(t.strip(), ['b', 'a']);
});

test('SM-34 a thumbnail dropped on the stage joins the stage set', () => {
    const t = three();
    const a = { id: t.setId('a') };
    t.send({ type: 'activate', set: a.id, add: true });
    eq(t.stage().sort(), ['a', 'c']);
    eq(t.strip(), ['b']);
});

// ---- workspaces, desktop, API ----------------------------------------------------------------

test('SM-27 each workspace has its own stage and strip', () => {
    const t = desk();
    t.open('a');
    t.open('b');
    t.open('x', { workspace: 1 });
    t.open('y', { workspace: 1 });
    eq(t.stage(0), ['b']);
    eq(t.stage(1), ['x']);
    eq(t.strip(1), ['y']);
    t.send({ type: 'workspace', active: 1 });
    eq(t.sm.stageWindows().map(id => id === t.id('x')), [true]);
    eq(t.sm.hiddenIds().has(t.id('y')), true);
});

test('SM-27 a window moved to another workspace joins that workspace', () => {
    const t = three();
    t.open('x', { workspace: 1 });
    t.later(QUIET_MS + 1);
    t.change('c', { workspace: 1 });
    eq(t.stage(1), ['x']);
    eq(t.strip(1), ['c']);
    eq(t.stage(0), ['b']);
});

test('SM-28 a window on another monitor is not managed; moving it here manages it', () => {
    const t = desk();
    t.open('a');
    t.open('m', { monitor: 1 });
    eq(t.sm.isManaged(t.id('m')), false);
    t.change('m', { monitor: 0 });
    eq(t.sm.isManaged(t.id('m')), true);
    eq(t.stage(), ['m']);
});

test('SM-29 openIntoStage: the next window of the app joins the stage set', () => {
    const t = three();
    t.send({ type: 'join-next', appId: 'a' });
    t.open('a', { app: 'a' });
    eq(t.stage(), ['a', 'c']);
});

test('SM-29 join-next expires', () => {
    const t = three();
    t.send({ type: 'join-next', appId: 'z' });
    t.now += 20000;
    t.open('z1', { app: 'z' });
    eq(t.stage(), ['z1']);
});

test('SM-31 Show Desktop hides the stage; again, or any focus, brings it back', () => {
    const t = three();
    t.send({ type: 'toggle-desktop' });
    eq(t.sm.desktopShown(), true);
    eq(t.stage(), []);
    eq(t.hidden(), ['a', 'b', 'c']);
    t.send({ type: 'toggle-desktop' });
    eq(t.stage(), ['c']);
    eq(t.sm.desktopShown(), false);
    t.send({ type: 'toggle-desktop' });
    t.later(QUIET_MS + 1);
    t.focus('a');
    eq(t.stage(), ['a']);
    eq(t.sm.desktopShown(), false);
});

test('SM-31 a new window ends Show Desktop and takes the stage', () => {
    const t = three();
    t.send({ type: 'toggle-desktop' });
    t.open('n');
    eq(t.stage(), ['n']);
    eq(t.sm.desktopShown(), false);
});

test('SM-33 init puts the focused window on the stage, the rest in the strip by recency', () => {
    const t = desk();
    const w = ['a', 'b', 'c'].map(n => t.win(n));
    t.send({ type: 'init', active: 0, primary: 0, focus: t.id('b'), windows: w });
    eq(t.stage(), ['b']);
    eq(t.strip(), ['a', 'c']);
    eq(t.fxOf('hide')[0].animate, false);
});

test('SM-33 the model has nothing hidden when no window is managed', () => {
    const t = desk();
    t.send({ type: 'init', active: 0, primary: 0, focus: null, windows: [] });
    eq(t.hidden(), []);
    eq(t.sm.stage(), null);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
