// SPDX-License-Identifier: GPL-3.0-or-later
// Pure ordering logic for PanelLayout. No gi imports.

/**
 * Where does a claimed actor go among the other children of a panel box?
 *
 * @param {(string|null)[]} keys keys of the other children in order (status-area role or
 *   claim id; null for children we cannot name). The claimed actor itself is left out.
 * @param {object} anchor one of
 *   {first: true} | {last: true} |
 *   {before: [ids], fallback?: 'first'|'last'} | {after: [ids], fallback?: 'first'|'last'}
 * @returns {number} index to insert at, 0..keys.length
 */
export function targetIndex(keys, anchor = { last: true }) {
    const fallback = anchor.fallback === 'first' ? 0 : keys.length;
    if (anchor.first)
        return 0;
    if (anchor.before) {
        const hit = keys.findIndex(k => k !== null && anchor.before.includes(k));
        return hit >= 0 ? hit : fallback;
    }
    if (anchor.after) {
        let last = -1;
        keys.forEach((k, i) => {
            if (k !== null && anchor.after.includes(k))
                last = i;
        });
        return last >= 0 ? last + 1 : fallback;
    }
    return keys.length;
}
