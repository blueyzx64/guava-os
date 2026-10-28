// SPDX-License-Identifier: GPL-3.0-or-later
// Emoji & Symbols (the macOS Character Viewer popover): the catalogue, search, skin tones,
// recents and grid navigation. Pure: data.js reads IBus's emoji dictionary into plain records
// {emoji, annotations, description, category}; index.js and view.js draw and insert.

export const COLUMNS = 9;
export const RECENTS_MAX = 27;          // three rows
export const SEARCH_LIMIT = 180;
export const SKIN_TONES = Object.freeze(['light', 'medium-light', 'medium', 'medium-dark', 'dark']);
// The tone dots of the picker: the default yellow, then light to dark (U+1F3FB..U+1F3FF)
export const TONE_SWATCHES = Object.freeze(['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿']);

/** Guava's tabs, in the macOS Character Viewer order; `from` are the Unicode (CLDR) groups. */
export const CATEGORIES = Object.freeze([
    { id: 'recent', label: 'Frequently Used', icon: 'emoji-recent-symbolic', from: [] },
    { id: 'smileys', label: 'Smileys & People', icon: 'emoji-people-symbolic', from: ['Smileys & Emotion', 'People & Body'] },
    { id: 'nature', label: 'Animals & Nature', icon: 'emoji-nature-symbolic', from: ['Animals & Nature'] },
    { id: 'food', label: 'Food & Drink', icon: 'emoji-food-symbolic', from: ['Food & Drink'] },
    { id: 'activity', label: 'Activity', icon: 'emoji-activities-symbolic', from: ['Activities'] },
    { id: 'travel', label: 'Travel & Places', icon: 'emoji-travel-symbolic', from: ['Travel & Places'] },
    { id: 'objects', label: 'Objects', icon: 'emoji-objects-symbolic', from: ['Objects'] },
    { id: 'symbols', label: 'Symbols', icon: 'emoji-symbols-symbolic', from: ['Symbols'] },
    { id: 'flags', label: 'Flags', icon: 'emoji-flags-symbolic', from: ['Flags'] },
]);

const TONE_RE = new RegExp(`^(.+): (${SKIN_TONES.join('|')}) skin tone$`);
const GROUP_TO_CATEGORY = new Map(CATEGORIES.flatMap(c => c.from.map(g => [g, c.id])));

/**
 * The dictionary files to try, best first: the full locale, the language, then English.
 *
 * @param {string[]} languageNames GLib.get_language_names() (e.g. ['de_DE.UTF-8', 'de_DE', 'de', 'C'])
 * @returns {string[]} IBus dictionary language codes (e.g. ['de_DE', 'de', 'en'])
 */
export function dictLanguages(languageNames) {
    const out = [];
    for (const raw of languageNames ?? []) {
        const name = String(raw).split('.')[0].split('@')[0];
        if (!name || name === 'C' || name === 'POSIX' || out.includes(name))
            continue;
        out.push(name);
    }
    if (!out.includes('en'))
        out.push('en');
    return out;
}

const words = s => s.toLowerCase().split(/[\s:_,.()'"“”-]+/).filter(Boolean);

/**
 * Turn dictionary records into the catalogue: skin-tone variants are folded into their base
 * emoji, components (bare tone swatches, hair) and multi-tone combinations are left out.
 *
 * @param {{emoji: string, annotations: string[], description: string, category: string}[]} records
 * @returns {{items: object[], byCategory: Map<string, object[]>, byChar: Map<string, object>}}
 *   item: {char, name, keywords: string[], category, tones: ?string[5]}
 */
export function buildCatalog(records) {
    const items = [];
    const byName = new Map();
    const byChar = new Map();
    const tones = [];
    for (const r of records ?? []) {
        if (!r?.emoji || !r.description)
            continue;
        const category = GROUP_TO_CATEGORY.get(r.category);
        if (!category)
            continue;
        const tone = TONE_RE.exec(r.description);
        if (tone) {
            tones.push({ base: tone[1], tone: SKIN_TONES.indexOf(tone[2]), char: r.emoji });
            continue;
        }
        if (r.description.includes('skin tone') || byName.has(r.description) || byChar.has(r.emoji))
            continue;
        const item = {
            char: r.emoji,
            name: r.description,
            keywords: [...new Set([...(r.annotations ?? []).flatMap(words), ...words(r.description)])],
            category,
            tones: null,
        };
        items.push(item);
        byName.set(item.name, item);
        byChar.set(item.char, item);
    }
    for (const t of tones) {
        const base = byName.get(t.base);
        if (!base)
            continue;
        base.tones ??= [null, null, null, null, null];
        base.tones[t.tone] = t.char;
        byChar.set(t.char, base);
    }
    // A partial set of variants is not offered: the tone picker must mean the same for all
    for (const item of items) {
        if (item.tones?.some(c => !c))
            item.tones = null;
    }
    const byCategory = new Map(CATEGORIES.map(c => [c.id, []]));
    for (const item of items)
        byCategory.get(item.category).push(item);
    return { items, byCategory, byChar };
}

/** The character to type for `item` at skin tone 0 (yellow) .. 5 (dark). */
export function withTone(item, tone) {
    if (!item)
        return '';
    const t = Math.round(tone);
    return t >= 1 && t <= 5 && item.tones ? item.tones[t - 1] : item.char;
}

/**
 * Search by name and keywords. Every typed word must start a word of the emoji's name or
 * keywords; a whole-name match ranks first, then name words, then keywords; ties keep the
 * catalogue order (the Unicode order, as macOS shows it).
 *
 * @returns {object[]} items
 */
export function search(catalog, query, limit = SEARCH_LIMIT) {
    const terms = words(query ?? '');
    if (!terms.length || !catalog)
        return [];
    const scored = [];
    catalog.items.forEach((item, index) => {
        const nameWords = words(item.name);
        let score = 0;
        for (const term of terms) {
            if (nameWords.includes(term))
                score += 3;
            else if (nameWords.some(w => w.startsWith(term)))
                score += 2;
            else if (item.keywords.some(w => w.startsWith(term)))
                score += 1;
            else
                return;
        }
        if (item.name.toLowerCase() === terms.join(' '))
            score += 10;
        scored.push({ item, score, index });
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.slice(0, limit).map(s => s.item);
}

/** Recents after using `char`: newest first, no duplicates, at most `max`. */
export function pushRecent(recents, char, max = RECENTS_MAX) {
    if (!char)
        return [...(recents ?? [])].slice(0, max);
    return [char, ...(recents ?? []).filter(c => c !== char)].slice(0, max);
}

/**
 * The recents as grid cells: the character that was typed (with its tone) and its item.
 * Unknown characters (a dictionary from another language) are dropped.
 *
 * @returns {{char: string, item: object}[]}
 */
export function recentCells(catalog, recents) {
    if (!catalog)
        return [];
    return (recents ?? []).filter(c => catalog.byChar.has(c)).map(c => ({ char: c, item: catalog.byChar.get(c) }));
}

/** The cells of one tab: its emoji at the chosen tone. */
export function categoryCells(catalog, categoryId, tone, recents) {
    if (categoryId === 'recent')
        return recentCells(catalog, recents);
    return (catalog?.byCategory.get(categoryId) ?? []).map(item => ({ char: withTone(item, tone), item }));
}

/** Which tab opens first: Frequently Used when there is something in it, like macOS. */
export function firstCategory(catalog, recents) {
    return recentCells(catalog, recents).length ? 'recent' : 'smileys';
}

/**
 * Arrow keys in the grid.
 *
 * @param {number} index current cell, -1 for none
 * @param {'left'|'right'|'up'|'down'|'home'|'end'} move
 * @param {number} count cells
 * @param {number} [columns]
 * @returns {number} the new index (-1 when there are no cells)
 */
export function moveInGrid(index, move, count, columns = COLUMNS) {
    if (count <= 0)
        return -1;
    if (index < 0)
        return 0;
    const step = { left: -1, right: 1, up: -columns, down: columns }[move];
    if (move === 'home')
        return 0;
    if (move === 'end')
        return count - 1;
    const next = index + (step ?? 0);
    if (next < 0 || next >= count)
        return move === 'down' || move === 'right' ? Math.min(count - 1, index) : Math.max(0, index);
    return next;
}

/** The tab after/before `id` (Tab and Shift+Tab, or Ctrl+Page Down/Up). */
export function nextCategory(id, delta) {
    const at = CATEGORIES.findIndex(c => c.id === id);
    const n = CATEGORIES.length;
    return CATEGORIES[((at < 0 ? 0 : at) + delta + n) % n].id;
}
