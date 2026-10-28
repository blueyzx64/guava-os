// Run: gjs -m tests/dockModel.test.js
// features/dock/model.js: the dock's pure decisions.
import {
    RECENT_MAX, AUTOSTART_MARK, LAUNCH_BOUNCES_MAX, ATTENTION_BOUNCES, Reveal, addFolder,
    autostartState, autostartText, badgeProgress, badgeText, bounceAgain, bounceSteps, clickAction,
    dockItems, dockMetrics, downloadEntry, downloadFinished, dropIndex, fanLayout, folderDropAccepted,
    magnify, magnifyScale, menuEntries, nextWindow, packageKind, pinPosition, pushRecent, readConfig,
    isPartialWrite, rectContains, removeFolder, sortDownloads, stableOrder, stackView,
} from '../features/dock/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const kinds = items => items.map(i => (i.kind === 'app' ? `${i.section}:${i.id}${i.running ? '*' : ''}` : i.kind));

// ---- config and sizes
test('config: defaults pass through, bad values fall back', () => {
    const vals = {
        'dock-position': 'top', 'dock-icon-size': 400, 'dock-autohide': false, 'dock-autohide-delay': -5,
        'dock-show-recents': true, 'dock-running-dots': true, 'dock-minimize-to-app': false,
        'dock-downloads': true, 'dock-downloads-view': 'spiral',
        'dock-magnification': false, 'dock-magnification-size': 999, 'dock-launch-animation': true,
        'dock-attention-bounce': true, 'dock-badges': true, 'dock-background-apps': true,
        'dock-folders': ['/home/u/Projects', 'relative', ''],
    };
    const get = { bool: k => vals[k], int: k => vals[k], string: k => vals[k], strv: k => vals[k] };
    const c = readConfig(get);
    eq([c.position, c.iconSize, c.autohideDelay, c.stackView], ['bottom', 128, 0, 'automatic']);
    eq([c.magnification, c.magnifiedSize, c.folders], [false, 160, ['/home/u/Projects']]);
});
test('metrics: the edge claim includes the floating gap; radii are concentric', () => {
    const m = dockMetrics(48);
    eq(m.size, m.thickness + 2 * m.gap);
    eq(m.thickness, m.tile + 2 * (m.padding + m.border));
    eq(m.tileRadius, m.radius - m.padding);
    eq(dockMetrics(4).icon, 24);
});

// ---- contents
test('items: pinned, separator, recent section, separator, Downloads, Trash (macOS order)', () => {
    const items = dockItems({
        pinned: ['files', 'editor'], running: ['editor', 'calc'], recents: ['calc', 'music', 'web', 'old'],
        showRecents: true,
    });
    eq(kinds(items), ['pinned:files', 'pinned:editor*', 'separator', 'recent:calc*', 'recent:music',
        'recent:web', 'separator', 'downloads', 'trash']);
});
test('items: running unpinned apps can outnumber the recent slots; closed ones then wait', () => {
    const items = dockItems({ pinned: [], running: ['a', 'b', 'c', 'd'], recents: ['x'], showRecents: true });
    eq(kinds(items).filter(k => k.startsWith('recent')), ['recent:a*', 'recent:b*', 'recent:c*', 'recent:d*']);
    eq(kinds(items)[0], 'recent:a*', 'no separator before the first section when nothing is pinned');
});
test('items: recents off puts running apps after the pinned ones without a separator', () => {
    const items = dockItems({ pinned: ['files'], running: ['calc'], recents: ['music'], showRecents: false, downloads: false });
    eq(kinds(items), ['pinned:files', 'running:calc*', 'separator', 'trash']);
});
test('items: minimized windows get tiles before the stack', () => {
    const items = dockItems({ pinned: [], running: [], recents: [], showRecents: true, minimized: [7] });
    eq(items.map(i => i.id), ['separator-system', 'window-7', 'downloads', 'trash']);
});
test('recents: newest first, deduplicated, capped', () => {
    let r = [];
    for (const id of ['a', 'b', 'a', 'c', 'd'])
        r = pushRecent(r, id);
    eq(r, ['d', 'c', 'a']);
    eq(r.length, RECENT_MAX);
    eq(pushRecent(r, null), r);
});
test('stable order: focus changes do not reorder running icons', () => {
    eq(stableOrder(['a', 'b', 'c'], ['c', 'a', 'd']), ['a', 'c', 'd']);
});

// ---- clicks
const w = (id, minimized = false) => ({ id, minimized });
test('click: launch, activate, nothing on the focused single-window app', () => {
    eq(clickAction({ windows: [], focused: false, button: 1, canNewWindow: true }).type, 'launch');
    eq(clickAction({ windows: [w(3), w(4)], focused: false, focusedWindow: null, button: 1 }), { type: 'activate', windowId: 3 });
    eq(clickAction({ windows: [w(3)], focused: true, focusedWindow: 3, button: 1 }).type, 'none');
});
test('click: the focused app with several windows cycles through all of them', () => {
    const wins = [w(1), w(2), w(3)];
    eq(clickAction({ windows: wins, focused: true, focusedWindow: 1, button: 1 }), { type: 'activate', windowId: 3 });
    eq(nextWindow([w(3), w(1), w(2)], 3), 2);
    eq(nextWindow([], 1), null);
});
test('click: a focused app with one visible and one minimized window does nothing; cycling skips minimized', () => {
    eq(clickAction({ windows: [w(1), w(2, true)], focused: true, focusedWindow: 1, button: 1 }).type, 'none');
    eq(clickAction({ windows: [w(1), w(2, true), w(3)], focused: true, focusedWindow: 1, button: 1 }),
        { type: 'activate', windowId: 3 });
});
test('a write to a partial download is not worth a re-read; its creation or removal is', () => {
    eq(isPartialWrite('big.iso.part', true), true);
    eq(isPartialWrite('a.crdownload', true), true);
    eq(isPartialWrite('big.iso.part', false), false);
    eq(isPartialWrite('notes.txt', true), false);
});
test('click: a minimized-only app is brought back; middle click opens a new window', () => {
    eq(clickAction({ windows: [w(5, true)], focused: false, button: 1 }), { type: 'activate', windowId: 5 });
    eq(clickAction({ windows: [w(5)], focused: true, focusedWindow: 5, button: 2, canNewWindow: true }).type, 'new-window');
    eq(clickAction({ windows: [], focused: false, button: 2, canNewWindow: false }).type, 'launch');
});

// ---- menu
const menuBase = {
    windows: [], focusedWindow: null, actions: [], canNewWindow: true, pinned: true,
    hasDesktopFile: true, autostart: { enabled: false, editable: true }, alt: false,
};
test('menu: a running app lists its windows, actions, New Window, Options and Quit', () => {
    const m = menuEntries({
        ...menuBase, windows: [{ id: 1, title: 'Doc', minimized: false }, { id: 2, title: 'Min', minimized: true }],
        focusedWindow: 1, actions: [{ id: 'new-private', name: 'New Private Window' }],
    });
    eq(m.map(e => e.type), ['window', 'window', 'separator', 'action', 'new-window', 'separator', 'options', 'separator', 'quit']);
    eq([m[0].focused, m[1].minimized], [true, true]);
    eq(m.find(e => e.type === 'options').items.map(i => i.type), ['keep-in-dock', 'open-at-login', 'show-in-files']);
});
test('menu: the app\'s own new-window action is not listed twice', () => {
    const m = menuEntries({ ...menuBase, windows: [{ id: 1, title: 'x' }], actions: [{ id: 'new-window', name: 'New Window' }] });
    eq(m.filter(e => e.type === 'action').length, 0);
    eq(menuEntries({ ...menuBase, actions: [{ id: 'new-window', name: 'New Window' }] })[0].type, 'action');
});
test('menu: not running shows Open and no Quit; Alt turns Quit into Force Quit', () => {
    eq(menuEntries(menuBase).map(e => e.type), ['open', 'separator', 'options']);
    const alt = menuEntries({ ...menuBase, windows: [{ id: 1, title: 'x' }], alt: true });
    eq(alt[alt.length - 1].type, 'force-quit');
});
test('menu: window-backed apps cannot be kept or opened at login', () => {
    const m = menuEntries({ ...menuBase, hasDesktopFile: false, windows: [{ id: 1, title: 'x' }] });
    eq(m.find(e => e.type === 'options').items.map(i => i.sensitive), [false, false, false]);
});

// ---- drag and drop
test('drop index and pin position', () => {
    eq(dropIndex([10, 30, 50], 5), 0);
    eq(dropIndex([10, 30, 50], 31), 2);
    eq(dropIndex([10, 30, 50], 99), 3);
    eq(pinPosition(['a', 'b'], 7), 2);
    eq(pinPosition(['a', 'b'], -1), 0);
});

// ---- Downloads stack
test('packages get badges; partial downloads do not', () => {
    eq(['x.rpm', 'a.flatpakref', 'b.flatpak', 'Tool.AppImage', 'doc.pdf'].map(packageKind), ['rpm', 'flatpak', 'flatpak', 'appimage', null]);
    const part = downloadEntry({ name: 'big.rpm.part', changed: 5 });
    eq([part.partial, part.badge, part.label], [true, null, 'big.rpm']);
});
test('entries: hidden and backup files are skipped; Date Added prefers ctime/birth time', () => {
    eq(downloadEntry({ name: '.secret' }), null);
    eq(downloadEntry({ name: 'x', backup: true }), null);
    eq(downloadEntry({ name: 'a', changed: 10, created: 20, modified: 99 }).added, 20);
    eq(downloadEntry({ name: 'a', modified: 7 }).added, 7);
});
test('sort: newest first, names break ties', () => {
    const e = n => downloadEntry({ name: n[0], changed: n[1] });
    eq(sortDownloads([e(['b', 1]), e(['c', 3]), e(['a', 1])]).map(x => x.name), ['c', 'a', 'b']);
});
test('a partial file turning final is a finished download', () => {
    const before = [downloadEntry({ name: 'a.rpm.crdownload', changed: 1 })];
    eq(downloadFinished(before, [downloadEntry({ name: 'a.rpm', changed: 2 })]), true);
    eq(downloadFinished(before, before), false);
    eq(downloadFinished([], [downloadEntry({ name: 'a.rpm' })]), false);
});
test('stack view: Automatic fans a short stack from a bottom dock; side docks never fan', () => {
    eq(stackView('automatic', 'bottom', 4), 'fan');
    eq(stackView('automatic', 'bottom', 40), 'grid');
    eq(stackView('automatic', 'left', 4), 'grid');
    eq(stackView('fan', 'right', 4), 'list');
    eq(stackView('list', 'bottom', 4), 'list');
});
test('fan rows rise, drift right and turn more as they go', () => {
    const rows = fanLayout(4, 50);
    eq(rows.map(r => r.dy), [-50, -100, -150, -200]);
    eq(rows.every((r, i) => i === 0 || (r.dx >= rows[i - 1].dx && r.angle > rows[i - 1].angle)), true);
});

// ---- Open at Login
test('autostart state: none, Guava-made, the user\'s own (read only), disabled', () => {
    eq(autostartState(null), { enabled: false, guava: false, editable: true });
    eq(autostartState(`[Desktop Entry]\nName=A\n${AUTOSTART_MARK}=true\n`), { enabled: true, guava: true, editable: true });
    eq(autostartState('[Desktop Entry]\nName=A\n'), { enabled: true, guava: false, editable: false });
    eq(autostartState('[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n').enabled, false);
    eq(autostartState('[Desktop Entry]\nName=A\n[Desktop Action x]\nHidden=true\n').enabled, true);
});
test('autostart text: the app entry, marked, without keys that stop it', () => {
    const t = autostartText('[Desktop Entry]\nName=Calc\nHidden=true\nExec=calc\n[Desktop Action new]\nName=New\n');
    eq(t, `[Desktop Entry]\n${AUTOSTART_MARK}=true\nName=Calc\nExec=calc\n[Desktop Action new]\nName=New\n`);
    eq(autostartState(t), { enabled: true, guava: true, editable: true });
});

// ---- auto-hide
test('reveal: off is always visible', () => {
    const r = new Reveal(false);
    eq([r.visible, r.wantsTimer], [true, false]);
});
test('reveal: edge arms the delay, reveal shows, leaving hides', () => {
    const r = new Reveal(true);
    eq(r.settle(), false);
    r.edge(true);
    eq(r.wantsTimer, true);
    r.reveal();
    eq([r.settle(), r.wantsTimer], [true, false]);
    // leave the edge and enter the dock in one batch: never hidden in between
    r.edge(false);
    r.dock(true);
    eq(r.settle(), true);
    r.dock(false);
    eq(r.settle(), false);
});
test('reveal: a menu or drag holds the dock up after the pointer leaves', () => {
    const r = new Reveal(true);
    r.reveal();
    r.dock(true);
    r.settle();
    r.hold();
    r.dock(false);
    eq(r.settle(), true);
    r.unhold();
    eq(r.settle(), false);
    r.unhold();
    eq(r.holds, 0);
});
test('reveal: leaving the edge before the delay disarms it', () => {
    const r = new Reveal(true);
    r.edge(true);
    r.edge(false);
    eq([r.wantsTimer, r.settle()], [false, false]);
});

// ---- P2: background apps and folder stacks
test('items: a background app shows with a grey dot, pinned or not', () => {
    const items = dockItems({
        pinned: ['files', 'mail'], running: ['files'], recents: [], showRecents: false,
        background: ['mail', 'chat', 'files'], downloads: false,
    });
    const apps = items.filter(i => i.kind === 'app').map(i => `${i.id}:${i.running ? 'run' : 'off'}${i.background ? ':bg' : ''}`);
    eq(apps, ['files:run', 'mail:run:bg', 'chat:run:bg']);
});
test('items: folder stacks follow Downloads, once each, before the Trash', () => {
    const items = dockItems({ pinned: [], running: [], recents: [], showRecents: true, folders: ['/a', '/b', '/a'] });
    eq(items.map(i => i.id), ['separator-system', 'downloads', 'folder:/a', 'folder:/b', 'trash']);
});
test('folders: add once, never Downloads or a relative path; remove', () => {
    const f = ['/a'];
    eq(addFolder(f, '/b', '/d'), ['/a', '/b']);
    if (addFolder(f, '/a', '/d') !== f || addFolder(f, '/d', '/d') !== f || addFolder(f, 'x', '/d') !== f)
        throw new Error('unchanged list must be returned as is');
    eq(removeFolder(['/a', '/b'], '/a'), ['/b']);
});
test('folders: only the right side of the dock takes a folder', () => {
    eq([folderDropAccepted(500, 400), folderDropAccepted(300, 400), folderDropAccepted(500, null)], [true, false, false]);
});
test('menu: a background-only app offers Stop Running in Background, not Quit', () => {
    const e = menuEntries({
        windows: [], focusedWindow: null, actions: [], canNewWindow: true, pinned: true,
        hasDesktopFile: true, autostart: { enabled: false, editable: true }, alt: false, background: true,
    });
    eq(e.map(x => x.type).slice(-2), ['separator', 'stop-background']);
});

// ---- P2: magnification
const mk = (n, tile = 60) => {
    const centres = Array.from({ length: n }, (_, i) => tile * i + tile / 2);
    return { centres, sizes: centres.map(() => tile), weights: centres.map(() => 1), count: n, tile };
};
const out = n => ({ scales: new Array(n), offsets: new Array(n), before: 0, after: 0 });
test('magnify: the icon under the pointer reaches the max; a cosine falloff; none far away', () => {
    const p = mk(12);
    const o = magnify({ ...p, pointer: p.centres[5], maxScale: 2, amount: 1 }, out(12));
    eq(o.scales[5], 2);
    if (!(o.scales[4] < 2 && o.scales[4] > o.scales[3] && o.scales[3] > 1))
        throw new Error(`falloff ${o.scales.slice(2, 6)}`);
    eq(o.scales[0], 1);
    eq(o.scales[11], 1);
    // symmetric
    if (Math.abs(o.scales[4] - o.scales[6]) > 1e-9)
        throw new Error('not symmetric');
});
test('magnify: icons stay edge to edge and the point under the pointer does not move', () => {
    const p = mk(10);
    for (const pointer of [37, 125, 300.5, 590]) {
        const o = magnify({ ...p, pointer, maxScale: 1.8, amount: 1 }, out(10));
        for (let i = 1; i < 10; i++) {
            const prevEnd = p.centres[i - 1] + o.offsets[i - 1] + (p.sizes[i - 1] * o.scales[i - 1]) / 2;
            const start = p.centres[i] + o.offsets[i] - (p.sizes[i] * o.scales[i]) / 2;
            if (Math.abs(prevEnd - start) > 1e-6)
                throw new Error(`gap at ${i} for pointer ${pointer}`);
        }
        // The item under the pointer: the same fraction of it stays under the pointer
        const i = Math.min(9, Math.floor(pointer / 60));
        const frac = (pointer - (p.centres[i] - 30)) / 60;
        const now = p.centres[i] + o.offsets[i] - (60 * o.scales[i]) / 2 + frac * 60 * o.scales[i];
        if (Math.abs(now - pointer) > 1e-6)
            throw new Error(`pointer ${pointer} drifted to ${now}`);
        if (Math.abs(o.before + o.after - p.sizes.reduce((a, s, k) => a + (o.scales[k] - 1) * s, 0)) > 1e-6)
            throw new Error('growth does not add up');
    }
});
test('magnify: continuous in the pointer (no jumps between neighbours)', () => {
    const p = mk(8);
    let prev = null;
    for (let x = 0; x <= 480; x += 0.5) {
        const o = magnify({ ...p, pointer: x, maxScale: 2, amount: 1 }, out(8));
        if (prev) {
            for (let i = 0; i < 8; i++) {
                if (Math.abs(o.offsets[i] - prev[i]) > 2)
                    throw new Error(`jump at ${x}`);
            }
        }
        prev = [...o.offsets];
    }
});
test('magnify: amount 0 is the rest layout; separators do not grow', () => {
    const p = mk(5);
    const o = magnify({ ...p, pointer: 150, maxScale: 2, amount: 0 }, out(5));
    eq([...o.scales], [1, 1, 1, 1, 1]);
    eq([o.before, o.after], [0, 0]);
    const q = { ...p, weights: [1, 1, 0, 1, 1] };
    eq(magnify({ ...q, pointer: 150, maxScale: 2, amount: 1 }, out(5)).scales[2], 1);
    eq([magnifyScale(48, 96), magnifyScale(64, 48)], [2, 1]);
});

// ---- P2: bounce and badges
test('bounce: launches bounce until up, at most LAUNCH_BOUNCES_MAX; attention a few times', () => {
    eq(bounceAgain('launch', 3, true), true);
    eq(bounceAgain('launch', LAUNCH_BOUNCES_MAX, true), false);
    eq(bounceAgain('launch', 1, false), false);
    eq(bounceAgain('attention', ATTENTION_BOUNCES, true), false);
    eq(bounceAgain('download', 1, false), false);
    eq(bounceSteps(60).height, 30);
});
test('badges: counts shown only when visible and positive; capped; progress clamped', () => {
    eq(badgeText({ count: 3, countVisible: true }), '3');
    eq(badgeText({ count: 3, countVisible: false }), null);
    eq(badgeText({ count: 0, countVisible: true }), null);
    eq(badgeText({ count: 123456, countVisible: true }), '9999+');
    eq(badgeText(null), null);
    eq(badgeProgress({ progress: 1.4, progressVisible: true }), 1);
    eq(badgeProgress({ progress: 0.4, progressVisible: false }), null);
    eq(badgeProgress({ progress: NaN, progressVisible: true }), null);
});
test('dockItems: the Launchpad tile comes first when asked', () => {
    const items = dockItems({ pinned: ['a'], running: [], recents: [], showRecents: false, launchpad: true });
    eq(items[0], { kind: 'launchpad', id: 'launchpad' });
    eq(dockItems({ pinned: ['a'], running: [], recents: [], showRecents: false })[0].kind, 'app');
});
test('items: the optional Mission Control tile sits after the pinned apps', () => {
    const items = dockItems({ pinned: ['files'], running: ['calc'], recents: [], showRecents: false, missionControl: true });
    eq(items.map(i => i.kind), ['app', 'mission-control', 'app', 'separator', 'downloads', 'trash']);
    eq(dockItems({ pinned: ['files'], running: [], recents: [], showRecents: false }).some(i => i.kind === 'mission-control'), false);
});
test('menu: Show All Windows (App Exposé) before Quit, only when running and offered', () => {
    const m = menuEntries({ ...menuBase, windows: [{ id: 1, title: 'x' }], showAllWindows: true });
    eq(m.slice(-2).map(e => e.type), ['show-all-windows', 'quit']);
    eq(menuEntries({ ...menuBase, windows: [{ id: 1, title: 'x' }] }).some(e => e.type === 'show-all-windows'), false);
    eq(menuEntries({ ...menuBase, showAllWindows: true }).some(e => e.type === 'show-all-windows'), false);
});

test('rectContains: inside, the far edges excluded, null holds nothing', () => {
    const r = { x: 10, y: 20, width: 30, height: 40 };
    eq(rectContains(r, 10, 20), true);
    eq(rectContains(r, 39, 59), true);
    eq(rectContains(r, 40, 30), false);
    eq(rectContains(r, 20, 60), false);
    eq(rectContains(null, 0, 0), false);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
