// SPDX-License-Identifier: GPL-3.0-or-later
// Pure logic of the Screenshots feature: file names and folders, the save destination, the
// toolbar's modes and timer, selection memory, and the floating thumbnail's geometry, lifetime
// and swipe. No gi imports (tests/screenshotsModel.test.js).

/** How long the floating thumbnail waits before it saves on its own (macOS: about 5 s). */
export const THUMBNAIL_MS = 5000;
/** Timer choices of the toolbar's Options menu, in seconds (0 = None). */
export const TIMERS = Object.freeze([0, 5, 10]);
/** Where a capture goes. `pictures` is GNOME's own ~/Pictures/Screenshots. */
export const DESTINATIONS = Object.freeze(['desktop', 'documents', 'clipboard', 'pictures', 'other']);
/** Toolbar modes in the order the buttons appear. */
export const MODES = Object.freeze(['screen', 'window', 'selection', 'record-screen', 'record-selection']);
/** The smallest dragged area (px per side) that counts as a selection. */
export const MIN_AREA = 4;
/** Thumbnail box (px) the picture is fitted into, and its gap to the screen edges. */
export const THUMBNAIL_BOX = Object.freeze({ width: 220, height: 150, margin: 20 });

const pad = n => String(n).padStart(2, '0');

/**
 * macOS file stem: "Screenshot 2026-10-27 at 08.30.15".
 *
 * @param {{year: number, month: number, day: number, hour: number, minute: number, second: number}} t
 * @param {string} [prefix] "Screenshot" (screen recordings use "Screen Recording")
 * @returns {string}
 */
export function stampedName(t, prefix = 'Screenshot') {
    return `${prefix} ${t.year}-${pad(t.month)}-${pad(t.day)} at ${pad(t.hour)}.${pad(t.minute)}.${pad(t.second)}`;
}

/**
 * File names to try for a stem, in order: "Name.png", "Name (2).png", "Name (3).png", ...
 * The adapter takes the first one that does not exist yet.
 *
 * @param {string} stem
 * @param {string} ext extension without the dot
 * @returns {Generator<string>}
 */
export function* nameCandidates(stem, ext) {
    yield `${stem}.${ext}`;
    for (let i = 2; ; i++)
        yield `${stem} (${i}).${ext}`;
}

/** Extension (no dot) of a file name, '' when there is none. */
export function extensionOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1) : '';
}

/** @param {unknown} v @returns {number} one of TIMERS (anything else is None) */
export function normalizeTimer(v) {
    return TIMERS.includes(v) ? v : 0;
}

/** @param {unknown} v @returns {string} one of DESTINATIONS (anything else is GNOME's folder) */
export function normalizeDestination(v) {
    return DESTINATIONS.includes(v) ? v : 'pictures';
}

/**
 * Where a capture is kept, from the Save to option.
 *
 * @param {{saveTo: string, otherFolder: string}} options
 * @param {{desktop: string, documents: string}} dirs the user's folders
 * @returns {{kind: 'clipboard'}|{kind: 'stock'}|{kind: 'folder', path: string}}
 *   `stock` leaves the file in the folder GNOME saved it to (only renaming it)
 */
export function destinationFor(options, dirs) {
    switch (normalizeDestination(options.saveTo)) {
    case 'clipboard':
        return { kind: 'clipboard' };
    case 'desktop':
        return dirs.desktop ? { kind: 'folder', path: dirs.desktop } : { kind: 'stock' };
    case 'documents':
        return dirs.documents ? { kind: 'folder', path: dirs.documents } : { kind: 'stock' };
    case 'other':
        return options.otherFolder ? { kind: 'folder', path: options.otherFolder } : { kind: 'stock' };
    default:
        return { kind: 'stock' };
    }
}

/**
 * What to do with GNOME's file once the capture is committed.
 *
 * @param {{kind: string, path?: string}} destination from destinationFor()
 * @param {{path: string, name: string}} stock the file GNOME wrote
 * @param {{macosNames: boolean, stamp: object}} naming
 * @returns {{kind: 'trash'}|{kind: 'file', dir: string, stem: string, ext: string, same: boolean}}
 *   `same`: the target folder is where the file already is
 */
export function commitPlan(destination, stock, naming) {
    if (destination.kind === 'clipboard')
        return { kind: 'trash' };
    const slash = stock.path.lastIndexOf('/');
    const stockDir = slash > 0 ? stock.path.slice(0, slash) : '/';
    const ext = extensionOf(stock.name) || 'png';
    const dir = destination.kind === 'folder' ? destination.path : stockDir;
    const stem = naming.macosNames ? stampedName(naming.stamp) : stock.name.slice(0, stock.name.length - ext.length - 1);
    return { kind: 'file', dir, stem, ext, same: dir === stockDir };
}

/** @param {string} mode one of MODES @returns {{target: 'screen'|'window'|'selection', cast: boolean}} */
export function modeSpec(mode) {
    switch (mode) {
    case 'screen': return { target: 'screen', cast: false };
    case 'window': return { target: 'window', cast: false };
    case 'record-screen': return { target: 'screen', cast: true };
    case 'record-selection': return { target: 'selection', cast: true };
    default: return { target: 'selection', cast: false };
    }
}

/** The mode a stock screenshot UI state corresponds to. */
export function modeFrom(target, cast) {
    if (cast)
        return target === 'screen' ? 'record-screen' : 'record-selection';
    return target === 'screen' || target === 'window' ? target : 'selection';
}

/** Space during Shift+Super+4 swaps the area crosshair and window picking, like macOS. */
export function spaceToggle(target) {
    return target === 'window' ? 'selection' : 'window';
}

/** True when a dragged area is big enough to capture at once (Shift+Super+4). */
export function isCapturableArea(rect) {
    return !!rect && rect.width >= MIN_AREA && rect.height >= MIN_AREA;
}

/** Seconds shown by the timer countdown, e.g. 3 -> [3, 2, 1]. */
export function countdown(seconds) {
    const out = [];
    for (let s = normalizeTimer(seconds); s > 0; s--)
        out.push(s);
    return out;
}

/** The stock default area: the middle quarter of a monitor (js/ui/screenshot.js reset()). */
export function defaultSelection(monitor) {
    const x = monitor.x + Math.floor(monitor.width * 3 / 8);
    const y = monitor.y + Math.floor(monitor.height * 3 / 8);
    return {
        x, y,
        width: monitor.x + Math.floor(monitor.width * 5 / 8) - x,
        height: monitor.y + Math.floor(monitor.height * 5 / 8) - y,
    };
}

/** [x, y, w, h] as stored in settings -> rect, or null when it is not a valid area. */
export function selectionFromList(list) {
    if (!Array.isArray(list) || list.length !== 4 || !list.every(Number.isFinite))
        return null;
    const [x, y, width, height] = list;
    return width >= MIN_AREA && height >= MIN_AREA ? { x, y, width, height } : null;
}

export function selectionToList(rect) {
    return [rect.x, rect.y, rect.width, rect.height];
}

/**
 * The area to start the selection with: the last one when Remember Last Selection is on and
 * it still fits the stage (monitors may have changed), else the middle of the primary monitor.
 *
 * @param {{remember: boolean, last: ?object, stage: {width: number, height: number}, primary: object}} s
 */
export function startSelection({ remember, last, stage, primary }) {
    const fits = last && last.x >= 0 && last.y >= 0 &&
        last.x + last.width <= stage.width && last.y + last.height <= stage.height;
    return remember && fits ? last : defaultSelection(primary);
}

/** Size of the thumbnail picture: the image fitted into THUMBNAIL_BOX, never enlarged. */
export function thumbnailSize(imageWidth, imageHeight, box = THUMBNAIL_BOX) {
    if (!(imageWidth > 0 && imageHeight > 0))
        return { width: box.width, height: box.height };
    const k = Math.min(1, box.width / imageWidth, box.height / imageHeight);
    return { width: Math.max(1, Math.round(imageWidth * k)), height: Math.max(1, Math.round(imageHeight * k)) };
}

/** Resting position of a thumbnail: the bottom-right corner of a work area. */
export function thumbnailRest(area, size, margin = THUMBNAIL_BOX.margin) {
    return { x: area.x + area.width - size.width - margin, y: area.y + area.height - size.height - margin };
}

/** How far right (px) the thumbnail starts, so it slides in from the screen edge. */
export function thumbnailEntryOffset(area, rest) {
    return area.x + area.width - rest.x;
}

/**
 * Outcome of a horizontal drag on the thumbnail.
 *
 * @param {number} dx pixels dragged to the right
 * @param {number} width thumbnail width
 * @returns {'dismiss'|'cancel'} dismiss: saved at once and slid away
 */
export function swipeOutcome(dx, width) {
    return dx > width * 0.35 ? 'dismiss' : 'cancel';
}

/** A swipe only ever moves the thumbnail to the right (left is resisted, then clamped). */
export function swipeOffset(dx) {
    return dx > 0 ? dx : dx / 6;
}

/**
 * The thumbnail's auto-save clock. Hovering pauses it (macOS keeps a hovered thumbnail on
 * screen); leaving resumes with what was left. Times are monotonic milliseconds.
 */
export class ThumbnailLife {
    constructor(now, total = THUMBNAIL_MS) {
        this._left = total;
        this._since = now;
        this._paused = false;
    }

    /** Milliseconds until the auto-save, 0 when due. */
    remaining(now) {
        return this._paused ? this._left : Math.max(0, this._left - (now - this._since));
    }

    pause(now) {
        if (this._paused)
            return;
        this._left = this.remaining(now);
        this._paused = true;
    }

    resume(now) {
        if (!this._paused)
            return;
        this._since = now;
        this._paused = false;
    }

    get paused() {
        return this._paused;
    }
}
