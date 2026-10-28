// Run: gjs -m tests/desktopModel.test.js
import { DesktopModel, WINDOW_FIELDS, isUserFacing, appIdCandidates } from '../core/desktopModel.js';
import { EventHub } from '../core/events.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function recorder() {
    const hub = new EventHub();
    const log = [];
    for (const name of ['window-added', 'window-changed', 'window-removed', 'window-focused', 'app-focused', 'workspaces-changed', 'monitors-changed'])
        hub.on(name, p => log.push([name, p.window?.id ?? p.appId ?? p.count ?? p.primary ?? null, p.fields ?? null]));
    return { hub, log };
}

test('upsert: new window emits added with defaults; a real change emits changed with its fields', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    eq(m.upsertWindow(1, { appId: 'a', title: 'A' }).length > 0, true);
    eq(m.window(1).minimized, false);
    eq(m.upsertWindow(1, { title: 'A' }), [], 'no change, no event');
    eq(m.upsertWindow(1, { minimized: true }), ['minimized']);
    eq(log, [['window-added', 1, null], ['window-changed', 1, ['minimized']]]);
    if (!Object.isFrozen(m.window(1)))
        throw new Error('WindowInfo must be frozen');
});
test('focus: MRU order, focused app, events once per change', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.upsertWindow(2, { appId: 'b' });
    m.upsertWindow(3, { appId: 'a' });
    m.setFocus(3);
    m.setFocus(2);
    eq(m.windows().map(w => w.id), [2, 3, 1]);
    eq(m.apps(), ['b', 'a']);
    eq(m.focusedApp, 'b');
    log.length = 0;
    m.setFocus(2);
    eq(log, [], 'same focus: nothing');
    m.setFocus(99);
    eq(m.focusedWindow, null, 'unknown id is no focus');
    eq(log, [['window-focused', null, null], ['app-focused', null, null]]);
});
test('remove: forgets the window, drops focus', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a' });
    m.setFocus(1);
    eq(m.removeWindow(1), true);
    eq(m.removeWindow(1), false);
    eq(m.focusedWindow, null);
    eq(m.focusedApp, null);
    eq(m.windows(), []);
});
test('filters: workspace (with on-all), monitor, app, minimized, user-facing', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a', workspace: 0 });
    m.upsertWindow(2, { appId: 'a', workspace: 1, minimized: true });
    m.upsertWindow(3, { appId: 'b', workspace: -1, monitor: 1 });
    m.upsertWindow(4, { appId: 'c', type: 'other' });
    m.upsertWindow(5, { appId: 'd', skipTaskbar: true });
    const ids = f => m.windows(f).map(w => w.id).sort();
    eq(ids({ workspace: 1 }), [2, 3]);
    eq(ids({ monitor: 1 }), [3]);
    eq(ids({ appId: 'a', minimized: false }), [1]);
    eq(ids({}), [1, 2, 3]);
    eq(ids({ userFacing: false }), [1, 2, 3, 4, 5]);
    eq(isUserFacing(m.window(4)), false);
});
test('workspaces and monitors emit only on change', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.setWorkspaces({ count: 1, active: 0 });
    m.setWorkspaces({ count: 2, active: 1 });
    const mon = [{ x: 0, y: 0, width: 1280, height: 800 }];
    m.setMonitors(mon, 0);
    m.setMonitors([{ ...mon[0] }], 0);
    eq(log.map(l => l[0]), ['workspaces-changed', 'monitors-changed']);
    eq(m.monitors[0].index, 0);
});
test('a focused window changing app re-announces the focused app', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: null });
    m.setFocus(1);
    log.length = 0;
    m.upsertWindow(1, { appId: 'late.App' });
    eq(log.map(l => l[0]), ['window-changed', 'app-focused']);
    eq(m.focusedApp, 'late.App');
});

test('web-app ids: Chrome PWAs on Xwayland and Wayland', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    eq(appIdCandidates(`crx_${id}`).ids[0], `chrome-${id}-Default.desktop`);
    eq(appIdCandidates(`crx_${id}`).prefix, `chrome-${id}-`);
    eq(appIdCandidates(`chrome-${id}-Profile_1`).ids[0], `chrome-${id}-Profile_1.desktop`);
});
test('web-app ids: GNOME Web apps, new and old spellings', () => {
    eq(appIdCandidates('org.gnome.Epiphany.WebApp_1a2b').ids.slice(0, 3),
        ['org.gnome.Epiphany.WebApp_1a2b.desktop', 'org.gnome.Epiphany.WebApp-1a2b.desktop', 'epiphany-1a2b.desktop']);
    eq(appIdCandidates('epiphany-xyz').ids[0], 'org.gnome.Epiphany.WebApp_xyz.desktop');
});
test('web-app ids: plain classes, and nothing for an empty class', () => {
    eq(appIdCandidates('Gimp').ids, ['Gimp.desktop', 'gimp.desktop']);
    eq(appIdCandidates(null), { ids: [], prefix: null });
});

// ---- hardening (H2) ---------------------------------------------------------------------

test('multi workspace + monitor: filters combine, on-all windows follow every workspace', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a', workspace: 0, monitor: 0 });
    m.upsertWindow(2, { appId: 'a', workspace: 0, monitor: 1 });
    m.upsertWindow(3, { appId: 'b', workspace: 1, monitor: 1 });
    m.upsertWindow(4, { appId: 'c', workspace: -1, monitor: 0 });
    m.upsertWindow(5, { appId: 'd', workspace: 2, monitor: 2 });
    const ids = f => m.windows(f).map(w => w.id).sort();
    eq(ids({ workspace: 0, monitor: 1 }), [2]);
    eq(ids({ workspace: 1, monitor: 0 }), [4], 'on-all window shows on workspace 1, monitor 0');
    eq(ids({ workspace: 2 }), [4, 5]);
    eq(ids({ workspace: 3 }), [4], 'a workspace with no windows still sees on-all ones');
    eq(ids({ monitor: 2 }), [5]);
    eq(ids({ monitor: 7 }), []);
    eq(ids({ workspace: 0, appId: 'a' }), [1, 2]);
    eq(m.apps({ workspace: 1 }).sort(), ['b', 'c']);
    eq(m.apps({ monitor: 1 }).sort(), ['a', 'b']);
});
test('moving a window between workspaces and monitors updates the filters', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a', workspace: 0, monitor: 0 });
    log.length = 0;
    eq(m.upsertWindow(1, { workspace: 1, monitor: 1 }), ['workspace', 'monitor']);
    eq(m.windows({ workspace: 0 }), []);
    eq(m.windows({ workspace: 1, monitor: 1 }).map(w => w.id), [1]);
    eq(log, [['window-changed', 1, ['workspace', 'monitor']]]);
    m.upsertWindow(1, { workspace: -1 });
    eq(m.windows({ workspace: 5 }).map(w => w.id), [1], 'pinned to all workspaces');
});
test('filters: appId null matches app-less windows; apps() skips them', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, {});
    m.upsertWindow(2, { appId: 'a' });
    eq(m.windows({ appId: null }).map(w => w.id), [1]);
    eq(m.windows({ appId: 'nope' }), []);
    eq(m.apps(), ['a']);
});
test('filters: minimized false drops minimized windows; minimized true keeps only them', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a', minimized: true });
    m.upsertWindow(2, { appId: 'a' });
    eq(m.windows({ minimized: false }).map(w => w.id), [2]);
    eq(m.windows({ minimized: true }).map(w => w.id), [1], 'only the minimized one');
    eq(m.windows({ minimized: undefined }).map(w => w.id).sort(), [1, 2], 'undefined does not filter');
    eq(m.apps({ minimized: true }), ['a']);
    eq(m.apps({ minimized: false }), ['a']);
    m.upsertWindow(2, { minimized: true });
    eq(m.apps({ minimized: false }), [], 'an app with only minimized windows drops out');
    eq(m.apps(), ['a'], 'but is still running');
});
test('filters: dialogs are user-facing, skip-taskbar dialogs and other types are not', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a', type: 'dialog' });
    m.upsertWindow(2, { appId: 'b', type: 'dialog', skipTaskbar: true });
    m.upsertWindow(3, { appId: 'c', type: 'utility' });
    eq(m.windows().map(w => w.id), [1]);
    eq(m.apps({ userFacing: false }).sort(), ['a', 'b', 'c']);
    eq(isUserFacing(null), false);
    eq(isUserFacing(undefined), false);
});
test('windows() returns a fresh array; results are frozen', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a' });
    const a = m.windows();
    a.push('junk');
    eq(m.windows().length, 1, 'mutating the result does not touch the model');
    let threw = false;
    try { m.window(1).title = 'x'; } catch (_e) { threw = true; }
    eq([threw, m.window(1).title], [true, ''], 'frozen: assignment throws in a module');
    eq(Object.isFrozen(m.workspaces), true);
    m.setMonitors([{ x: 0, y: 0, width: 10, height: 10 }], 0);
    eq(Object.isFrozen(m.monitors) && Object.isFrozen(m.monitors[0]), true);
});
test('upsert: unknown fields ignored, missing fields kept, old snapshot unchanged', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a', title: 'A', bogus: 1 });
    const before = m.window(1);
    eq('bogus' in before, false);
    eq(m.upsertWindow(1, { bogus: 2 }), [], 'unknown field alone is no change');
    m.upsertWindow(1, { title: 'B' });
    eq(before.title, 'A', 'old WindowInfo is a snapshot');
    eq(m.window(1).appId, 'a', 'missing field kept');
    eq(Object.keys(m.window(1)), ['id', ...WINDOW_FIELDS]);
});
test('upsert: a new window is least recent until focused', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: 'a' });
    m.setFocus(1);
    m.upsertWindow(2, { appId: 'b' });
    eq(m.windows().map(w => w.id), [1, 2]);
    eq(m.apps(), ['a', 'b']);
    m.setFocus(2);
    eq(m.windows().map(w => w.id), [2, 1]);
});
test('focus: same-app switch emits window-focused only; null twice is no change', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.upsertWindow(2, { appId: 'a' });
    m.upsertWindow(3, { appId: 'b' });
    m.setFocus(1);
    log.length = 0;
    eq(m.setFocus(2), true);
    eq(log, [['window-focused', 2, null]], 'same app: no app-focused');
    eq(m.setFocus(3), true);
    eq(log.slice(1), [['window-focused', 3, null], ['app-focused', 'b', null]]);
    eq(m.setFocus(null), true);
    eq(m.setFocus(null), false);
    eq(m.setFocus(99), false, 'unknown id while unfocused is still no focus');
    eq(m.focusedApp, null);
    eq(m.windows().map(w => w.id), [3, 2, 1], 'unfocusing keeps the MRU order');
});
test('focus: an app-less window focused announces app null', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.upsertWindow(2, {});
    m.setFocus(1);
    log.length = 0;
    m.setFocus(2);
    eq(log, [['window-focused', 2, null], ['app-focused', null, null]]);
});
test('focus: the focused window losing its app id re-announces null', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.setFocus(1);
    log.length = 0;
    m.upsertWindow(1, { appId: null });
    eq(log.map(l => l[0]), ['window-changed', 'app-focused']);
    eq(m.focusedApp, null);
});
test('an unfocused window changing app does not touch the focused app', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.upsertWindow(2, { appId: 'b' });
    m.setFocus(1);
    log.length = 0;
    m.upsertWindow(2, { appId: 'c' });
    eq(log.map(l => l[0]), ['window-changed']);
    eq(m.focusedApp, 'a');
});
test('remove: an unfocused window keeps focus; the focused one emits removed then focus null', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.upsertWindow(2, { appId: 'b' });
    m.setFocus(1);
    log.length = 0;
    m.removeWindow(2);
    eq(log, [['window-removed', 2, null]]);
    eq(m.focusedApp, 'a');
    log.length = 0;
    m.removeWindow(1);
    eq(log, [['window-removed', 1, null], ['window-focused', null, null], ['app-focused', null, null]]);
    eq(m.removeWindow(42), false);
});
test('closing windows while iterating windows() visits every window once', () => {
    const m = new DesktopModel();
    for (let i = 1; i <= 6; i++)
        m.upsertWindow(i, { appId: `app${i % 2}` });
    m.setFocus(3);
    const seen = [];
    for (const w of m.windows()) {
        seen.push(w.id);
        m.removeWindow(w.id);
        if (w.id === 3)
            m.removeWindow(5); // a sibling closes too
    }
    eq(seen.sort(), [1, 2, 3, 4, 5, 6], 'the snapshot still lists the closed sibling');
    eq(m.windows({ userFacing: false }), []);
    eq(m.focusedWindow, null);
    eq(m.apps(), []);
});
test('closing the focused window from a window-focused listener leaves a consistent state', () => {
    const hub = new EventHub();
    const m = new DesktopModel(hub);
    const order = [];
    hub.on('window-focused', ({ window }) => {
        order.push(['focused', window?.id ?? null]);
        if (window?.id === 1)
            m.removeWindow(1);
    });
    hub.on('window-removed', ({ window }) => order.push(['removed', window.id]));
    hub.on('app-focused', ({ appId }) => order.push(['app', appId]));
    m.upsertWindow(1, { appId: 'a' });
    m.upsertWindow(2, { appId: 'b' });
    m.setFocus(1);
    eq(m.focusedWindow, null);
    eq(m.focusedApp, null);
    eq(m.windows().map(w => w.id), [2]);
    eq(order, [['focused', 1], ['removed', 1], ['focused', null]],
        'app-focused stays null throughout, so it is never announced');
});
test('a window-removed listener that adds a window keeps the model consistent', () => {
    const hub = new EventHub();
    const m = new DesktopModel(hub);
    hub.on('window-removed', ({ window }) => {
        if (window.id === 1)
            m.upsertWindow(10, { appId: 'replacement' });
    });
    m.upsertWindow(1, { appId: 'a' });
    m.setFocus(1);
    m.removeWindow(1);
    eq(m.windows().map(w => w.id), [10]);
    eq(m.focusedWindow, null);
});
test('workspaces: active-only and count-only changes each emit', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    eq(m.setWorkspaces({ count: 1, active: 0 }), false, 'initial state');
    eq(m.setWorkspaces({ count: 4, active: 0 }), true);
    eq(m.setWorkspaces({ count: 4, active: 3 }), true);
    eq(m.setWorkspaces({ count: 4, active: 3 }), false);
    eq(log.map(l => l[0]), ['workspaces-changed', 'workspaces-changed']);
    eq(m.workspaces, { count: 4, active: 3 });
});
test('monitors: primary, geometry and count changes emit; extra fields dropped', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    eq(m.setMonitors([], 0), false, 'initial state');
    const a = { x: 0, y: 0, width: 1920, height: 1080 };
    const b = { x: 1920, y: 0, width: 1280, height: 1024, scale: 2 };
    eq(m.setMonitors([a, b], 0), true);
    eq(m.setMonitors([a, b], 1), true, 'primary only');
    eq(m.setMonitors([a, { ...b, width: 1281 }], 1), true, 'geometry only');
    eq(m.setMonitors([a], 0), true, 'unplugged');
    eq(m.setMonitors([a], 0), false);
    eq(log.filter(l => l[0] === 'monitors-changed').length, 4);
    m.setMonitors([a, b], 1);
    eq(m.monitors[1], { index: 1, x: 1920, y: 0, width: 1280, height: 1024 });
    eq(m.primaryMonitor, 1);
});
test('reset forgets everything and emits nothing', () => {
    const { hub, log } = recorder();
    const m = new DesktopModel(hub);
    m.upsertWindow(1, { appId: 'a' });
    m.setFocus(1);
    m.setWorkspaces({ count: 3, active: 2 });
    m.setMonitors([{ x: 0, y: 0, width: 1, height: 1 }], 0);
    log.length = 0;
    m.reset();
    eq(log, []);
    eq(m.windows({ userFacing: false }), []);
    eq([m.focusedWindow, m.focusedApp, m.primaryMonitor], [null, null, 0]);
    eq(m.workspaces, { count: 1, active: 0 });
    eq(m.monitors, []);
    m.upsertWindow(1, { appId: 'a' });
    eq(log.map(l => l[0]), ['window-added'], 'id reuse after reset is a new window');
});
test('a model without an event hub works silently', () => {
    const m = new DesktopModel(null);
    m.upsertWindow(1, { appId: 'a' });
    m.setFocus(1);
    m.upsertWindow(1, { appId: 'b' });
    eq(m.focusedApp, 'b');
    m.removeWindow(1);
    eq(m.focusedApp, null);
});

test('web-app ids: Chrome ids are lower-cased, the profile keeps its case', () => {
    const id = 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP';
    const lower = id.toLowerCase();
    eq(appIdCandidates(`CRX_${id}`).ids[0], `chrome-${lower}-Default.desktop`);
    eq(appIdCandidates(`chrome-${id}-Profile_2`).ids[0], `chrome-${lower}-Profile_2.desktop`);
    eq(appIdCandidates(`chrome-${id}-Profile_2`).prefix, `chrome-${lower}-`);
    const all = appIdCandidates(`crx_${lower}`).ids;
    eq(all, [`chrome-${lower}-Default.desktop`, `crx_${lower}.desktop`], 'raw class kept as fallback, deduped');
});
test('web-app ids: malformed Chrome ids fall back to the plain class', () => {
    eq(appIdCandidates('crx_short'), { ids: ['crx_short.desktop'], prefix: null });
    const q = 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'; // q is outside a-p
    eq(appIdCandidates(`crx_${q}`).prefix, null);
    eq(appIdCandidates('chrome-abcdefghijklmnopabcdefghijklmnop').prefix, null, 'no profile part');
    eq(appIdCandidates('google-chrome').ids, ['google-chrome.desktop']);
});
test('web-app ids: GNOME Web dash spelling, trimming and order', () => {
    eq(appIdCandidates('org.gnome.Epiphany.WebApp-abc').ids,
        ['org.gnome.Epiphany.WebApp_abc.desktop', 'org.gnome.Epiphany.WebApp-abc.desktop',
            'epiphany-abc.desktop', 'org.gnome.epiphany.webapp-abc.desktop']);
    eq(appIdCandidates('org.gnome.Epiphany.WebApp_1a2b').prefix, null);
    eq(appIdCandidates('  Gimp \n').ids, ['Gimp.desktop', 'gimp.desktop']);
    eq(appIdCandidates('   '), { ids: [], prefix: null });
    eq(appIdCandidates(undefined), { ids: [], prefix: null });
    eq(appIdCandidates('org.gnome.Epiphany').ids, ['org.gnome.Epiphany.desktop', 'org.gnome.epiphany.desktop'],
        'the browser itself is not a web app');
});

// ---- bug fixes (board F3): an undefined field keeps the value -------------------------------
test('F3: upsert with an undefined field keeps the default for a new window, the old value for a known one', () => {
    const m = new DesktopModel();
    m.upsertWindow(1, { appId: undefined, title: 'T' });
    eq(m.window(1).appId, null, 'default, not undefined');
    eq(m.upsertWindow(1, { appId: 'a' }), ['appId']);
    eq(m.upsertWindow(1, { appId: undefined }), [], 'undefined is no change');
    eq(m.window(1).appId, 'a');
    eq(m.apps(), ['a']);
    eq(m.upsertWindow(1, { appId: undefined, minimized: true }), ['minimized']);
    eq(m.window(1).appId, 'a');
    noUndefinedFields(m.window(1));
});
function noUndefinedFields(info) {
    for (const f of WINDOW_FIELDS)
        if (info[f] === undefined)
            throw new Error(`field ${f} is undefined`);
}

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
