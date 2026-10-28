// Run: gjs -m tests/shelfHelperModel.test.js
// features/notch/shelfHelperModel.js: talking to the shelf drag-out helper.
import { HELPER, CLEAR_LINE, isHelperWindow, layoutOf, parseEvent, pointerOnNotch, dragIconName } from '../features/notch/shelfHelperModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('the helper window is matched by class and title together', () => {
    eq(isHelperWindow(HELPER.appId, HELPER.title), true);
    eq(isHelperWindow(HELPER.appId, 'Other'), false);
    eq(isHelperWindow('org.gnome.Nautilus', HELPER.title), false);
    eq(isHelperWindow(null, null), false);
});

test('layout: item boxes are relative to the window, whole pixels', () => {
    const { box, line } = layoutOf({ x: 100.4, y: 80.6, w: 300.2, h: 90 }, [
        { uri: 'file:///a', icon: 'text-x-generic', x: 100.4, y: 80.6, w: 70, h: 80 },
        { uri: 'file:///b', icon: '', x: 178.4, y: 80.6, w: 70, h: 80 },
    ]);
    eq(box, { x: 100, y: 81, w: 300, h: 90 });
    eq(JSON.parse(line), {
        type: 'layout', w: 300, h: 90, items: [
            { uri: 'file:///a', icon: 'text-x-generic', x: 0, y: 0, w: 70, h: 80 },
            { uri: 'file:///b', icon: '', x: 78, y: 0, w: 70, h: 80 },
        ],
    });
});

test('layout: never a zero-sized box', () => {
    const { box } = layoutOf({ x: 0, y: 0, w: 0, h: 0 }, []);
    eq([box.w, box.h], [1, 1]);
    eq(JSON.parse(CLEAR_LINE).items, []);
});

test('events: known ones parse, anything else is null', () => {
    eq(parseEvent('{"event":"click","uri":"file:///a"}'), { event: 'click', uri: 'file:///a' });
    eq(parseEvent('{"event":"drag","state":"begin","uri":"file:///a","ok":true}'), { event: 'drag', state: 'begin', uri: 'file:///a', ok: true });
    eq(parseEvent('{"event":"drag","state":"end","uri":"file:///a","ok":false}').ok, false);
    eq(parseEvent('{"event":"hover","value":true}'), { event: 'hover', value: true });
    eq(parseEvent('{"event":"ready"}'), { event: 'ready' });
    eq(parseEvent('{"event":"drag","state":"x","uri":"u"}'), null);
    eq(parseEvent('{"event":"hover","value":"yes"}'), null);
    eq(parseEvent('not json'), null);
    eq(parseEvent('null'), null);
});

test('the pointer counts as on the notch during a drag', () => {
    eq(pointerOnNotch({ helper: false, dragging: false }), false);
    eq(pointerOnNotch({ helper: true, dragging: false }), true);
    eq(pointerOnNotch({ helper: false, dragging: true }), true);
});

test('drag icon: first themed name, else empty', () => {
    eq(dragIconName({ get_names: () => ['text-x-generic', 'text-x'] }), 'text-x-generic');
    eq(dragIconName({}), '');
    eq(dragIconName(null), '');
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
