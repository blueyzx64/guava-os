// Run: gjs -m tests/greenButtonModel.test.js
// The green button: which maximize requests mean "full screen".
import {
    BUTTON_PX, EDGE_PAD_PX, SETTLE_MS, TITLEBAR_PX, buttonBand, greenButtonAction,
} from '../features/appButtons/greenButtonModel.js';

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

const RIGHT = { buttons: ['minimize', 'maximize', 'close'], side: 'right' };
const LEFT = { buttons: ['close', 'minimize', 'maximize'], side: 'left' };
const FRAME = { x: 290, y: 150, width: 700, height: 450 };
const W = 3 * BUTTON_PX + EDGE_PAD_PX;

// --- buttonBand
test('right side band hugs the right edge', () =>
    eq(buttonBand(FRAME, RIGHT), { x: 290 + 700 - W, y: 150, width: W, height: TITLEBAR_PX }));
test('left side band hugs the left edge', () =>
    eq(buttonBand(FRAME, LEFT), { x: 290, y: 150, width: W, height: TITLEBAR_PX }));
test('no maximize button: no band', () =>
    eq(buttonBand(FRAME, { buttons: ['close'], side: 'right' }), null));
test('a tiny window clamps the band', () =>
    eq(buttonBand({ x: 0, y: 0, width: 100, height: 40 }, RIGHT), { x: 0, y: 0, width: 100, height: 40 }));

// --- greenButtonAction. Pointer positions from the Shell 50.6 prototype (GTK 4 headerbar)
const band = buttonBand(FRAME, RIGHT);
const base = {
    maximized: true, wasMaximized: false, fullscreen: false, hasEvent: false, grabbing: false,
    ageMs: Infinity, pointer: { x: 917, y: 173 }, band,
};
test('client maximize with the pointer on the button: enter full screen', () =>
    eq(greenButtonAction(base), 'enter'));
test('green button on a zoomed window (unmaximize request): enter full screen', () =>
    eq(greenButtonAction({ ...base, maximized: false, wasMaximized: true,
        band: buttonBand({ x: 0, y: 32, width: 1280, height: 686 }, RIGHT), pointer: { x: 1214, y: 55 } }), 'enter'));
test('maximize request on a full-screen window: leave full screen', () =>
    eq(greenButtonAction({ ...base, fullscreen: true,
        band: buttonBand({ x: 0, y: 0, width: 1280, height: 800 }, RIGHT), pointer: { x: 1250, y: 20 } }), 'leave'));
test('double-click on the middle of the titlebar stays Zoom', () =>
    eq(greenButtonAction({ ...base, pointer: { x: 640, y: 168 } }), null));
test('Super+Up (a key event is being handled) stays maximize', () =>
    eq(greenButtonAction({ ...base, hasEvent: true }), null));
test('a drag (grab op) stays maximize/unmaximize', () =>
    eq(greenButtonAction({ ...base, grabbing: true }), null));
test('an app restoring its maximized state at start stays maximized', () =>
    eq(greenButtonAction({ ...base, ageMs: SETTLE_MS - 1 }), null));
test('a programmatic maximize with the pointer elsewhere stays maximize', () =>
    eq(greenButtonAction({ ...base, pointer: { x: 0, y: 0 } }), null));
test('no maximize button in the layout: nothing', () =>
    eq(greenButtonAction({ ...base, band: null }), null));
test('no change of state: nothing', () =>
    eq(greenButtonAction({ ...base, wasMaximized: true }), null));
test('unknown age is not settled', () =>
    eq(greenButtonAction({ ...base, ageMs: NaN }), null));
test('pointer just below the titlebar band: nothing', () =>
    eq(greenButtonAction({ ...base, pointer: { x: 917, y: 150 + TITLEBAR_PX } }), null));

if (failed)
    throw new Error(`${failed} failed`);
