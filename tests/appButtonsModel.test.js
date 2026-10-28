// Run: gjs -m tests/appButtonsModel.test.js
// The apps' own titlebar buttons: layout, GTK sheets, and the owner of the WM button-layout.
import {
    parseButtonLayout, gtkSheets, appButtonsLayout,
} from '../features/appButtons/model.js';
import { ButtonLayoutOwner, WM_SCHEMA } from '../features/appButtons/buttonLayout.js';
import { OriginalsStore, STORE_KEY, restoreStale, originalId } from '../core/originals.js';
import { createJobQueue } from '../lib/jobQueue.js';

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

// --- parseButtonLayout
test('gnome default layout is right', () =>
    eq(parseButtonLayout('appmenu:close'), { buttons: ['close'], side: 'right' }));
test('right side with three buttons', () =>
    eq(parseButtonLayout(':minimize,maximize,close'),
        { buttons: ['minimize', 'maximize', 'close'], side: 'right' }));
test('left side layout', () =>
    eq(parseButtonLayout('close,minimize,maximize:'),
        { buttons: ['close', 'minimize', 'maximize'], side: 'left' }));
test('tie goes left', () =>
    eq(parseButtonLayout('close:minimize'), { buttons: ['close'], side: 'left' }));
test('more on the right wins', () =>
    eq(parseButtonLayout('close:minimize,maximize'), { buttons: ['minimize', 'maximize'], side: 'right' }));
test('no buttons falls back to the GNOME order on the right', () =>
    eq(parseButtonLayout('appmenu:'), { buttons: ['minimize', 'maximize', 'close'], side: 'right' }));
test('duplicates and junk are dropped', () =>
    eq(parseButtonLayout('close,close,spacer,icon:'), { buttons: ['close'], side: 'left' }));
test('empty string', () =>
    eq(parseButtonLayout('').side, 'right'));

// --- ButtonLayoutOwner (fake settings)
function fakeSettings(values, schemaId = 'org.gnome.shell.extensions.guava-os') {
    const handlers = new Map();
    let next = 1;
    return {
        schema_id: schemaId,
        values,
        get_string: k => values[k],
        set_string(k, v) {
            values[k] = v;
            for (const [, h] of handlers) {
                if (h.sig === `changed::${k}`)
                    h.fn();
            }
        },
        connect(sig, fn) {
            handlers.set(next, { sig, fn });
            return next++;
        },
        disconnect: id => handlers.delete(id),
        get nHandlers() {
            return handlers.size;
        },
    };
}
const wmSettings = values => fakeSettings(values, WM_SCHEMA);
const LAYOUT_ID = originalId(WM_SCHEMA, 'button-layout');
// The user's layout as the originals store holds it ('' when none is stored)
const saved = guava => (guava.values[STORE_KEY] ? JSON.parse(guava.values[STORE_KEY])[LAYOUT_ID]?.value ?? '' : '');
const guavaWith = layout => fakeSettings({ [STORE_KEY]: JSON.stringify({ [LAYOUT_ID]: { type: 's', value: layout } }) });
const apps = orig => appButtonsLayout(orig);
test('owner saves, sets the app buttons and restores exactly', () => {
    const guava = fakeSettings({ [STORE_KEY]: '' });
    const wm = wmSettings({ 'button-layout': 'appmenu:minimize,close' });
    const o = new ButtonLayoutOwner(new OriginalsStore(guava), wm, () => {}, apps);
    o.sync(true);
    eq(wm.values['button-layout'], 'appmenu:minimize,maximize,close');
    eq(saved(guava), 'appmenu:minimize,close');
    eq(o.original, 'appmenu:minimize,close');
    o.sync(false);
    eq(wm.values['button-layout'], 'appmenu:minimize,close');
    eq(saved(guava), '');
    eq(wm.nHandlers, 0);
});
test('owner: user change while owned becomes the new original', () => {
    const guava = fakeSettings({ [STORE_KEY]: '' });
    const wm = wmSettings({ 'button-layout': 'appmenu:close' });
    let notified = 0;
    const o = new ButtonLayoutOwner(new OriginalsStore(guava), wm, () => notified++, apps);
    o.sync(true);
    wm.set_string('button-layout', 'close,minimize,maximize:');
    eq(o.original, 'close,minimize,maximize:');
    eq(notified, 1);
    o.release();
    eq(wm.values['button-layout'], 'close,minimize,maximize:');
});
test('owner: release when not owning is a no-op', () => {
    const guava = fakeSettings({ [STORE_KEY]: '' });
    const wm = wmSettings({ 'button-layout': 'appmenu:close' });
    new ButtonLayoutOwner(new OriginalsStore(guava), wm, () => {}, apps).release();
    eq(wm.values['button-layout'], 'appmenu:close');
});
test('stale saved layout is restored once', () => {
    const guava = guavaWith('appmenu:close');
    const wm = wmSettings({ 'button-layout': 'appmenu:' });
    const store = new OriginalsStore(guava);
    eq(restoreStale(store, id => (id === WM_SCHEMA ? wm : null)), [LAYOUT_ID]);
    eq(wm.values['button-layout'], 'appmenu:close');
    eq(saved(guava), '');
    eq(restoreStale(store, () => wm), []);
});
test('owner after a crash keeps the saved original, not the live value Guava set', () => {
    const guava = guavaWith('appmenu:close');
    const wm = wmSettings({ 'button-layout': 'appmenu:' });
    const o = new ButtonLayoutOwner(new OriginalsStore(guava), wm, () => {}, apps);
    o.sync(true);
    eq(o.original, 'appmenu:close');
    o.sync(false);
    eq(wm.values['button-layout'], 'appmenu:close');
});

// --- migration: a user who had the top-bar window controls on (the buttons were stripped from
// the layout while a window was maximized) gets a normal layout, with the buttons on their side
test('removed top-bar controls: the stripped layout of the old build is restored, then the buttons are on the side', () => {
    // The old build crashed or was replaced with the layout stripped: the originals store holds
    // the user's own layout, the live one has no buttons
    const guava = guavaWith('appmenu:close');
    const wm = wmSettings({ 'button-layout': 'appmenu:' });
    const stale = restoreStale(new OriginalsStore(guava), id => (id === WM_SCHEMA ? wm : null));
    eq(stale, [LAYOUT_ID]);
    eq(wm.values['button-layout'], 'appmenu:close');
    // Normal start: the right side (the default), all three buttons
    const o = new ButtonLayoutOwner(new OriginalsStore(guava), wm, () => {},
        orig => appButtonsLayout(orig, { position: 'right', set: 'all' }));
    o.sync(true);
    eq(wm.values['button-layout'], 'appmenu:minimize,maximize,close');
    // The macOS side puts them on the left and the app menu opposite
    const leftWm = wmSettings({ 'button-layout': 'appmenu:close' });
    const left = new ButtonLayoutOwner(new OriginalsStore(fakeSettings({ [STORE_KEY]: '' })), leftWm, () => {},
        orig => appButtonsLayout(orig, { position: 'left', set: 'all' }));
    left.sync(true);
    eq(leftWm.values['button-layout'], 'close,minimize,maximize:appmenu');
    left.release();
    // Disable gives the user's layout back exactly
    o.release();
    eq(wm.values['button-layout'], 'appmenu:close');
    eq(saved(guava), '');
    // Enable again takes it once more, with the same original
    o.sync(true);
    eq(wm.values['button-layout'], 'appmenu:minimize,maximize,close');
    o.release();
    eq(wm.values['button-layout'], 'appmenu:close');
});

// --- gtkSheets: one traffic-light set, the app fixes last
const cfg = o => ({ style: 'macos', size: 'normal', appFixes: false, ...o });
test('gtkSheets: macOS style, small size, fixes last', () =>
    eq(gtkSheets(cfg({ size: 'small', appFixes: true }), '4'),
        ['titlebuttons4.css', 'titlebuttons-size-small4.css', 'fixes4.css']));
test('gtkSheets: GNOME style imports no button set', () =>
    eq(gtkSheets(cfg({ style: 'gnome' }), '3'), []));
test('gtkSheets: never a sheet that hides the titlebar buttons', () => {
    for (const style of ['macos', 'gnome'])
        for (const v of ['3', '4'])
            eq(gtkSheets(cfg({ style, appFixes: true }), v).some(n => n.startsWith('hide-')), false);
});

// --- app buttons (UX round 2, #8)
const AB = (orig, position, set) => appButtonsLayout(orig, { position, set });
test('app buttons: stock appmenu:close, all combinations', () => {
    eq(AB('appmenu:close', 'right', 'all'), 'appmenu:minimize,maximize,close');
    eq(AB('appmenu:close', 'left', 'all'), 'close,minimize,maximize:appmenu');
    eq(AB('appmenu:close', 'right', 'close'), 'appmenu:close');
    eq(AB('appmenu:close', 'left', 'close'), 'close:appmenu');
});
test('app buttons: defaults are right + all', () =>
    eq(appButtonsLayout('appmenu:close'), 'appmenu:minimize,maximize,close'));
test('app buttons: a left (macOS) original, all combinations', () => {
    eq(AB('close,minimize,maximize:appmenu', 'left', 'all'), 'close,minimize,maximize:appmenu');
    eq(AB('close,minimize,maximize:appmenu', 'right', 'all'), 'appmenu:minimize,maximize,close');
    eq(AB('close,minimize,maximize:appmenu', 'left', 'close'), 'close:appmenu');
    eq(AB('close,minimize,maximize:appmenu', 'right', 'close'), 'appmenu:close');
});
test('app buttons: other items kept in place on the same side', () => {
    eq(AB('icon,appmenu:spacer,close', 'right', 'all'), 'icon,appmenu:spacer,minimize,maximize,close');
    eq(AB('close,spacer:icon', 'left', 'all'), 'close,minimize,maximize,spacer:icon');
});
test('app buttons: other items mirrored when the side flips', () => {
    eq(AB('icon,appmenu:spacer,close', 'left', 'all'), 'close,minimize,maximize,spacer:appmenu,icon');
    eq(AB('close,spacer:icon', 'right', 'all'), 'icon:spacer,minimize,maximize,close');
});
test('app buttons: stripped or empty originals', () => {
    eq(AB('appmenu:', 'right', 'all'), 'appmenu:minimize,maximize,close');
    eq(AB('appmenu:', 'left', 'all'), 'close,minimize,maximize:appmenu');
    eq(AB('', 'right', 'all'), ':minimize,maximize,close');
    eq(AB(':', 'left', 'all'), 'close,minimize,maximize:');
    eq(AB(null, 'left', 'close'), 'close:');
});
test('app buttons: user button order and duplicates replaced by the full set', () =>
    eq(AB('maximize,close,close:appmenu', 'left', 'all'), 'close,minimize,maximize:appmenu'));
test('app buttons: idempotent on its own output', () => {
    for (const orig of ['appmenu:close', 'close,minimize,maximize:', 'icon:spacer,close', ''])
        for (const pos of ['right', 'left'])
            for (const set of ['all', 'close']) {
                const once = AB(orig, pos, set);
                eq(AB(once, pos, set), once);
            }
});
test('app buttons: unknown position falls back to right', () =>
    eq(AB('appmenu:close', 'middle', 'all'), 'appmenu:minimize,maximize,close'));
test('owner with the app-buttons transform: take, reapply, restore exactly', () => {
    const guava = fakeSettings({ [STORE_KEY]: '' });
    const wm = wmSettings({ 'button-layout': 'appmenu:close' });
    let position = 'right';
    const o = new ButtonLayoutOwner(new OriginalsStore(guava), wm, () => {}, orig => appButtonsLayout(orig, { position }));
    o.sync(true);
    eq(wm.values['button-layout'], 'appmenu:minimize,maximize,close');
    eq(saved(guava), 'appmenu:close');
    position = 'left';
    o.reapply();
    eq(wm.values['button-layout'], 'close,minimize,maximize:appmenu');
    eq(saved(guava), 'appmenu:close');
    o.release();
    eq(wm.values['button-layout'], 'appmenu:close');
    eq(saved(guava), '');
    eq(wm.nHandlers, 0);
});
test('owner reapply while not owning does nothing', () => {
    const wm = wmSettings({ 'button-layout': 'appmenu:close' });
    new ButtonLayoutOwner(new OriginalsStore(fakeSettings({ [STORE_KEY]: '' })), wm, () => {}, () => 'x:y').reapply();
    eq(wm.values['button-layout'], 'appmenu:close');
});
try {
    const q = createJobQueue(() => {});
    const log = [];
    let running = 0;
    const job = (name, ms, fail) => () => new Promise((res, rej) => {
        running++;
        if (running > 1) log.push('OVERLAP');
        setTimeout(() => { running--; log.push(name); fail ? rej(new Error('x')) : res(); }, ms);
    });
    q(job('a', 20, true));
    q(job('b', 1));
    await q(job('c', 1));
    eq(log, ['a', 'b', 'c']);
    print('ok   job queue: no overlap, failure does not stop the next');
} catch (e) {
    failed++;
    print(`FAIL job queue: ${e.message}`);
}

if (failed)
    throw new Error(`${failed} failed`);
