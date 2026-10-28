// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history: records what was copied (text, links, colours, images), shows it in a
// top-bar popover and in Quick Paste (Super+Shift+V), and pastes into the previous window.
//
// - Watches Meta.Selection 'owner-changed'; no polling.
// - Policy (dedupe, cap, pins, mime and size limits, password-manager secrets) is model.js.
// - History is saved under ~/.local/share/guava/clipboard/ (store.js) and reloaded on enable,
//   because Guava tears down when the screen locks. Nothing is recorded while locked.
// - Everything is registered in the entry's CleanupRegistry; disable() has little left to do.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { PanelLayout } from '../../core/panelLayout.js';
import { MENU_CLOSE_ARGS } from '../../lib/compat.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { Keybindings, MODAL_MODES } from '../../lib/keybindings.js';
import { FOCUS_SETTLE_MS, sendPasteChord } from '../../lib/paste.js';
import { GuavaSettings } from '../../lib/settings.js';
import {
    DEFAULTS, History, TEXT_MIME, checkDimensions, checkSize, imageDimensions, imageFileName,
    isBlankText, isPasswordManagerApp, isSecret, looksSecret, makeEntry, mergeLoaded, orphanFiles, pickMime, shouldRecord,
} from './model.js';
import { ClipboardPopover } from './popover.js';
import { QuickPaste } from './quickPaste.js';
import { ClipboardStore } from './store.js';

Gio._promisify(Meta.Selection.prototype, 'transfer_async', 'transfer_finish');

const LOG = '[Guava]';
const SHORTCUT_KEY = 'clipboard-shortcut';
const SAVE_DELAY_MS = 600;
const MiB = 1024 * 1024;
const RAM_IMAGE_BUDGET = 64 * MiB;

function sha256(bytes) {
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
}

export class ClipboardHistory {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ = ctx.gettext ?? (s => s);
        this._enabled = false;
        this._history = new History();
        this._mem = new Map();          // image hash -> GLib.Bytes, only while persistence is off
        this._changed = new Set();
        this._copied = new Set();
        this._reading = false;
        this._again = null;
        this._readToken = 0;
        this._saveToken = 0;
        this._dirty = false;
        this._prevFocus = null;
        this._indicator = null;
        this._iconCleanup = null;
        this._loading = false;
        this._ownerSerial = 0;      // bumps on every clipboard owner change
        this._selfToken = 0;
        this._selfHash = null;      // hash of what we just wrote ourselves
    }

    // ---- lifecycle -------------------------------------------------------

    enable() {
        const cleanup = this._cleanup;
        this._enabled = true;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._store = new ClipboardStore();
        this._history = new History(this._limits);
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._cancellable = new Gio.Cancellable();

        cleanup.add(() => this._teardown());
        cleanup.connect(this._selection, 'owner-changed', (_s, type) => this._onOwnerChanged(type));

        this._quick = new QuickPaste(cleanup, this, this._);
        Keybindings.add(cleanup, SHORTCUT_KEY, this._ctx.settings, () => this._onShortcut(), { modes: MODAL_MODES });
        cleanup.idle(() => this._warnConflicts(), { name: 'clipboard-conflicts' });

        this._ks.watch('clipboard-history-size', () => this._applyCap());
        this._ks.watch('clipboard-persist', () => this._onPersistChanged());
        this._ks.watch('clipboard-panel-icon', () => this._syncIndicator());
        this._ks.watch(['clipboard-recording', 'clipboard-images', 'clipboard-ignore-sensitive',
            'clipboard-excluded-apps', SHORTCUT_KEY], () => this._emitChanged());
        this._syncIndicator();

        if (this._persist) {
            // Until the saved history is in, nothing is written: a save now would replace
            // history.json with only what was copied since enable
            this._loading = true;
            this._store.prepare().then(() => this._load())
                .catch(e => console.warn(`${LOG} clipboard store not ready: ${e.message}`))
                .finally(() => {
                    this._loading = false;
                });
        } else {
            // Persistence is off: remove the files Guava saved earlier
            this._store.clearAll();
        }
    }

    disable() {
        // Cleanup registry runs _teardown
    }

    _teardown() {
        this._enabled = false;
        this._cancellable?.cancel();
        // Write what is pending; the write is plain async Gio and touches no Shell state
        if (this._dirty && this._persist && !this._loading)
            this._store?.saveIndex(this._history);
        this._dirty = false;
        this._iconCleanup?.dispose();
        this._iconCleanup = null;
        this._indicator = null;
        this._quick = null;
        this._mem.clear();
        this._changed.clear();
        this._copied.clear();
        this._prevFocus = null;
        this._selection = null;
        this._clipboard = null;
    }

    // ---- settings --------------------------------------------------------

    get _persist() {
        return this._ks.bool('clipboard-persist');
    }

    get _limits() {
        return {
            ...DEFAULTS,
            maxTotalImageBytes: this._persist ? DEFAULTS.maxTotalImageBytes : RAM_IMAGE_BUDGET,
            maxItems: this._ks.int('clipboard-history-size'),
            images: this._ks.bool('clipboard-images'),
            ignoreSensitive: this._ks.bool('clipboard-ignore-sensitive'),
        };
    }

    get recording() {
        return this._ks.bool('clipboard-recording');
    }

    setRecording(on) {
        this._ks.setBool('clipboard-recording', !!on);
    }

    get shortcut() {
        return this._ks.strv(SHORTCUT_KEY)[0] ?? '';
    }

    _applyCap() {
        const evicted = this._history.configure(this._limits);
        this._dropFiles(evicted);
        this._touched();
    }

    _onPersistChanged() {
        this._dropFiles(this._history.configure(this._limits));
        if (this._persist) {
            // Turned on: write what we hold, images included
            this._store.prepare().catch(e => console.warn(`${LOG} clipboard store not ready: ${e.message}`));
            for (const e of this._history.items) {
                const bytes = this._mem.get(e.hash);
                if (e.kind === 'image' && bytes)
                    this._store.writeImage(e.file, bytes);
            }
            this._mem.clear();
            this._dirty = true;
            this._saveNow();
        } else {
            // Turned off: stop keeping anything on disk. Images stay in memory for this session;
            // read them back first, then delete the files.
            this._cancelSave();
            this._dirty = false;
            const reads = this._history.items.filter(e => e.kind === 'image').map(async e => {
                const b = await this._store.readImage(e.file);
                if (b && this._enabled)
                    this._mem.set(e.hash, b);
            });
            Promise.all(reads).then(() => this._persist || this._store.clearAll());
        }
    }

    // ---- loading and saving ---------------------------------------------

    async _load() {
        const { entries, intact } = await this._store.load(this._limits);
        if (!this._enabled)
            return;
        // Entries recorded while loading are newer; they win over saved copies of themselves
        const { history, evicted } = mergeLoaded(this._history.items, entries, this._limits);
        this._history = history;
        this._dropFiles(evicted);
        // Remove image files nothing points to (Guava wrote them; nothing else is touched)
        // Not after a failed load: those files may belong to the index that was moved aside
        if (intact)
            this._store.sweep(this._history, orphanFiles);
        // Write the merged history (copies made during the load, sizes checked on load)
        this._loading = false;
        this._touched();
    }

    _touched() {
        this._dirty = true;
        this._emitChanged();
        if (!this._persist || this._saveToken)
            return;
        this._saveToken = this._cleanup.timeout(SAVE_DELAY_MS, () => {
            this._saveToken = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        }, { name: 'clipboard-save' });
    }

    _cancelSave() {
        if (this._saveToken)
            this._cleanup.release(this._saveToken);
        this._saveToken = 0;
    }

    _saveNow() {
        this._cancelSave();
        if (!this._dirty || !this._persist || this._loading)
            return;       // still dirty: the save after the load writes it
        this._dirty = false;
        this._store.saveIndex(this._history);
    }

    _dropFiles(entries) {
        const images = entries.filter(e => e.kind === 'image');
        images.forEach(e => this._mem.delete(e.hash));
        if (images.length && this._persist)
            this._store.deleteImages(images.map(e => e.file));
    }

    // ---- recording -------------------------------------------------------

    _isLocked() {
        return !!(Main.sessionMode.isLocked || Main.screenShield?.locked);
    }

    _canRecord() {
        return shouldRecord({ enabled: this._enabled, recording: this.recording, locked: this._isLocked() });
    }

    _onOwnerChanged(type) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        this._ownerSerial++;
        if (!this._canRecord()) {
            this._selfHash = null;
            return;
        }
        // Who copied: the focused window now. The read happens a moment later.
        const win = global.display.focus_window;
        const shellApp = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
        const cls = win?.get_wm_class() ?? '';
        const app = { cls, id: shellApp?.get_id() ?? '', name: shellApp?.get_name() ?? cls };
        if (this._readToken)
            this._cleanup.release(this._readToken);
        this._readToken = this._cleanup.idle(() => {
            this._readToken = 0;
            this._read(app);
            return GLib.SOURCE_REMOVE;
        }, { name: 'clipboard-read' });
    }

    async _read(app) {
        if (this._reading) {
            this._again = app;
            return;
        }
        this._reading = true;
        try {
            await this._readOnce(app);
        } catch (e) {
            if (this._enabled)
                console.warn(`${LOG} clipboard read failed: ${e.message}`);
        } finally {
            this._reading = false;
            const next = this._again;
            this._again = null;
            if (next && this._enabled)
                this._read(next);
        }
    }

    _isSecretSource(mimes, app) {
        const limits = this._limits;
        const extra = this._ks.strv('clipboard-excluded-apps');
        if (isSecret({ mimes, app: app.cls, ignoreSensitive: limits.ignoreSensitive, extraApps: extra }))
            return true;
        return limits.ignoreSensitive &&
            [app.id, app.name].some(a => isPasswordManagerApp(a, extra));
    }

    /** Still the same copy, still allowed, still not a secret? Checked after every await. */
    _stillValid(serial, app) {
        if (!this._enabled || serial !== this._ownerSerial || !this._canRecord())
            return false;
        const mimes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        return !this._isSecretSource(mimes, app);
    }

    async _readOnce(app) {
        const serial = this._ownerSerial;
        if (!this._canRecord())
            return;
        const limits = this._limits;
        const mimes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        if (this._isSecretSource(mimes, app))
            return;
        const pick = pickMime(mimes, { images: limits.images });
        if (!pick)
            return;

        const cap = pick.kind === 'image' ? limits.maxImageBytes : limits.maxTextBytes;
        const bytes = await this._transfer(pick.mime, cap);
        if (!bytes || !this._stillValid(serial, app))
            return;
        if (checkSize(pick.kind, bytes.get_size(), limits) !== 'ok')
            return;
        const hash = sha256(bytes);
        if (this._selfHash === hash) {
            // Our own write (popover click or paste): not a new copy
            this._selfHash = null;
            return;
        }
        this._selfHash = null;

        let entry;
        if (pick.kind === 'text') {
            const text = new TextDecoder().decode(bytes.toArray());
            if (isBlankText(text))
                return;
            // Private keys, tokens, card numbers: not recorded (heuristic, see model.js)
            if (limits.ignoreSensitive && looksSecret(text))
                return;
            entry = makeEntry({
                kind: 'text', hash, mime: TEXT_MIME, size: bytes.get_size(),
                time: Date.now(), text, app: app.name,
            });
        } else {
            // Pixel size from the header, before anything decodes it: a small file can still
            // be 30000 x 30000 pixels, which would stall the Shell on every thumbnail
            const dim = imageDimensions(bytes.toArray());
            if (checkDimensions(dim, limits) !== 'ok')
                return;
            entry = makeEntry({
                kind: 'image', hash, mime: pick.mime, size: bytes.get_size(), time: Date.now(),
                file: imageFileName(hash, pick.mime), app: app.name,
                width: dim.width, height: dim.height,
            });
        }
        this._record(entry, bytes);
    }

    /**
     * Read one mime type, at most `cap` bytes. Fails closed: null on any error, on empty data
     * and when the data is larger than the cap. No uncapped fallback.
     */
    async _transfer(mime, cap) {
        try {
            const out = Gio.MemoryOutputStream.new_resizable();
            // One byte over the cap tells "too big" from "exactly the cap"
            await this._selection.transfer_async(
                Meta.SelectionType.SELECTION_CLIPBOARD, mime, cap + 1, out, this._cancellable);
            out.close(null);
            const bytes = out.steal_as_bytes();
            return bytes.get_size() > 0 && bytes.get_size() <= cap ? bytes : null;
        } catch (e) {
            if (this._enabled)
                console.debug(`${LOG} clipboard transfer skipped: ${e.message}`);
            return null;
        }
    }

    _record(entry, bytes) {
        const result = this._history.add(entry);
        if (result.status === 'refused')
            return;       // pinned entries already use the byte budget
        if (result.status === 'added' && entry.kind === 'image') {
            if (this._persist)
                this._store.writeImage(entry.file, bytes);
            else
                this._mem.set(entry.hash, bytes);
        }
        this._dropFiles(result.evicted);
        this._touched();
        for (const fn of [...this._copied])
            fn(result.entry);
    }

    // ---- controller API (popover, Quick Paste, Spotlight, notch) -------------

    get count() {
        return this._history.size;
    }

    view(query) {
        return this._history.view(query);
    }

    get(id) {
        return this._history.get(id);
    }

    /** Newest entries, pinned not first. @param {number} n */
    latest(n) {
        return this._history.items.slice(0, n);
    }

    /** Text search for Spotlight. @returns {object[]} */
    search(query, limit = 5) {
        const { pinned, recent } = this._history.view({ query });
        return [...pinned, ...recent].slice(0, limit);
    }

    connectChanged(fn) {
        this._changed.add(fn);
        return () => this._changed.delete(fn);
    }

    /** fn(entry) after something was recorded. The notch shows its "Copied" pill from this. */
    connectCopied(fn) {
        this._copied.add(fn);
        return () => this._copied.delete(fn);
    }

    _emitChanged() {
        for (const fn of [...this._changed])
            fn();
    }

    togglePin(id) {
        if (this._history.togglePin(id) !== null)
            this._touched();
    }

    remove(id) {
        const gone = this._history.remove(id);
        if (!gone)
            return;
        this._dropFiles([gone]);
        this._touched();
    }

    /** Clear History: everything but pinned entries, files included. */
    clear() {
        this._dropFiles(this._history.clear({ keepPinned: true }));
        this._touched();
    }

    /** gicon for an image entry, made when a row or the preview asks for it. */
    iconFor(entry) {
        // Only images whose header size was checked are ever handed to St to decode
        if (entry.kind !== 'image' ||
            checkDimensions({ width: entry.width, height: entry.height }, this._limits) !== 'ok')
            return null;
        const mem = this._mem.get(entry.hash);
        if (mem)
            return Gio.BytesIcon.new(mem);
        const file = this._store.imageFile(entry.file);
        return file ? new Gio.FileIcon({ file }) : null;
    }

    async _setClipboard(entry) {
        this._selfHash = entry.hash;      // the owner-changed that follows is ours
        // Forget it after a second, so a genuine identical copy later is not skipped
        if (this._selfToken)
            this._cleanup.release(this._selfToken);
        this._selfToken = this._cleanup.timeout(1000, () => {
            this._selfToken = 0;
            this._selfHash = null;
            return GLib.SOURCE_REMOVE;
        }, { name: 'clipboard-self-write' });
        if (entry.kind === 'text') {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
            return true;
        }
        const bytes = this._mem.get(entry.hash) ?? await this._store.readImage(entry.file);
        if (!bytes || !this._enabled) {
            this._selfHash = null;
            return false;
        }
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mime, bytes);
        return true;
    }

    /** Put an entry on the clipboard (popover click). */
    async copy(entry, { close = false } = {}) {
        if (!await this._setClipboard(entry))
            return;
        if (close)
            this._indicator?.menu.close(MENU_CLOSE_ARGS);
    }

    /** Put an entry on the clipboard and send the paste chord to the window that had focus. */
    async paste(entry) {
        const prev = this._prevFocus;
        if (!await this._setClipboard(entry))
            return;
        this._quick?.close();
        this._indicator?.menu.close(MENU_CLOSE_ARGS);
        this._cleanup.timeout(FOCUS_SETTLE_MS, () => {
            this._sendPaste(prev);
            return GLib.SOURCE_REMOVE;
        }, { name: 'clipboard-paste' });
    }

    // ---- shortcut and paste ------------------------------------------------

    _onShortcut() {
        if (!this._enabled)
            return;
        if (this._quick.isOpen) {
            this._quick.close();
            return;
        }
        this._prevFocus = global.display.focus_window;
        this._indicator?.menu.close(MENU_CLOSE_ARGS);
        this._quick.toggle();
    }

    _warnConflicts() {
        try {
            const found = Keybindings.conflicts(this._ks.strv(SHORTCUT_KEY));
            for (const c of found)
                console.warn(`${LOG} ${c.accel} is also bound to ${c.with}`);
        } catch (e) {
            console.debug(`${LOG} shortcut conflict scan failed: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    }

    _sendPaste(prev) {
        // Only into the window that had focus, only unlocked, only if it still has focus
        if (this._enabled && !this._isLocked() && prev)
            sendPasteChord(prev);
    }

    // ---- panel icon ----------------------------------------------------------

    _syncIndicator() {
        const want = this._ks.bool('clipboard-panel-icon');
        if (want && !this._indicator)
            this._addIndicator();
        else if (!want && this._indicator)
            this._removeIndicator();
    }

    _addIndicator() {
        const reg = new CleanupRegistry();
        const button = new PanelMenu.Button(0.5, this._('Clipboard History'), false);
        reg.actor(button);
        button.add_child(new St.Icon({ icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon' }));
        Main.panel.addToStatusArea('guava-clipboard', button, 0, 'right');
        PanelLayout.claim(reg, {
            id: 'clipboard', actor: button.container, box: 'right',
            // The menu bar's privacy dots stay next to the Control Center, as on macOS
            anchor: { before: ['guava-menubar-privacy', 'quickSettings'], fallback: 'last' },
        });
        new ClipboardPopover(button.menu, this, reg, this._);
        this._iconCleanup = reg;
        this._indicator = button;
    }

    _removeIndicator() {
        this._iconCleanup?.dispose();
        this._iconCleanup = null;
        this._indicator = null;
    }
}
