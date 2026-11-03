// SPDX-License-Identifier: GPL-3.0-or-later
// Pointer, like macOS Accessibility > Display > Pointer and AppKit:
//
//   Shake to locate     a quick side-to-side shake makes the pointer big for a moment
//   Hide while typing   the pointer hides while you type, and comes back when the mouse moves
//   Size                org.gnome.desktop.interface cursor-size, owned through core/originals
//   Colours             a recoloured copy of the user's cursor theme (theme.js), selected by
//                       owning cursor-theme the same way
//
// Shell API (checked on 50; the same in 48-51):
// - global.backend.get_cursor_tracker(): 'position-invalidated' fires on every pointer motion,
//   over client windows too (ui/magnifier.js follows the pointer with it); get_sprite/get_hot
//   for the big pointer; inhibit/uninhibit_cursor_visibility (balanced: one inhibit at most,
//   given back in cleanup).
// - St.ImageContent from the theme's Xcursor file at the big size (theme.js loadCursorImage): the
//   big pointer is a real large cursor, not the small sprite scaled up (that is blurry). The
//   sprite is the fallback until the image has loaded.
// - lib/caret.js onMoved (the IBus panel service's caret) for typing.
// - global.display.is_grabbed(), Main.overview.visible, Main.modalCount, the held buttons: the
//   pointer is "blocked" then (model.js isBlocked): no shake, no hiding. Dragging a window must
//   never make the pointer big.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Caret } from '../../lib/caret.js';
import { enqueueUserFileJob } from '../../lib/fileOps.js';
import { GuavaSettings } from '../../lib/settings.js';
import { SettingOwner } from '../../core/originals.js';
import { SHAKE_SCALE, ShakeDetector, TypingHider, isBlocked, readConfig, themeName } from './model.js';
import { ensureTheme, iconsDir, loadCursorImage, removeOthers } from './theme.js';

const KEYS = ['pointer-shake-to-locate', 'pointer-hide-while-typing', 'pointer-size',
    'pointer-custom-colors', 'pointer-fill-color', 'pointer-outline-color'];
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

// The cursor sprite drawn as actor content (as ui/magnifier.js MouseSpriteContent does)
const SpriteContent = GObject.registerClass({
    Implements: [Clutter.Content],
}, class GuavaPointerSpriteContent extends GObject.Object {
    _init() {
        super._init();
        this._texture = null;
        this._w = 0;
        this._h = 0;
    }

    setTexture(texture, width, height) {
        this._texture = texture;
        this._w = width;
        this._h = height;
        this.invalidate();
    }

    vfunc_get_preferred_size() {
        return this._texture ? [true, this._w, this._h] : [false, 0, 0];
    }

    vfunc_paint_content(actor, node) {
        if (!this._texture)
            return;
        const [minFilter, magFilter] = actor.get_content_scaling_filters();
        const textureNode = new Clutter.TextureNode(this._texture, null, minFilter, magFilter);
        node.add_child(textureNode);
        textureNode.add_rectangle(actor.get_content_box());
    }
});

export class Pointer {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._tracker = null;
        this._inhibits = new Set();     // reasons the real pointer is hidden: 'typing', 'shake'
        this._big = null;               // the big pointer actor while it shows
        this._shaking = false;
    }

    enable() {
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(cleanup);
        this._ks = ks;
        this._config = readConfig(ks);

        const tracker = global.backend.get_cursor_tracker();
        this._tracker = tracker;
        // Never leave the pointer hidden: registered before anything can hide it, so it runs
        // last, and it keeps its own reference to the tracker
        cleanup.add(() => {
            this._hideBig(true);
            if (this._inhibits.size)
                tracker.uninhibit_cursor_visibility();
            this._inhibits.clear();
        });

        this._shake = new ShakeDetector();
        this._typing = new TypingHider();
        cleanup.connect(this._tracker, 'position-invalidated', () => this._onMotion());

        this._caret = Caret.acquire(cleanup);
        this._caret.onMoved(cleanup, () => this._onCaretMoved());
        cleanup.connect(global.display, 'notify::focus-window', () => {
            if (this._typing.reset())
                this._show('typing');
        });

        const iface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._sizeOwner = new SettingOwner(this._ctx.originals, iface, 'cursor-size', {
            type: 'i', transform: () => this._config.size,
        });
        this._themeOwner = new SettingOwner(this._ctx.originals, iface, 'cursor-theme', {
            type: 's', transform: () => this._themeName,
        });
        this._iface = iface;
        // The big cursor follows the user's theme and size, whoever changes them
        cleanup.connect(iface, 'changed::cursor-theme', () => this._preloadBig());
        cleanup.connect(iface, 'changed::cursor-size', () => this._preloadBig());
        cleanup.connect(Main.layoutManager, 'monitors-changed', () => this._preloadBig());
        cleanup.add(() => {
            this._sizeOwner.release();
            this._themeOwner.release();
        });
        this._cancel = new Gio.Cancellable();
        cleanup.add(() => this._cancel.cancel());

        ks.watch(KEYS, () => {
            this._config = readConfig(ks);
            this._apply();
        });
        this._apply();
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** For tests and the harness. */
    get state() {
        return {
            hiddenForTyping: this._inhibits.has('typing'),
            big: !!this._big?.visible,
            scale: this._big?.scale_x ?? 1,
            theme: this._themeName ?? null,
        };
    }

    _apply() {
        const c = this._config;
        if (!c.shake && this._shaking)
            this._hideBig(true);
        if (!c.hideWhileTyping && this._typing.reset())
            this._show('typing');
        this._sizeOwner.sync(c.size > 0);
        this._sizeOwner.reapply();
        this._applyColors();
        this._preloadBig();
    }

    _applyColors() {
        const c = this._config;
        if (!c.colors) {
            this._themeName = null;
            if (this._themeOwner.owning) {
                this._themeOwner.sync(false);
                // Turned off: Guava's generated themes go (only folders with Guava's marker)
                enqueueUserFileJob(() => removeOthers(iconsDir(), null));
            }
            return;
        }
        const name = themeName(c.fill, c.outline);
        if (name === this._themeName && this._themeOwner.owning)
            return;
        const base = this._themeOwner.original;
        const cancellable = this._cancel;
        enqueueUserFileJob(async () => {
            const made = await ensureTheme(base, c.fill, c.outline, cancellable);
            if (cancellable.is_cancelled() || !this._config.colors || themeName(this._config.fill, this._config.outline) !== name)
                return;
            if (!made) {
                console.warn(`[Guava] pointer colours: no cursor theme to recolour (${base})`);
                return;
            }
            this._themeName = made;
            this._themeOwner.sync(true);
            this._themeOwner.reapply();
            // Only now that the setting names the new theme do the older ones go; `this._themeName`
            // is read when the job runs, so a change queued meanwhile keeps its own theme
            enqueueUserFileJob(() => (this._themeName ? removeOthers(iconsDir(), this._themeName) : null));
        });
    }

    _hide(reason) {
        if (this._inhibits.has(reason))
            return;
        if (this._inhibits.size === 0)
            this._tracker.inhibit_cursor_visibility();
        this._inhibits.add(reason);
    }

    _show(reason) {
        if (!this._inhibits.delete(reason))
            return;
        if (this._inhibits.size === 0)
            this._tracker.uninhibit_cursor_visibility();
    }

    // `mods`: the pointer state a caller already read (a motion event reads it once, not twice)
    _blocked(mods = global.get_pointer()[2]) {
        return isBlocked({
            buttons: !!(mods & BUTTONS),
            grabbed: !!global.display.is_grabbed?.(),
            overview: Main.overview.visible,
            modalCount: Main.modalCount,
        });
    }

    _onCaretMoved() {
        if (!this._config.hideWhileTyping)
            return;
        if (this._typing.caretMoved({ blocked: this._blocked() }))
            this._hide('typing');
    }

    _onMotion() {
        if (this._typing.pointerMoved())
            this._show('typing');
        if (!this._config.shake && !this._shaking)
            return;
        const [x, y, mods] = global.get_pointer();
        const now = GLib.get_monotonic_time() / 1000;
        // Blocked (a drag, a grab, overview, modal): the detector forgets its history and says no,
        // and a big pointer already showing goes away
        const blocked = this._blocked(mods);
        const shaking = this._config.shake && this._shake.update(x, y, now, blocked);
        if (blocked && this._shaking) {
            this._hideBig(false);
            return;
        }
        if (this._big?.visible)
            this._big.set_position(x, y);
        if (shaking && !this._shaking)
            this._showBig(x, y);
        if (shaking)
            this._armShrink();
    }

    _ensureBig() {
        if (this._big)
            return this._big;
        const content = new SpriteContent();
        const big = this._cleanup.actor(new Clutter.Actor({ content, reactive: false, visible: false }));
        big.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        Main.layoutManager.uiGroup.add_child(big);
        big.connect('destroy', () => {
            this._big = null;
            this._spriteContent = null;
        });
        this._spriteContent = content;
        this._big = big;
        return big;
    }

    _showBig(x, y) {
        const hi = this._hi;
        if (!hi && !this._tracker.get_sprite())
            return;
        const big = this._ensureBig();
        if (hi) {
            // A real large cursor, laid out so its final size is cursor-size x SHAKE_SCALE logical
            // pixels; it starts at the normal pointer size (scale 1 / SHAKE_SCALE)
            const { image, width, height, xhot, yhot, ratio, scale } = hi;
            const w = width * ratio / scale;
            const h = height * ratio / scale;
            big.set_content(image);
            big.set_size(w, h);
            big.set_translation(-xhot * ratio / scale, -yhot * ratio / scale, 0);
            big.set_pivot_point(w ? xhot * ratio / scale / w : 0, h ? yhot * ratio / scale / h : 0);
        } else {
            // Fallback while the image loads: the tracker's sprite, scaled up
            const sprite = this._tracker.get_sprite();
            const avg = (sprite.get_width() + sprite.get_height()) / 2;
            const texScale = Math.max(1, Math.floor(avg / Meta.prefs_get_cursor_size() + 0.1));
            const w = sprite.get_width() / texScale;
            const h = sprite.get_height() / texScale;
            const [hotX, hotY] = this._tracker.get_hot();
            this._spriteContent.setTexture(sprite, w, h);
            big.set_content(this._spriteContent);
            big.set_size(w, h);
            big.set_translation(-hotX / texScale, -hotY / texScale, 0);
            big.set_pivot_point(w ? hotX / texScale / w : 0, h ? hotY / texScale / h : 0);
        }
        this._bigIsImage = !!hi;
        big.set_position(x, y);
        big.get_parent()?.set_child_above_sibling(big, null);
        this._shaking = true;
        this._hide('shake');
        if (!big.visible) {
            const from = hi ? 1 / SHAKE_SCALE : 1;
            big.set_scale(from, from);
            big.visible = true;
        }
        const target = hi ? 1 : SHAKE_SCALE;
        this._ctx.motion.ease(big, { scale_x: target, scale_y: target },
            { duration: 'short', curve: 'emphasized' }, this._cleanup);
    }

    // The theme's cursor at the big size, loaded ahead so the shake has it. Redone when the
    // theme or the sizes change.
    _preloadBig() {
        if (!this._config.shake)
            return;
        let scale = 1;
        for (let i = 0; i < global.display.get_n_monitors(); i++)
            scale = Math.max(scale, global.display.get_monitor_scale(i));
        const want = Math.ceil(Meta.prefs_get_cursor_size() * SHAKE_SCALE * scale);
        const theme = this._iface.get_string('cursor-theme');
        const key = `${theme}:${want}:${scale}`;
        if (this._hiKey === key)
            return;
        this._hiKey = key;
        this._hi = null;
        const cancellable = this._cancel;
        loadCursorImage(theme, 'default', want, cancellable).then(img => {
            if (cancellable.is_cancelled() || this._hiKey !== key || !img)
                return;
            // GNOME 50 has no Clutter.Image: St.ImageContent takes the bytes (as ui/screenshot.js does)
            const coglContext = global.stage.context.get_backend().get_cogl_context();
            const image = St.ImageContent.new_with_preferred_size(img.width, img.height);
            image.set_bytes(coglContext, new GLib.Bytes(img.pixels), Cogl.PixelFormat.BGRA_8888_PRE,
                img.width, img.height, img.width * 4);
            // ratio: the file's nominal size -> the wanted size, so the final size is exact
            this._hi = {
                image, width: img.width, height: img.height, xhot: img.xhot, yhot: img.yhot,
                ratio: want / Math.max(want, img.nominal), scale,
            };
        }).catch(e => console.warn(`[Guava] pointer: big cursor not loaded: ${e.message}`));
    }

    // Shrink once the shake stops (the detector's hold has passed)
    _armShrink() {
        if (this._shrinkToken)
            this._cleanup.release(this._shrinkToken);
        this._shrinkToken = this._cleanup.timeout(400, () => {
            this._shrinkToken = 0;
            this._hideBig(false);
        }, { name: 'pointer-shake-shrink' });
    }

    _hideBig(now) {
        if (this._shrinkToken) {
            this._cleanup.release(this._shrinkToken);
            this._shrinkToken = 0;
        }
        const big = this._big;
        this._shaking = false;
        if (!big?.visible) {
            this._show('shake');
            return;
        }
        if (now) {
            big.remove_all_transitions();
            big.visible = false;
            this._show('shake');
            return;
        }
        this._ctx.motion.ease(big, { scale_x: 1, scale_y: 1 }, {
            duration: 'medium', curve: 'standard',
            onDone: () => {
                if (this._shaking)
                    return;
                big.visible = false;
                this._show('shake');
            },
        }, this._cleanup);
    }
}
