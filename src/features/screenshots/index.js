// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshots feature entry (features.js id 'screenshots'): the macOS capture shortcuts, the
// Shift+Command+5 toolbar and the floating thumbnail, built on GNOME's own screenshot UI
// (uiDriver.js), never a second implementation of it.
//
//   Shift+Super+3  capture the entire screen at once (like GNOME's own "screenshot" shortcut)
//   Shift+Super+4  the stock UI as a bare crosshair: releasing a drag captures; Space switches
//                  to picking a window (a click captures it) and back
//   Shift+Super+5  the stock UI with Guava's glass toolbar instead of the stock panel; while a
//                  recording runs it stops it, and while a timer counts down it cancels it
//
// GNOME's shortcuts (Print, Shift+Print, Alt+Print, Ctrl+Alt+Shift+R) are not touched.
//
// After a capture GNOME has written the PNG to ~/Pictures/Screenshots and put it on the
// clipboard. Guava drops GNOME's "Screenshot captured" banner, shows the thumbnail, and on
// commit (5 s, a swipe, Close, or right away without a thumbnail) moves that one file to the
// Save to folder under its macOS name (files.js). Save to Clipboard moves it to the Trash.
//
// Recordings: GNOME's screencast service records; Guava emits 'recording-started' and
// 'recording-stopped' on ctx.events for the notch's live activity.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { Keybindings, MODAL_MODES } from '../../lib/keybindings.js';
import { GuavaSettings } from '../../lib/settings.js';
import { Countdown } from './countdown.js';
import { commitFile, openInViewer, showInFiles, stampOf, trashFile, userDirs } from './files.js';
import { pickFolder } from './folderPicker.js';
import {
    commitPlan, destinationFor, isCapturableArea, modeFrom, modeSpec, normalizeTimer,
    selectionFromList, selectionToList, spaceToggle, startSelection,
} from './model.js';
import { FloatingThumbnail } from './thumbnail.js';
import { ScreenshotToolbar } from './toolbar.js';
import { ScreenshotUiDriver } from './uiDriver.js';

const LOG = '[Guava]';
const CAPTURE_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter, Clutter.KEY_space];

export class Screenshots {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ = s => ctx.gettext(s);
        this._ks = null;
        this._driver = new ScreenshotUiDriver();
        this._session = null;   // {kind: 'area'|'toolbar', cleanup, toolbar?}
        this._pending = null;   // {file, stamp, thumbnail, done: Promise}
        this._timed = null;     // Countdown of a timed screenshot (UI closed)
        this._recording = false;
        this._lastMode = 'selection';
        this._opening = false;
    }

    enable() {
        const cleanup = this._cleanup;
        const ui = this._driver.ui;
        if (!ui) {
            console.warn(`${LOG} screenshots: the Shell has no screenshot UI`);
            return;
        }
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._layout = this._ctx.layout.acquire(cleanup);
        this._cancellable = new Gio.Cancellable();
        cleanup.add(() => this._cancellable.cancel());

        const bind = (key, fn, opts) => {
            if (this._ks.strv(key).length)
                Keybindings.add(cleanup, key, this._ctx.settings, fn, opts);
        };
        bind('screenshots-shortcut-screen', () => this.captureScreen());
        bind('screenshots-shortcut-selection', () => this.captureSelection());
        bind('screenshots-shortcut-toolbar', () => this.toggleToolbar(), { modes: MODAL_MODES });

        cleanup.connect(ui, 'screenshot-taken', (_ui, file) => {
            if (this._session && this._driver.target === 'selection')
                this._rememberSelection();
            this._captured(file);
        });
        cleanup.connect(ui, 'closed', () => this._endSession());
        cleanup.connect(ui, 'notify::screencast-in-progress', () => this._syncRecording());

        // Keep GNOME's "Screenshot captured" banner from showing: the thumbnail replaces it
        Main.messageTray.getSources().forEach(source => this._watchStockSource(source));
        cleanup.connect(Main.messageTray, 'source-added', (_t, source) => this._watchStockSource(source));

        // Newest first: the UI closes, then a waiting capture is saved and its thumbnail goes
        cleanup.add(() => this._flushPending());
        cleanup.add(() => this._cancelTimed());
        cleanup.add(() => {
            const open = !!this._session;
            this._endSession();
            if (open)
                this._driver.close(true);
        });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    // ---- the three shortcuts -----------------------------------------------------------

    /** Shift+Super+3: the entire screen, now. */
    captureScreen() {
        if (this._driver.visible || this._timed)
            return;
        this._driver.captureNow({ pointer: this._ks.bool('screenshots-show-pointer') })
            .then(file => file && this._captured(file))
            .catch(e => console.error(`${LOG} screenshot failed:`, e));
    }

    /** Shift+Super+4: drag an area (or Space, then click a window). */
    captureSelection() {
        if (this._session?.kind === 'area') {
            this._driver.close();
            return;
        }
        this._openSession('area').catch(e => console.error(`${LOG} screenshot UI failed:`, e));
    }

    /** Shift+Super+5: the toolbar; stops a recording; cancels a timer. */
    toggleToolbar() {
        if (this._driver.recording) {
            this._driver.stopRecording();
        } else if (this._timed) {
            this._cancelTimed();
        } else if (this._session) {
            this._driver.close();
        } else {
            this._openSession('toolbar').catch(e => console.error(`${LOG} screenshot UI failed:`, e));
        }
    }

    // ---- a session of the stock UI -----------------------------------------------------

    async _openSession(kind) {
        if (this._driver.visible || this._driver.recording || this._opening || this._timed)
            return;
        this._opening = true;
        try {
            await this._driver.open();
        } finally {
            this._opening = false;
        }
        if (!this._driver.visible || this._session)
            return;
        const driver = this._driver;
        const s = { kind, cleanup: new CleanupRegistry(), toolbar: null, countdown: null };
        this._session = s;
        driver.setPointer(this._ks.bool('screenshots-show-pointer'));
        const stage = { width: global.stage.width, height: global.stage.height };
        driver.setSelection(startSelection({
            remember: this._ks.bool('screenshots-remember-selection'),
            last: selectionFromList(this._ks.raw.get_value('screenshots-last-selection').deepUnpack()),
            stage, primary: Main.layoutManager.primaryMonitor,
        }));
        driver.setStockPanelVisible(false);
        s.cleanup.add(() => driver.setStockPanelVisible(true));
        s.cleanup.connect(driver.ui, 'key-press-event', (_a, ev) => this._key(s, ev));
        if (kind === 'area')
            this._startArea(s);
        else
            this._startToolbar(s);
    }

    _endSession() {
        const s = this._session;
        if (!s)
            return;
        this._session = null;
        s.countdown?.destroy();
        s.toolbar?.destroy();
        s.cleanup.dispose();
    }

    _startArea(s) {
        const driver = this._driver;
        driver.setCast(false);
        driver.setTarget('selection');
        const area = driver.areaSelector;
        if (area) {
            s.cleanup.connect(area, 'drag-ended', () => {
                if (isCapturableArea(driver.selection()))
                    driver.clickCapture();
            });
        }
        for (const button of driver.windowButtons())
            s.cleanup.connect(button, 'clicked', () => driver.target === 'window' && driver.clickCapture());
    }

    _startToolbar(s) {
        const driver = this._driver;
        s.toolbar = new ScreenshotToolbar({
            parent: driver.ui, ks: this._ks, area: this._primaryWorkArea(), motion: this._ctx.motion, _: this._,
            on: {
                mode: mode => this._setMode(mode),
                capture: () => this._toolbarCapture(s),
                close: () => driver.close(),
                pickFolder: () => this._pickFolder(),
            },
        });
        driver.watchMode(s.cleanup, () => this._syncToolbar(s));
        this._setMode(this._lastMode);
    }

    _setMode(mode) {
        const driver = this._driver;
        const spec = modeSpec(mode);
        driver.setCast(spec.cast);
        if (!driver.setTarget(spec.target))
            driver.setTarget('selection');
        if (this._session)
            this._syncToolbar(this._session);
    }

    _syncToolbar(s) {
        if (!s.toolbar)
            return;
        const mode = modeFrom(this._driver.target, this._driver.cast);
        this._lastMode = mode;
        s.toolbar.sync({ mode, castAvailable: this._driver.castAvailable, windowsAvailable: this._driver.windowsAvailable });
    }

    _key(s, event) {
        const sym = event.get_key_symbol();
        if (s.kind === 'area' && sym === Clutter.KEY_space) {
            this._driver.setTarget(spaceToggle(this._driver.target));
            return Clutter.EVENT_STOP;
        }
        if (s.kind === 'toolbar' && sym === Clutter.KEY_Escape && s.toolbar?.optionsOpen) {
            s.toolbar.toggleOptions(false);
            return Clutter.EVENT_STOP;
        }
        if (s.kind === 'toolbar' && CAPTURE_KEYS.includes(sym)) {
            this._toolbarCapture(s);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** The toolbar's Capture / Record, after the Timer when one is set. */
    _toolbarCapture(s) {
        if (s.countdown)
            return;
        const driver = this._driver;
        const seconds = normalizeTimer(this._ks.int('screenshots-timer'));
        s.toolbar?.toggleOptions(false);
        if (!seconds) {
            driver.clickCapture();
            return;
        }
        if (driver.cast) {
            // The recording starts after the countdown; the UI (and the area) stays up till then
            s.toolbar?.setHidden(true);
            s.countdown = new Countdown({
                seconds, parent: driver.ui, _: this._,
                onDone: () => {
                    s.countdown = null;
                    driver.clickCapture();
                },
                onCancel: () => {
                    s.countdown = null;
                    s.toolbar?.setHidden(false);
                },
            });
            return;
        }
        // A screenshot is taken fresh after the countdown, with the UI closed, so whatever the
        // user sets up meanwhile (an open menu) is in it
        const what = {
            area: driver.target === 'selection' ? driver.selection() : null,
            window: driver.target === 'window' ? driver.chosenWindow() : null,
            pointer: this._ks.bool('screenshots-show-pointer'),
        };
        if (what.area)
            this._rememberSelection();
        driver.close(true);
        this._timed = new Countdown({
            seconds, parent: null, _: this._,
            onDone: () => {
                this._timed = null;
                driver.captureNow(what).then(file => file && this._captured(file))
                    .catch(e => console.error(`${LOG} timed screenshot failed:`, e));
            },
            onCancel: () => {
                this._timed = null;
            },
        });
    }

    _cancelTimed() {
        this._timed?.destroy();
        this._timed = null;
    }

    _rememberSelection() {
        const rect = this._driver.selection();
        if (this._ks.bool('screenshots-remember-selection') && isCapturableArea(rect))
            this._ks.raw.set_value('screenshots-last-selection', new GLib.Variant('ai', selectionToList(rect)));
    }

    async _pickFolder() {
        const s = this._session;
        s?.toolbar?.toggleOptions(false);
        const path = await pickFolder(this._('Save Screenshots To'), this._cancellable);
        if (!path)
            return;
        this._ks.setString('screenshots-other-folder', path);
        this._ks.setString('screenshots-save-to', 'other');
    }

    // ---- recordings ----------------------------------------------------------------

    _syncRecording() {
        const on = this._driver.recording;
        if (on === this._recording)
            return;
        this._recording = on;
        if (on)
            this._ctx.events.emit('recording-started', { kind: this._driver.target === 'screen' ? 'screen' : 'area' });
        else
            this._ctx.events.emit('recording-stopped', { path: this._driver.recordingPath });
    }

    // ---- after a capture -------------------------------------------------------------

    _captured(file) {
        this._dropStockBanner();
        this._flushPending();
        const pending = { file, stamp: stampOf(GLib.DateTime.new_now_local()), thumbnail: null, done: null };
        this._pending = pending;
        if (!this._ks.bool('screenshots-thumbnail')) {
            this._commit(pending);
            return;
        }
        const area = this._primaryWorkArea();
        pending.thumbnail = new FloatingThumbnail({
            file, area, motion: this._ctx.motion, _: this._, destinations: this._destinations(),
            on: {
                expire: () => this._finish(pending, 'slide'),
                swipe: () => this._finish(pending, 'slide'),
                close: () => this._finish(pending, 'slide'),
                open: () => this._finish(pending, 'fade', openInViewer),
                showInFiles: () => this._finish(pending, 'fade', showInFiles),
                saveTo: value => this._finish(pending, 'slide', null, value),
                remove: () => this._remove(pending),
            },
        });
    }

    _primaryWorkArea() {
        const monitor = Main.layoutManager.primaryIndex;
        return this._layout.workArea(monitor) ?? Main.layoutManager.getWorkAreaForMonitor(monitor);
    }

    _destinations() {
        const _ = this._;
        const list = [['desktop', _('Desktop')], ['documents', _('Documents')], ['clipboard', _('Clipboard')],
            ['pictures', _('Pictures/Screenshots')]];
        const other = this._ks.string('screenshots-other-folder');
        if (other)
            list.push(['other', GLib.path_get_basename(other)]);
        return list;
    }

    /** Commit the capture (once), dismiss its thumbnail, then run `then(file)`. */
    _finish(pending, how, then = null, saveTo = null) {
        pending.thumbnail?.dismiss(how);
        this._commit(pending, saveTo).then(file => file && then?.(file));
    }

    _remove(pending) {
        pending.thumbnail?.dismiss('fade');
        if (this._pending === pending)
            this._pending = null;
        if (pending.done)
            return;
        pending.done = trashFile(pending.file, null).then(() => null)
            .catch(e => console.warn(`${LOG} deleting the screenshot failed: ${e.message}`));
    }

    /**
     * Move GNOME's file to where Save to says (or `saveTo` for this capture). Runs once per
     * capture; later calls get the same promise. Not cancelled on disable: the user's
     * screenshot always reaches its folder.
     *
     * @returns {Promise<?Gio.File>}
     */
    _commit(pending, saveTo = null) {
        if (pending.done)
            return pending.done;
        if (this._pending === pending)
            this._pending = null;
        const ks = this._ks;
        const destination = destinationFor({
            saveTo: saveTo ?? ks.string('screenshots-save-to'),
            otherFolder: ks.string('screenshots-other-folder'),
        }, userDirs());
        const plan = commitPlan(destination, { path: pending.file.get_path(), name: pending.file.get_basename() },
            { macosNames: ks.bool('screenshots-macos-names'), stamp: pending.stamp });
        pending.done = commitFile(pending.file, plan).catch(e => {
            console.warn(`${LOG} saving the screenshot failed: ${e.message}`);
            return pending.file;
        });
        return pending.done;
    }

    /** Save a capture that is still waiting (a new capture came, or Guava stops). */
    _flushPending() {
        const p = this._pending;
        if (!p)
            return;
        this._pending = null;
        p.thumbnail?.destroy();
        this._commit(p);
    }

    /**
     * GNOME's "Screenshot captured" notification points at the file before Guava moves it, and
     * the thumbnail replaces it. It is the notification with an image from GNOME's "Screen
     * Capture" source (js/ui/screenshot.js _storeScreenshot, GNOME 50). Marked acknowledged
     * when it is added, the tray (and the notch) never show it as a banner; _captured() then
     * removes it.
     */
    _watchStockSource(source) {
        if (!isStockCaptureSource(source))
            return;
        this._cleanup.connect(source, 'notification-added', (_s, notification) => {
            if (notification.gicon instanceof St.ImageContent)
                notification.acknowledged = true;
        });
    }

    _dropStockBanner() {
        const source = Main.messageTray.getSources().find(isStockCaptureSource);
        const notification = source?.notifications?.findLast?.(n => n.gicon instanceof St.ImageContent);
        notification?.destroy();
    }
}

function isStockCaptureSource(source) {
    // The source's icon is a Gio.ThemedIcon in `icon`. Source.iconName reads `gicon`, which a
    // Source does not have, so it never answers (GNOME 48-51).
    return source?.icon instanceof Gio.ThemedIcon &&
        source.icon.get_names().includes('screenshooter-symbolic');
}
