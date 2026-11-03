// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// Pure decisions of "full screen in its own Space": whether a window moves, where it goes,
// which workspaces shift, which may be removed. No gi:// imports; tested by
// tests/fullscreenSpaceModel.test.js.
//
// A workspace is described by its index; `occupied` is an array of booleans, one per
// workspace, true when it holds a window that counts (not skip-taskbar, and on the primary
// monitor when workspaces-only-on-primary is set).

export const ISOLATE_DELAY_MS = 600;
export const RESTORE_DELAY_MS = 600;
export const CLEANUP_GRACE_MS = 600;
export const MIN_WORKSPACES = 2;
export const MAX_WORKSPACES = 36;
export const SLOW_DOWN_FACTOR = 3;
export const SLOW_DOWN_MS = 700;
export const PIN_MAX_MS = 1500;

/**
 * What entering full screen does to a window.
 * @param {{index: number, others: number, sticky: boolean}} w others: other relevant windows on its workspace
 * @returns {'skip'|'move'|'alone'} skip: on all workspaces; move: to a new Space;
 *   alone: already alone on a later workspace, nothing to move
 */
export function isolateDecision({ index, others, sticky }) {
    if (sticky)
        return 'skip';
    if (index === 0)
        return 'move';
    return others > 0 ? 'move' : 'alone';
}

/** Last index holding something, or -1. */
export function lastOccupied(occupied) {
    for (let i = occupied.length - 1; i >= 0; i--) {
        if (occupied[i])
            return i;
    }
    return -1;
}

/**
 * Where an isolated window goes: the workspace right of `index`.
 * @param {{index: number, occupied: boolean[], max?: number}} p
 * @returns {{kind: 'use', target: number}
 *   | {kind: 'append', target: number}
 *   | {kind: 'shift', target: number, moves: number[], append: boolean}
 *   | {kind: 'abort'}}
 *   use: target exists and is empty. append: add one at the end. shift: target is occupied;
 *   `moves` lists the workspaces whose windows move one place right, last first, and `append`
 *   says a workspace must be added first to receive the last one.
 */
export function planTarget({ index, occupied, max = MAX_WORKSPACES }) {
    const count = occupied.length;
    const target = index + 1;
    if (target >= count)
        return count >= max ? { kind: 'abort' } : { kind: 'append', target: count };
    if (!occupied[target])
        return { kind: 'use', target };
    const append = occupied[count - 1];
    if (append && count >= max)
        return { kind: 'abort' };
    const moves = [];
    for (let i = count - 1; i >= target; i--) {
        if (occupied[i])
            moves.push(i);
    }
    return { kind: 'shift', target, moves, append };
}

/**
 * Workspaces to append so there are at least `min` and one empty one after the last occupied.
 * @returns {number} how many to add (0 when satisfied or at the limit)
 */
export function trailingToAppend({ occupied, min = MIN_WORKSPACES, max = MAX_WORKSPACES }) {
    const count = occupied.length;
    const need = Math.max(min, lastOccupied(occupied) + 2);
    return Math.max(0, Math.min(need, max) - count);
}

/**
 * May this workspace be removed now? Never the first, never when only the minimum remains,
 * never the active or an occupied one, never the empty one kept after the last occupied.
 */
export function canRemove({ index, occupied, active, min = MIN_WORKSPACES }) {
    const count = occupied.length;
    if (index <= 0 || index >= count || count <= min)
        return false;
    if (index === active || occupied[index])
        return false;
    return index !== lastOccupied(occupied) + 1;
}

/** Empty workspaces a static-mode sweep may remove, highest first (each is revalidated by the caller). */
export function sweepList({ occupied, active, min = MIN_WORKSPACES }) {
    const out = [];
    for (let i = occupied.length - 1; i > 0; i--) {
        if (canRemove({ index: i, occupied, active, min }))
            out.push(i);
    }
    return out;
}

/** An index after workspace `removed` is deleted. */
export function indexAfterRemoval(index, removed) {
    return index > removed ? index - 1 : index;
}

/** Where a window returns to: its home, clamped to the workspaces that exist (0 if unknown). */
export function restoreIndex(home, count) {
    if (!Number.isInteger(home) || count <= 0)
        return 0;
    return Math.min(Math.max(0, home), count - 1);
}

/**
 * A window that appears on a Space held by a full-screen window is sent to the first
 * workspace, unless it belongs to that app (moving a dialog would drag its parent along).
 */
export function shouldRedirectNewWindow({ fullscreen, skips, sharesSpaceWithFullscreen, belongsToApp }) {
    return !fullscreen && !skips && sharesSpaceWithFullscreen && !belongsToApp;
}

/**
 * Entries of a saved snapshot to restore after the feature is re-enabled (Guava is disabled on
 * every screen lock). Entries for windows that vanished or workspaces out of range are dropped.
 * @param {Array<{id: number, home: number, space: number}>} saved
 * @param {Map<number, {index: number, fullscreen: boolean}>} live by stable sequence
 * @param {number} count workspace count
 * @returns {{isolated: Array<{id, home, space}>, restore: Array<{id, home, space}>}}
 *   isolated: still full screen; restore: no longer full screen, to go home
 */
export function reviveSnapshot(saved, live, count) {
    const isolated = [];
    const restore = [];
    for (const entry of saved ?? []) {
        const now = live.get(entry.id);
        if (!now || now.index < 0 || now.index >= count)
            continue;
        const e = { id: entry.id, home: entry.home, space: now.index };
        (now.fullscreen ? isolated : restore).push(e);
    }
    return { isolated, restore };
}
