// Run: gjs -m tests/layoutModel.test.js
import { LayoutModel } from '../core/layoutModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const MON = { x: 0, y: 0, width: 1280, height: 800 };
const rect = (x, y, width, height) => ({ x, y, width, height });

test('the menu bar strut, as Mutter already applied it', () => {
    const m = new LayoutModel();
    m.claim({ id: 'menu-bar', edge: 'top', size: 32, reserve: 'strut', order: -100 });
    const { workArea, rects } = m.compute(0, MON, { base: rect(0, 32, 1280, 768) });
    eq(rects.get('menu-bar'), rect(0, 0, 1280, 32));
    eq(workArea, rect(0, 32, 1280, 768));
});
test('without a Mutter area the struts are taken off too', () => {
    const m = new LayoutModel();
    m.claim({ id: 'menu-bar', edge: 'top', size: 32, reserve: 'strut' });
    m.claim({ id: 'dock', edge: 'bottom', size: 70, reserve: 'strut' });
    eq(m.compute(0, MON, { strutsApplied: false }).workArea, rect(0, 32, 1280, 698));
});
test('a soft claim (the Stage Manager strip) shrinks the work area for Guava only', () => {
    const m = new LayoutModel();
    m.claim({ id: 'menu-bar', edge: 'top', size: 32, reserve: 'strut' });
    m.claim({ id: 'stage-strip', edge: 'left', size: 180, reserve: 'soft' });
    const base = rect(0, 32, 1280, 768);
    const { workArea, rects } = m.compute(0, MON, { base });
    eq(workArea, rect(180, 32, 1100, 768));
    eq(rects.get('stage-strip'), rect(0, 0, 180, 800));
});
test('claims on one edge stack outward to inward by order', () => {
    const m = new LayoutModel();
    m.claim({ id: 'inner', edge: 'bottom', size: 20, order: 1, reserve: 'soft' });
    m.claim({ id: 'dock', edge: 'bottom', size: 70, order: 0, reserve: 'soft' });
    const { workArea, rects } = m.compute(0, MON);
    eq(rects.get('dock'), rect(0, 730, 1280, 70));
    eq(rects.get('inner'), rect(0, 710, 1280, 20));
    eq(workArea.height, 710);
});
test('the notch sits inside the menu bar without pushing, centred with its length', () => {
    const m = new LayoutModel();
    m.claim({ id: 'menu-bar', edge: 'top', size: 32, reserve: 'strut', order: -100 });
    m.claim({ id: 'notch', edge: 'top', size: 32, stack: false, length: 200 });
    m.claim({ id: 'below', edge: 'top', size: 10, reserve: 'soft' });
    const { rects, workArea } = m.compute(0, MON, { base: rect(0, 32, 1280, 768) });
    eq(rects.get('notch'), rect(540, 0, 200, 32));
    eq(rects.get('below'), rect(0, 32, 1280, 10), 'stacks under the menu bar, not the notch');
    eq(workArea.y, 42);
});
test('align start/end along the edge; length capped to the edge', () => {
    const m = new LayoutModel();
    m.claim({ id: 'a', edge: 'right', size: 50, length: 300, align: 'start' });
    m.claim({ id: 'b', edge: 'left', size: 50, length: 9999, align: 'end' });
    const { rects } = m.compute(0, MON);
    eq(rects.get('a'), rect(1230, 0, 50, 300));
    eq(rects.get('b'), rect(0, 0, 50, 800));
});
test('monitors: primary, all, or an index; offsets follow the monitor origin', () => {
    const m = new LayoutModel();
    m.claim({ id: 'p', edge: 'top', size: 10, reserve: 'soft' });
    m.claim({ id: 'all', edge: 'bottom', size: 5, monitor: 'all', reserve: 'soft' });
    m.claim({ id: 'two', edge: 'left', size: 7, monitor: 1, reserve: 'soft' });
    const second = { x: 1280, y: 0, width: 1000, height: 600 };
    const r0 = m.compute(0, MON, { primary: 0 });
    const r1 = m.compute(1, second, { primary: 0 });
    eq([...r0.rects.keys()].sort(), ['all', 'p']);
    eq([...r1.rects.keys()].sort(), ['all', 'two']);
    eq(r1.workArea, rect(1287, 0, 993, 595));
});
test('update keeps registration order; release frees the edge; bad specs throw', () => {
    const m = new LayoutModel();
    m.claim({ id: 'a', edge: 'top', size: 10, reserve: 'soft' });
    m.claim({ id: 'b', edge: 'top', size: 10, reserve: 'soft' });
    m.update('a', { size: 20 });
    eq(m.compute(0, MON).rects.get('b').y, 20);
    eq(m.release('a'), true);
    eq(m.compute(0, MON).rects.get('b').y, 0);
    eq(m.update('zzz', { size: 1 }), null);
    let threw = 0;
    for (const bad of [{ edge: 'top' }, { id: 'x', edge: 'middle' }, { id: 'x', edge: 'top', reserve: 'hard' }]) {
        try { m.claim(bad); } catch (_e) { threw++; }
    }
    eq(threw, 3);
});
test('a base smaller than the claims wins (another client strut is respected)', () => {
    const m = new LayoutModel();
    m.claim({ id: 'strip', edge: 'left', size: 100, reserve: 'soft' });
    eq(m.compute(0, MON, { base: rect(200, 0, 1080, 800) }).workArea, rect(200, 0, 1080, 800));
});

test('three claims on one edge stack outward to inward by order; ties keep registration order', () => {
    const m = new LayoutModel();
    m.claim({ id: 'c', edge: 'top', size: 10, order: 5, reserve: 'soft' });
    m.claim({ id: 'a', edge: 'top', size: 10, order: 0, reserve: 'soft' });
    m.claim({ id: 'b', edge: 'top', size: 10, order: 0, reserve: 'soft' });
    const { rects, workArea } = m.compute(0, MON);
    eq(rects.get('a').y, 0);
    eq(rects.get('b').y, 10);
    eq(rects.get('c').y, 20);
    eq(workArea.y, 30);
    eq(m.claimsOn(0).map(c => c.id), ['a', 'b', 'c']);
});
test('a negative order sits outside the default ones', () => {
    const m = new LayoutModel();
    m.claim({ id: 'x', edge: 'top', size: 10, reserve: 'soft' });
    m.claim({ id: 'menu', edge: 'top', size: 32, reserve: 'strut', order: -100 });
    const { rects, workArea } = m.compute(0, MON, { base: rect(0, 32, 1280, 768) });
    eq(rects.get('menu'), rect(0, 0, 1280, 32));
    eq(rects.get('x'), rect(0, 32, 1280, 10));
    eq(workArea, rect(0, 42, 1280, 758));
});
test('a re-claim keeps its stacking place; release then claim goes to the end', () => {
    const m = new LayoutModel();
    m.claim({ id: 'a', edge: 'top', size: 10, reserve: 'soft' });
    m.claim({ id: 'b', edge: 'top', size: 10, reserve: 'soft' });
    m.claim({ id: 'a', edge: 'top', size: 12, reserve: 'soft' });
    eq(m.compute(0, MON).rects.get('b').y, 12, 'a kept first');
    m.release('a');
    m.claim({ id: 'a', edge: 'top', size: 10, reserve: 'soft' });
    const { rects } = m.compute(0, MON);
    eq(rects.get('b').y, 0, 'b moved up');
    eq(rects.get('a').y, 10, 'a re-registered at the end');
});
test('claims on different edges overlap at the corner; the work area counts each once', () => {
    const m = new LayoutModel();
    m.claim({ id: 'bar', edge: 'top', size: 32, reserve: 'soft' });
    m.claim({ id: 'strip', edge: 'left', size: 180, reserve: 'soft' });
    const { workArea, rects } = m.compute(0, MON);
    eq(rects.get('bar'), rect(0, 0, 1280, 32));
    eq(rects.get('strip'), rect(0, 0, 180, 800));
    eq(workArea, rect(180, 32, 1100, 768));
});
test('stack:false claims on one edge overlap at the edge and take no space', () => {
    const m = new LayoutModel();
    m.claim({ id: 'n1', edge: 'top', size: 32, stack: false });
    m.claim({ id: 'n2', edge: 'top', size: 20, stack: false });
    m.claim({ id: 'x', edge: 'top', size: 10, reserve: 'soft' });
    const { rects, workArea } = m.compute(0, MON);
    eq(rects.get('n1'), rect(0, 0, 1280, 32));
    eq(rects.get('n2'), rect(0, 0, 1280, 20));
    eq(rects.get('x'), rect(0, 0, 1280, 10), 'the stacked claim is not pushed by them');
    eq(workArea, rect(0, 10, 1280, 790));
});
test('releasing a soft claim gives its space back to the work area', () => {
    const m = new LayoutModel();
    m.claim({ id: 'bar', edge: 'top', size: 32, reserve: 'strut' });
    m.claim({ id: 'strip', edge: 'left', size: 180, reserve: 'soft' });
    const base = rect(0, 32, 1280, 768);
    eq(m.compute(0, MON, { base }).workArea, rect(180, 32, 1100, 768));
    eq(m.release('strip'), true);
    eq(m.compute(0, MON, { base }).workArea, rect(0, 32, 1280, 768));
    eq(m.release('strip'), false, 'second release is a no-op');
});
test('releasing an inner claim moves the outer ones and returns its space', () => {
    const m = new LayoutModel();
    m.claim({ id: 'a', edge: 'top', size: 10, reserve: 'soft' });
    m.claim({ id: 'b', edge: 'top', size: 20, reserve: 'soft' });
    eq(m.compute(0, MON).workArea.y, 30);
    m.release('a');
    const { rects, workArea } = m.compute(0, MON);
    eq(rects.get('b').y, 0);
    eq(workArea.y, 20);
});
test('a claim on the second monitor uses its origin, including a negative one', () => {
    const m = new LayoutModel();
    const above = { x: 1280, y: -600, width: 1000, height: 600 };
    m.claim({ id: 'top2', edge: 'top', size: 20, monitor: 1, reserve: 'soft' });
    const r = m.compute(1, above, { primary: 0 });
    eq(r.rects.get('top2'), rect(1280, -600, 1000, 20));
    eq(r.workArea, rect(1280, -580, 1000, 580));
    eq(m.compute(0, MON, { primary: 0 }).rects.has('top2'), false);
});
test('primary follows the primary index passed in, not the first monitor', () => {
    const m = new LayoutModel();
    const second = { x: 1280, y: 0, width: 1000, height: 600 };
    m.claim({ id: 'p', edge: 'top', size: 10, reserve: 'soft' });
    eq(m.compute(1, second, { primary: 1 }).rects.has('p'), true);
    eq(m.compute(0, MON, { primary: 1 }).rects.has('p'), false);
});
test('an all-monitor claim gives each monitor its own rect and work area', () => {
    const m = new LayoutModel();
    const second = { x: 1280, y: 0, width: 1000, height: 600 };
    m.claim({ id: 'dock', edge: 'bottom', size: 70, monitor: 'all', reserve: 'soft' });
    const r0 = m.compute(0, MON);
    const r1 = m.compute(1, second);
    eq(r0.rects.get('dock'), rect(0, 730, 1280, 70));
    eq(r1.rects.get('dock'), rect(1280, 530, 1000, 70));
    eq(r0.workArea, rect(0, 0, 1280, 730));
    eq(r1.workArea, rect(1280, 0, 1000, 530));
});
test('a zero-size claim takes no room and pushes nobody', () => {
    const m = new LayoutModel();
    m.claim({ id: 'zero', edge: 'top', size: 0, reserve: 'soft' });
    m.claim({ id: 'a', edge: 'top', size: 10, reserve: 'soft' });
    const { rects, workArea } = m.compute(0, MON);
    eq(rects.get('zero'), rect(0, 0, 1280, 0));
    eq(rects.get('a').y, 0);
    eq(workArea, rect(0, 10, 1280, 790));
});
test('a zero-size strut does not move the work area even without Mutter', () => {
    const m = new LayoutModel();
    m.claim({ id: 'bar', edge: 'top', size: 0, reserve: 'strut' });
    eq(m.compute(0, MON, { strutsApplied: false }).workArea, rect(0, 0, 1280, 800));
});
test('a negative or missing size clamps to zero', () => {
    const m = new LayoutModel();
    m.claim({ id: 'neg', edge: 'top', size: -5, reserve: 'soft' });
    m.claim({ id: 'none', edge: 'left' });
    eq(m.get('neg').size, 0);
    eq(m.get('none').size, 0);
    const { rects, workArea } = m.compute(0, MON);
    eq(rects.get('neg').height, 0);
    eq(rects.get('none').width, 0);
    eq(workArea, rect(0, 0, 1280, 800));
});
test('a zero-length claim is an empty rect, not a negative one', () => {
    const m = new LayoutModel();
    m.claim({ id: 'empty', edge: 'top', size: 32, length: 0, reserve: 'none' });
    const r = m.compute(0, MON).rects.get('empty');
    eq(r.width, 0);
    eq(r.height, 32);
});
test('an oversized soft claim leaves an empty work area, never a negative one', () => {
    const m = new LayoutModel();
    m.claim({ id: 'wide', edge: 'left', size: 2000, reserve: 'soft' });
    const { workArea } = m.compute(0, MON);
    eq(workArea.width, 0);
    eq(workArea.height, 800);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
