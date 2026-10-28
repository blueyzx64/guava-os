// Run: gjs -m tests/dialogsModel.test.js
import { dialogIcon, dialogKind } from '../features/dialogs/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('kind from the card classes', () => {
    eq(dialogKind('modal-dialog end-session-dialog'), 'end-session');
    eq(dialogKind('modal-dialog prompt-dialog guava-dialog'), 'auth');
    eq(dialogKind('modal-dialog run-dialog'), 'run');
    eq(dialogKind('modal-dialog guava-about'), 'other');
    eq(dialogKind(null), 'other');
});

test('icons: end-session by type, none for other dialogs', () => {
    eq(dialogIcon('end-session', 0), 'system-log-out-symbolic');
    eq(dialogIcon('end-session', 2), 'system-reboot-symbolic');
    eq(dialogIcon('end-session', 99), 'system-shutdown-symbolic');
    eq(dialogIcon('auth'), 'dialog-password-symbolic');
    eq(dialogIcon('run'), 'system-run-symbolic');
    eq(dialogIcon('other'), null);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
