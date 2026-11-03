// Run: gjs -m tests/pasteModel.test.js
// lib/pasteModel.js: what to keep around a borrowed clipboard, and the borrow window.
import { ClipboardBorrow, canKeep, mimeToKeep, pasteChordFor } from '../lib/pasteModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('plain text is kept', () => eq(mimeToKeep(['text/plain', 'text/html']), 'text/plain'));
test('a password-manager secret is never kept (RV6-1)', () => {
    eq(mimeToKeep(['text/plain;charset=utf-8', 'x-kde-passwordManagerHint']), null);
});
test('empty offer keeps nothing', () => eq(mimeToKeep([]), null));
test('size limits', () => { eq(canKeep(0), false); eq(canKeep(10), true); });
test('terminals paste with ctrl-shift-v', () => eq(pasteChordFor('kitty'), 'ctrl-shift-v'));

test('borrow window covers the restore', () => {
    const b = new ClipboardBorrow(400);
    eq(b.active(0), false);
    b.begin();
    eq(b.active(5000), true, 'while open');
    b.end(1000);
    eq(b.active(1200), true, 'owner change of the restore is still ours');
    eq(b.active(1401), false, 'then ordinary copies count again');
});
test('nested borrows', () => {
    const b = new ClipboardBorrow(100);
    b.begin(); b.begin();
    b.end(10);
    eq(b.active(5000), true);
    b.end(20);
    eq(b.active(121), false);
});
test('extra end is harmless', () => {
    const b = new ClipboardBorrow(100);
    b.end(0); b.end(0);
    eq(b.active(500), false);
});

if (failed) throw new Error(`${failed} failed`);
