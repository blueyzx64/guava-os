// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
// Run: gjs -m tests/aboutModel.test.js
import { versionLabel, releaseUrl, CREDITS, RECOMMENDED, REPO_URL } from '../prefs/aboutModel.js';

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

test('versionLabel: name alone, with number, empty', () => {
    eq(versionLabel('1.0.0', undefined), '1.0.0');
    eq(versionLabel('1.0.0', 12), '1.0.0 (12)');
    eq(versionLabel(undefined, 3), '(3)');
    eq(versionLabel(undefined, undefined), '');
});

test('releaseUrl: tag is url-encoded', () => {
    eq(releaseUrl('1.0.0'), `${REPO_URL}/releases/tag/v1.0.0`);
    eq(releaseUrl('1.0 beta/2'), `${REPO_URL}/releases/tag/v1.0%20beta%2F2`);
});

test('credits: Blur my Shell is credited, nothing from the old author', () => {
    eq(CREDITS.some(c => c.title === 'Blur my Shell' && /GPL-3\.0/.test(c.subtitle)), true);
    const text = JSON.stringify([CREDITS, RECOMMENDED]).toLowerCase();
    eq(/kem-a|kemlers|kiwi menu/.test(text), false);
});

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
