// SPDX-License-Identifier: GPL-3.0-or-later
// The one place that touches GNOME's screenshot UI (Main.screenshotUI, js/ui/screenshot.js).
// Guava drives it instead of reimplementing it: the stock UI captures the stage, draws the area
// selector and the window picker, writes the PNG (and the clipboard copy) and runs the
// screencast service. Everything else in the feature talks to this class.
//
// Public Shell API used: open(), close(), the 'screenshot-taken' and 'closed' signals, the
// 'screencast-in-progress' property, stopScreencast(), and the exported captureScreenshot().
//
// Private members (checked on GNOME Shell 50.6, js/ui/screenshot.js; every access is guarded
// with ?. so a renamed member only disables that part):
//   _selectionButton, _screenButton, _windowButton, _castButton (the mode toggles),
//   _showPointerButton, _panel, _closeButton (the stock bottom panel),
//   _areaSelector (getGeometry(), _startX/_startY/_lastX/_lastY, _updateSelectionRect(),
//   'drag-ended'), _windowSelectors (windows()), _onCaptureButtonClicked(), _screencastPath.

import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

const LOG = '[Guava]';

export class ScreenshotUiDriver {
    get ui() {
        return Main.screenshotUI ?? null;
    }

    get available() {
        return !!this.ui;
    }

    get visible() {
        return !!this.ui?.visible;
    }

    get recording() {
        return !!this.ui?.screencast_in_progress;
    }

    /** Path of the video GNOME is writing (or wrote last), null when it did not say. */
    get recordingPath() {
        return this.ui?._screencastPath ?? null;
    }

    /** True when GNOME's recorder is installed and allowed in this session. */
    get castAvailable() {
        const b = this.ui?._castButton;
        return !!b && b.visible && b.reactive;
    }

    /** True when the window picker has windows (and no recording mode is on). */
    get windowsAvailable() {
        return !!this.ui?._windowButton?.reactive;
    }

    /** @returns {Promise<void>} resolves once the UI is up (it captured the stage) */
    async open() {
        await this.ui?.open();
    }

    close(instantly = false) {
        this.ui?.close(instantly);
    }

    stopRecording() {
        this.ui?.stopScreencast();
    }

    /** @returns {'screen'|'window'|'selection'} */
    get target() {
        const ui = this.ui;
        if (ui?._screenButton?.checked)
            return 'screen';
        if (ui?._windowButton?.checked)
            return 'window';
        return 'selection';
    }

    /** @param {'screen'|'window'|'selection'} target */
    setTarget(target) {
        const ui = this.ui;
        const button = target === 'screen' ? ui?._screenButton
            : target === 'window' ? ui?._windowButton : ui?._selectionButton;
        if (!button || (target === 'window' && !button.reactive))
            return false;
        button.checked = true;
        return true;
    }

    get cast() {
        return !!this.ui?._castButton?.checked;
    }

    setCast(cast) {
        const b = this.ui?._castButton;
        if (!b || (cast && !this.castAvailable))
            return false;
        b.checked = cast;
        return true;
    }

    /** Call fn when the stock UI's mode changes (its own keys S, C, W and V also change it). */
    watchMode(cleanup, fn) {
        const ui = this.ui;
        for (const b of [ui?._selectionButton, ui?._screenButton, ui?._windowButton, ui?._castButton]) {
            if (b)
                cleanup.connect(b, 'notify::checked', fn);
        }
    }

    setPointer(show) {
        const b = this.ui?._showPointerButton;
        if (b && b.checked !== show)
            b.checked = show;
    }

    /** @returns {?{x: number, y: number, width: number, height: number}} the area, stage px */
    selection() {
        const g = this.ui?._areaSelector?.getGeometry?.();
        return g ? { x: g[0], y: g[1], width: g[2], height: g[3] } : null;
    }

    setSelection(rect) {
        const a = this.ui?._areaSelector;
        if (!a || typeof a._updateSelectionRect !== 'function')
            return;
        a._startX = rect.x;
        a._startY = rect.y;
        a._lastX = rect.x + rect.width - 1;
        a._lastY = rect.y + rect.height - 1;
        a._updateSelectionRect();
    }

    /** The area selector actor (for its 'drag-ended' signal), or null. */
    get areaSelector() {
        return this.ui?._areaSelector ?? null;
    }

    /** The window picker's buttons of the current session (St.Button, checked = chosen). */
    windowButtons() {
        return this.ui?._windowSelectors?.flatMap(s => s.windows()) ?? [];
    }

    /**
     * The Meta.Window chosen in the window picker, matched by its frame rectangle (the
     * picker keeps a copy of the window's texture, not the window).
     */
    chosenWindow() {
        const chosen = this.windowButtons().find(w => w.checked);
        const box = chosen?.boundingBox;
        if (!box)
            return null;
        return global.get_window_actors().map(a => a.meta_window).find(w => {
            const r = w.get_frame_rect();
            return r.x === box.x && r.y === box.y && r.width === box.width && r.height === box.height;
        }) ?? null;
    }

    /** Capture (or start recording) with the current choices, like the stock capture button. */
    clickCapture() {
        const ui = this.ui;
        if (typeof ui?._onCaptureButtonClicked !== 'function') {
            console.warn(`${LOG} screenshot UI has no capture method`);
            return;
        }
        ui._onCaptureButtonClicked().catch(e => console.error(`${LOG} capture failed:`, e));
    }

    /** Show or hide the stock bottom panel and its close button (Guava draws its own). */
    setStockPanelVisible(visible) {
        const ui = this.ui;
        for (const actor of [ui?._panel, ui?._closeButton]) {
            if (actor)
                actor.visible = visible;
        }
    }

    /**
     * Capture now, without the UI, the way GNOME's own "screenshot" shortcut does: the stage
     * (optionally cropped to `area`) or one window. GNOME writes the file and the clipboard copy.
     *
     * @param {{area?: object, window?: Meta.Window, pointer: boolean}} what
     * @returns {Promise<?Gio.File>}
     */
    async captureNow({ area = null, window = null, pointer }) {
        if (window) {
            const actor = window.get_compositor_private();
            if (!actor)
                return null;
            const texture = actor.paint_to_content(null).get_texture();
            return Screenshot.captureScreenshot(texture, null, actor.get_resource_scale(), null);
        }
        const shooter = new Shell.Screenshot();
        const [content, scale, cursorContent, cursorPoint, cursorScale] =
            await shooter.screenshot_stage_to_content();
        const geometry = area
            ? [area.x * scale, area.y * scale, area.width * scale, area.height * scale] : null;
        const cursor = pointer && cursorContent
            ? { texture: cursorContent.get_texture(), x: cursorPoint.x * scale, y: cursorPoint.y * scale, scale: cursorScale }
            : null;
        return Screenshot.captureScreenshot(content.get_texture(), geometry, scale, cursor);
    }
}
