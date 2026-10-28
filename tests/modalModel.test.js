// Run: gjs -m tests/modalModel.test.js
import { ModalArbiter, menuAtPoint } from '../lib/modalModel.js';

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
function eq(a, b, msg = '') {
    if (a !== b)
        throw new Error(`${msg} expected ${b}, got ${a}`);
}

test('opening a second modal closes the first', () => {
    const a = new ModalArbiter();
    const log = [];
    eq(a.request('one'), true);
    a.opened('one', () => { log.push('one'); a.closed('one'); });
    eq(a.current, 'one');
    eq(a.request('two'), true);
    eq(log.join(), 'one');
    eq(a.current, null);
    a.opened('two', () => log.push('two'));
    eq(a.current, 'two');
});

test('same id again is a toggle request (false), nothing closed', () => {
    const a = new ModalArbiter();
    let closed = 0;
    a.request('x');
    a.opened('x', () => closed++);
    eq(a.request('x'), false);
    eq(closed, 0);
});

test('foreign overlays close on request and on closeAll', () => {
    const a = new ModalArbiter();
    let fan = 0;
    const off = a.registerForeign('fan', () => fan++);
    a.request('m');
    eq(fan, 1);
    a.closeAll();
    eq(fan, 2);
    off();
    a.closeAll();
    eq(fan, 2, 'unregistered');
});

test('a throwing closer does not block the rest', () => {
    const a = new ModalArbiter();
    let ok = 0;
    a.registerForeign('bad', () => { throw new Error('boom'); });
    a.registerForeign('good', () => ok++);
    a.request('m');
    eq(ok, 1);
});

test('stale closed() does not clear a newer modal', () => {
    const a = new ModalArbiter();
    a.request('a');
    a.opened('a', () => {});
    a.request('b');
    a.opened('b', () => {});
    a.closed('a');
    eq(a.current, 'b');
});

test('menuAtPoint finds the button under the pointer', () => {
    const a = { menu: 'a', rect: { x: 0, y: 0, width: 40, height: 32 } };
    const b = { menu: 'b', rect: { x: 40, y: 0, width: 40, height: 32 } };
    eq(menuAtPoint([a, b], 10, 5), 'a');
    eq(menuAtPoint([a, b], 40, 5), 'b');
    eq(menuAtPoint([a, b], 80, 5), null);
    eq(menuAtPoint([a, b], 10, 32), null);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
