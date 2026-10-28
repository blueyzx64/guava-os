// Run: gjs -m tests/clipboardSecrets.test.js
// Content heuristics (secrets) and image header sizes in apps/clipboard/model.js.
import GdkPixbuf from 'gi://GdkPixbuf';

import {
    checkDimensions, imageDimensions, isPasswordManagerApp, looksSecret, luhnValid,
    parseHistory, parseHistoryChecked, pickMime, shannonEntropy,
} from '../features/clipboard/model.js';

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
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/* ---- secrets: must be caught ---- */
const SECRETS = {
    'PEM RSA': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
    'PKCS8': '-----BEGIN PRIVATE KEY-----\nMIIE...',
    'OpenSSH': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
    'encrypted PEM': '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'PGP': '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    'visa spaced': '4111 1111 1111 1111',
    'mastercard dashed': '5555-5555-5555-4444',
    'amex': '378282246310005',
    'JWT': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0N' + 'TY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'github': 'token ghp_a1B2c3D4e5F6g' + '7H8i9J0k1L2m3N4o5P6q7R8',
    'github pat': 'github_pat_11ABCDEFG0123456789_a' + 'bcdefghijklmnopqrstuvwxyzABCDEFGH',
    'gitlab': 'glpat-xYz123A' + 'BCdef456GHIjk',
    'slack': 'xoxb-1234567890' + '12-abcdefABCDEF',
    'openai': 'sk-proj-AbCdEf012' + '3456789GhIjKlMnOp',
    'stripe': 'sk_live_4eC39HqL' + 'yjWDarjtT1zdp7dc',
    'aws': 'AKIAIOSFOD' + 'NN7EXAMPLE',
    'google': 'AIzaSyDdI0hCZtE6vyS' + 'jMm-WEfRq3CPzqKqqsHI',
    'random token': 'Zr8q2LmX9vT4kBw7' + 'Yp1sNf6Hc3Gd0JaE',
};
for (const [name, text] of Object.entries(SECRETS))
    test(`secret: ${name}`, () => eq(looksSecret(text), true));

/* ---- normal text: must still record ---- */
const NORMAL = {
    'prose': 'The quick brown fox jumps over the lazy dog. Meet at 10:30 tomorrow?',
    'url': 'https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/main.js?ref_type=heads#L120',
    'url with token-like query': 'https://example.org/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
    'code': 'const grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.POPUP });',
    'path': '/home/user/.local/share/guava/clipboard/images/3f2a9c.png',
    'sha256 hex': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'git short sha': 'a1b2c3d',
    'uuid': '123e4567-e89b-12d3-a456-426614174000',
    'camelCase identifier': 'getElementsByClassNameAndTagName',
    'phone': '+1 415 555 0132',
    'not luhn': '4111 1111 1111 1112',
    'short number': '1234 5678',
    'same digit run': '0000000000000000',
    'email': 'someone.with.long.name@example-company.org',
    'colour': '#3584e4',
    'pem public key': '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...',
    'sk in a word': 'task-management-tool-for-teams',
    'base64 in prose': 'See commit 4f2b and the file named MyReport2024Final.pdf for details',
};
for (const [name, text] of Object.entries(NORMAL))
    test(`normal: ${name}`, () => eq(looksSecret(text), false));

test('luhn and entropy helpers', () => {
    eq(luhnValid('79927398713'), true);
    eq(luhnValid('79927398710'), false);
    eq(shannonEntropy('aaaa'), 0);
    eq(Math.round(shannonEntropy('abcd') * 100) / 100, 2);
});

test('more password manager ids', () => {
    for (const a of ['com.bitwarden.desktop', 'org.gnome.World.Secrets', 'me.proton.pass',
        'com.1password.1password', 'org.keepassxc.KeePassXC', 'org.gnome.seahorse.Application', 'Seahorse'])
        eq(isPasswordManagerApp(a), true, a);
});

/* ---- images ---- */
function encoded(type, w, h) {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h);
    pb.fill(0x3584e4ff);
    const [ok, buf] = pb.save_to_bufferv(type, [], []);
    if (!ok)
        throw new Error(`cannot encode ${type}`);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

for (const type of ['png', 'jpeg', 'bmp']) {
    test(`header size: real ${type}`, () => {
        const d = imageDimensions(encoded(type, 37, 21));
        eq(d?.width, 37);
        eq(d?.height, 21);
    });
}

function bytes(len, set) {
    const b = new Uint8Array(len);
    set(b);
    return b;
}
const put = (b, i, s) => [...s].forEach((c, k) => { b[i + k] = c.charCodeAt(0); });

test('header size: PNG bomb (30000 x 30000) is read without decoding and refused', () => {
    const b = bytes(40, x => {
        x[0] = 0x89; put(x, 1, 'PNG\r\n\x1a\n'); put(x, 12, 'IHDR');
        const v = 30000;
        [16, 20].forEach(i => { x[i] = v >>> 24; x[i + 1] = (v >>> 16) & 255; x[i + 2] = (v >>> 8) & 255; x[i + 3] = v & 255; });
    });
    const d = imageDimensions(b);
    eq(d.width, 30000);
    eq(checkDimensions(d), 'too-large');
});
test('header size: GIF', () => {
    const d = imageDimensions(bytes(32, x => { put(x, 0, 'GIF89a'); x[6] = 0x40; x[7] = 0x01; x[8] = 0xc8; }));
    eq(d.width, 320);
    eq(d.height, 200);
});
test('header size: WebP VP8X and VP8L', () => {
    const x = imageDimensions(bytes(32, b => {
        put(b, 0, 'RIFF'); put(b, 8, 'WEBP'); put(b, 12, 'VP8X');
        b[24] = 99; b[27] = 49;           // 100 x 50
    }));
    eq(x.width, 100);
    eq(x.height, 50);
    const l = imageDimensions(bytes(32, b => {
        put(b, 0, 'RIFF'); put(b, 8, 'WEBP'); put(b, 12, 'VP8L'); b[20] = 0x2f;
        const bits = (10 - 1) | ((20 - 1) << 14);
        b[21] = bits & 255; b[22] = (bits >>> 8) & 255; b[23] = (bits >>> 16) & 255; b[24] = bits >>> 24;
    }));
    eq(l.width, 10);
    eq(l.height, 20);
});
test('header size: junk and SVG give null; unknown fails closed', () => {
    eq(imageDimensions(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1"/>   ')), null);
    eq(imageDimensions(new Uint8Array(10)), null);
    eq(checkDimensions(null), 'unknown');
    eq(checkDimensions({ width: 8192, height: 4000 }), 'ok');
    eq(checkDimensions({ width: 8193, height: 10 }), 'too-large');
    eq(checkDimensions({ width: 7000, height: 7000 }), 'too-large', '49 Mpx');
});
test('SVG is never picked', () => {
    eq(pickMime(['image/svg+xml']), null);
});

/* ---- index checks ---- */
const H = n => String(n).padStart(64, '0');
test('stored image too big in pixels or SVG is dropped on load', () => {
    const items = [
        { kind: 'image', hash: H(1), file: `${H(1)}.png`, size: 10, time: 3, width: 30000, height: 30000 },
        { kind: 'image', hash: H(2), file: `${H(2)}.svg`, size: 10, time: 2 },
        { kind: 'image', hash: H(3), file: `${H(3)}.png`, size: 10, time: 1, width: 10, height: 10 },
    ];
    const out = parseHistory(JSON.stringify({ version: 1, items }));
    eq(out.length, 1);
    eq(out[0].hash, H(3));
});
test('parseHistoryChecked tells a broken index from an empty one', () => {
    eq(parseHistoryChecked('{oops').ok, false);
    eq(parseHistoryChecked('{"version":2,"items":[]}').ok, false);
    eq(parseHistoryChecked('{"version":1,"items":{}}').ok, false);
    eq(parseHistoryChecked('{"version":1,"items":[]}').ok, true);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
