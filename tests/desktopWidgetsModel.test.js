// Run: gjs -m tests/desktopWidgetsModel.test.js
import { DIM_OPACITY, galleryRect, isDrag, widgetLook, widgetsLive, windowInFront } from '../features/widgets/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const full = { mono: false, opacity: 255 };
const dim = { mono: true, opacity: DIM_OPACITY };

test('automatic dims while a window is in front and not while editing', () => {
    eq(widgetLook({ style: 'automatic', windowInFront: true, editing: false, highContrast: false }), dim);
    eq(widgetLook({ style: 'automatic', windowInFront: false, editing: false, highContrast: false }), full);
    eq(widgetLook({ style: 'automatic', windowInFront: true, editing: true, highContrast: false }), full);
});
test('monochrome always dims, full colour never, high contrast never', () => {
    eq(widgetLook({ style: 'monochrome', windowInFront: false, editing: false, highContrast: false }), dim);
    eq(widgetLook({ style: 'full-color', windowInFront: true, editing: false, highContrast: false }), full);
    eq(widgetLook({ style: 'monochrome', windowInFront: true, editing: false, highContrast: true }), full);
    eq(widgetLook({ style: 'bogus', windowInFront: true, editing: false, highContrast: false }), dim);
});
test('only a focused, shown app window is in front', () => {
    eq(windowInFront(null), false);
    eq(windowInFront({ type: 'normal', minimized: false }), true);
    eq(windowInFront({ type: 'dialog', minimized: false }), true);
    eq(windowInFront({ type: 'normal', minimized: true }), false);
    eq(windowInFront({ type: 'other', minimized: false }), false);
});
test('data pauses in the overview and under a maximized window of that monitor', () => {
    const w = (o = {}) => ({ monitor: 0, workspace: 0, minimized: false, maximized: false, fullscreen: false, type: 'normal', ...o });
    const base = { overview: false, editing: false, monitor: 0, workspace: 0 };
    eq(widgetsLive({ ...base, windows: [w()] }), true);
    eq(widgetsLive({ ...base, windows: [w({ maximized: true })] }), false);
    eq(widgetsLive({ ...base, windows: [w({ fullscreen: true, workspace: -1 })] }), false);
    eq(widgetsLive({ ...base, windows: [w({ maximized: true, minimized: true })] }), true);
    eq(widgetsLive({ ...base, windows: [w({ maximized: true, monitor: 1 })] }), true);
    eq(widgetsLive({ ...base, windows: [w({ maximized: true, workspace: 1 })] }), true);
    eq(widgetsLive({ ...base, overview: true, windows: [] }), false);
    eq(widgetsLive({ ...base, overview: true, editing: true, windows: [w({ maximized: true })] }), true);
});
test('a drag starts past the threshold', () => {
    eq(isDrag(3, 4), false);
    eq(isDrag(6, 6), true);
});
test('the gallery sits centred at the bottom and fits small screens', () => {
    eq(galleryRect({ x: 0, y: 32, width: 1280, height: 700 }), { x: 100, y: 336, width: 1080, height: 380 });
    const r = galleryRect({ x: 0, y: 0, width: 400, height: 300 });
    eq([r.width, r.height], [368, 268]);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
