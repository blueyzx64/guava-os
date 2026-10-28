// SPDX-License-Identifier: GPL-3.0-or-later
// Emoji & Symbols (macOS Character Viewer, Control-Command-Space): Super+Ctrl+Space opens a
// glass popover at the text caret (centred when the app reports none) with a searchable emoji
// grid, recents, categories and skin tones. Picking an emoji types it into the window that had
// focus:
//   1. through the Shell's input method when that window is a text-input client (GTK, Qt,
//      Electron with IME): the text arrives as typed, the clipboard is untouched;
//   2. otherwise the Quick Paste technique (lib/paste.js): the emoji goes on the clipboard, a
//      virtual keyboard sends the paste chord, and the previous clipboard comes back.
// The data is IBus's emoji dictionary (data.js), read once on the first open.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Caret } from '../../lib/caret.js';
import { Keybindings, MODAL_MODES } from '../../lib/keybindings.js';
import { ModalSurface } from '../../lib/modalSurface.js';
import {
    CLIPBOARD_RESTORE_MS, FOCUS_SETTLE_MS, commitText, restoreClipboard, saveClipboard, sendPasteChord,
    setClipboardText,
} from '../../lib/paste.js';
import { GuavaSettings } from '../../lib/settings.js';
import { loadEmojiData } from './data.js';
import { buildCatalog, firstCategory, pushRecent } from './model.js';
import { EmojiView } from './view.js';

const LOG = '[Guava]';
const WIDTH = 372;
const HEIGHT = 404;

export class EmojiPicker {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._catalog = null;
        this._status = 'idle';     // idle | loading | ready | missing
        this._prevFocus = null;
        this._anchor = null;
        this._lastInsert = null;    // {char, method} for the harness
    }

    enable() {
        const cleanup = this._cleanup;
        const _ = this._ctx.gettext ?? (s => s);
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._cancellable = new Gio.Cancellable();
        cleanup.add(() => this._cancellable.cancel());
        this._caret = Caret.acquire(cleanup);

        this._view = new EmojiView({
            gettext: _,
            catalog: () => this._catalog,
            status: () => this._status,
            recents: () => this._ks.strv('emoji-recents'),
            tone: () => this._ks.int('emoji-skin-tone'),
            setTone: tone => this._ks.setInt('emoji-skin-tone', tone),
            onPick: char => this.insert(char),
        });
        this._modal = new ModalSurface(cleanup, {
            id: 'emoji',
            accessibleName: _('Emoji & Symbols'),
            width: WIDTH,
            height: HEIGHT,
            position: 'at',
            anchor: () => this._anchor,
            radius: 18,
            styleClass: 'guava-emoji',
            build: frame => this._view.build(frame, firstCategory(this._catalog, this._ks.strv('emoji-recents'))),
            onCapturedKey: event => this._view.onCapturedKey(event),
            onClosed: () => this._view.destroy(),
        });
        Keybindings.add(cleanup, 'emoji-shortcut', this._ctx.settings, () => this.toggle(), { modes: MODAL_MODES });
    }

    disable() {
        // Everything is in the cleanup registry
        this._catalog = null;
        this._prevFocus = null;
    }

    get isOpen() {
        return this._modal?.isOpen ?? false;
    }

    /** For the harness. */
    get state() {
        return {
            open: this.isOpen, status: this._status, anchor: this._anchor, lastInsert: this._lastInsert,
            frame: this._modal?.frame ? (() => {
                const [x, y] = this._modal.frame.get_transformed_position();
                return { x: Math.round(x), y: Math.round(y), width: Math.round(this._modal.frame.width) };
            })() : null,
            view: this.isOpen ? this._view.state : null,
        };
    }

    toggle() {
        if (this._modal.isOpen) {
            this._modal.close();
            return;
        }
        this._prevFocus = global.display.focus_window;
        // Read before the popover's own search field takes the input method
        this._anchor = this._caret.rect;
        this._load();
        this._modal.open();
    }

    async _load() {
        if (this._status !== 'idle')
            return;
        this._status = 'loading';
        try {
            const data = await loadEmojiData(this._cleanup, this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            this._catalog = data ? buildCatalog(data.records) : null;
            this._status = this._catalog?.items.length ? 'ready' : 'missing';
        } catch (e) {
            console.warn(`${LOG} emoji data failed: ${e.message}`);
            this._status = 'missing';
        }
        if (this._modal.isOpen)
            this._view.refresh();
    }

    /** Type `char` into the window that had focus, then remember it. */
    insert(char) {
        const prev = this._prevFocus;
        this._ks.setStrv('emoji-recents', pushRecent(this._ks.strv('emoji-recents'), char));
        this._modal.close();
        this._cleanup.timeout(FOCUS_SETTLE_MS, () => {
            this._type(prev, char);
            return GLib.SOURCE_REMOVE;
        }, { name: 'emoji-insert' });
    }

    async _type(prev, char, { forcePaste = false } = {}) {
        if (!prev || global.display.focus_window !== prev)
            return;
        if (!forcePaste && commitText(char)) {
            this._lastInsert = { char, method: 'input-method' };
            return;
        }
        const saved = await saveClipboard(this._cancellable);
        if (this._cancellable.is_cancelled())
            return;
        setClipboardText(char);
        if (!sendPasteChord(prev)) {
            restoreClipboard(saved);
            return;
        }
        this._lastInsert = { char, method: 'paste' };
        this._cleanup.timeout(CLIPBOARD_RESTORE_MS, () => {
            restoreClipboard(saved);
            return GLib.SOURCE_REMOVE;
        }, { name: 'emoji-clipboard-restore' });
    }
}
