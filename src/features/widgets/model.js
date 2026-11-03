// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop widget layer decisions (pure; tests/desktopWidgetsModel.test.js). The shared widget
// model (sizes, grid, snapping, persistence, providers) is core/widgets/model.js.

/** Widget style settings (macOS "Widget style": Automatic / Monochrome / Full-colour). */
export const STYLES = Object.freeze(['automatic', 'monochrome', 'full-color']);

/** Opacity of dimmed widgets (Sonoma fades them to about 60 %). */
export const DIM_OPACITY = 155;

/** Pixels the pointer must travel before a press on a widget becomes a drag. */
export const DRAG_THRESHOLD = 8;

/**
 * How desktop widgets look right now.
 *
 * Automatic: monochrome and dimmed while an app window is in front (a normal window has the
 * focus), full colour when the desktop is in front (nothing focused: a click on the
 * wallpaper, Show Desktop, Stage Manager's desktop) or while editing. High contrast never
 * dims, so text stays readable.
 *
 * @param {{style: string, windowInFront: boolean, editing: boolean, highContrast: boolean}} s
 * @returns {{mono: boolean, opacity: number}}
 */
export function widgetLook({ style, windowInFront, editing, highContrast }) {
    const dim = !editing && !highContrast &&
        (style === 'monochrome' || (style !== 'full-color' && windowInFront));
    return { mono: dim, opacity: dim ? DIM_OPACITY : 255 };
}

/**
 * Is a window "in front of the desktop"? The focused window, when it is a normal or dialog
 * window that is not minimized.
 *
 * @param {?{type: string, minimized: boolean}} focused WindowInfo (core/desktopModel.js)
 */
export function windowInFront(focused) {
    return !!focused && !focused.minimized && (focused.type === 'normal' || focused.type === 'dialog');
}

/**
 * Should a monitor's widgets keep their data live? Not in the overview (the layer is not
 * shown there) and not while a maximized or full-screen window covers that monitor on the
 * current workspace, unless the user is editing them.
 *
 * @param {{overview: boolean, editing: boolean, monitor: number, workspace: number,
 *   windows: Array<{monitor: number, workspace: number, minimized: boolean, maximized: boolean,
 *   fullscreen: boolean, type: string}>}} s
 */
export function widgetsLive({ overview, editing, monitor, workspace, windows }) {
    if (editing)
        return true;
    if (overview)
        return false;
    return !windows.some(w => w.monitor === monitor && !w.minimized && w.type === 'normal' &&
        (w.workspace === workspace || w.workspace === -1) && (w.maximized || w.fullscreen));
}

/** Has the pointer moved far enough from the press to start a drag? */
export function isDrag(dx, dy, threshold = DRAG_THRESHOLD) {
    return dx * dx + dy * dy >= threshold * threshold;
}

/**
 * Where the gallery panel goes: centred at the bottom of the usable area, above the dock.
 *
 * @param {{x: number, y: number, width: number, height: number}} area
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function galleryRect(area, scale = 1) {
    const width = Math.min(area.width - 32 * scale, 1080 * scale);
    const height = Math.min(area.height - 32 * scale, 380 * scale);
    return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + area.height - height - 16 * scale),
        width: Math.round(width),
        height: Math.round(height),
    };
}
