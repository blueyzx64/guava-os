// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// Pure data and helpers of the About page (prefs/pages/about.js): links, version text, credits.
// No gi:// imports; tested by tests/aboutModel.test.js.

export const REPO_URL = 'https://github.com/blueyzx64/guava-os';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const CREDITS_URL = `${REPO_URL}#credits`;

/**
 * "1.0.0" or "1.0.0 (12)": the version name, then the numeric version the extensions site adds
 * on upload (a local install has none).
 * @param {string|undefined} name metadata version-name
 * @param {number|string|undefined} version metadata version
 * @returns {string}
 */
export function versionLabel(name, version) {
    const base = name ? String(name) : '';
    const hasNumber = version !== undefined && version !== null && version !== '';
    if (!hasNumber)
        return base;
    return base ? `${base} (${version})` : `(${version})`;
}

/** @returns {string} the release page of a version name */
export function releaseUrl(name) {
    return `${REPO_URL}/releases/tag/v${encodeURIComponent(String(name ?? ''))}`;
}

/**
 * Credits: code that Guava includes, and projects that inspired it.
 * Titles and subtitles are marked for translation by the page.
 */
export const CREDITS = Object.freeze([
    { title: 'lucidglyph', subtitle: 'Its text rendering (fontconfig rules and FreeType settings, GPL-3.0), by maximilionus', url: 'https://github.com/maximilionus/lucidglyph' },
    { title: 'Blur my Shell', subtitle: 'Code in lib/glassBlur.js (GPL-3.0), by aunetx', url: 'https://github.com/aunetx/blur-my-shell' },
    { title: 'Kiwi (is not Apple)', subtitle: 'Inspiration', url: 'https://github.com/blueyzx64/kiwi-is-not-apple' },
]);

/** Third-party extensions that work well beside Guava: [title, author, url]. */
export const RECOMMENDED = Object.freeze([
    ['Superbar', 'Furkan-rgb', 'https://github.com/Furkan-rgb/superbar'],
    ['Compiz alike magic lamp effect', 'hermes83', 'https://extensions.gnome.org/extension/3740/'],
    ['AppIndicator Support', '3v1n0', 'https://extensions.gnome.org/extension/615/'],
    ['Blur My Shell', 'aunetx', 'https://github.com/aunetx/blur-my-shell'],
    ['Light Style', 'fmuellner', 'https://extensions.gnome.org/extension/6198/'],
    ['Weather or Not', 'somepaulo', 'https://extensions.gnome.org/extension/5660/'],
]);
