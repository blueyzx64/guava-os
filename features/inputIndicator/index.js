// SPDX-License-Identifier: GPL-3.0-or-later
// Text-cursor indicators (macOS Sonoma): a small glass badge at the text caret when Caps Lock
// toggles or the input source changes. It fades out after BADGE_MS.
//
// Shell API (checked on 50; the same in 48-51):
// - the caret: lib/caret.js (the IBus panel service's set-cursor-location);
// - Caps Lock: the seat keymap's 'state-changed' and get_caps_lock_state() (as
//   ui/shellEntry.js CapsLockWarning does);
// - input sources: ui/status/keyboard.js getInputSourceManager() 'current-source-changed'.
// Without a caret (no IBus, or an app that never reports one) the badge goes by the pointer.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getInputSourceManager } from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import * as A11y from '../../lib/a11y.js';
import { Caret } from '../../lib/caret.js';
import { Glass } from '../../lib/glass.js';
import { GuavaSettings } from '../../lib/settings.js';
import {
    BADGE_MS, CapsWatch, badgeFor, contains, isSourceSwitch, placeBadge, readConfig,
} from './model.js';

const STYLES = ['caps-on', 'caps-off', 'source'];
const CAPS_ICON = 'icons/guava-caps-lock-symbolic.svg';

export class InputIndicator {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._badge = null;
        this._hideToken = 0;
        this._shown = null;     // badgeFor() result on screen
    }

    enable() {
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(cleanup);
        this._config = readConfig(ks);
        ks.watch(['input-indicator', 'input-indicator-caps-lock', 'input-indicator-source'], () => {
            this._config = readConfig(ks);
        });

        this._caret = Caret.acquire(cleanup);

        const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
        const keymap = backend.get_default_seat().get_keymap();
        this._caps = new CapsWatch(keymap.get_caps_lock_state());
        cleanup.connect(keymap, 'state-changed', () => {
            const on = this._caps.update(keymap.get_caps_lock_state());
            if (on !== null)
                this._show({ type: 'caps', on });
        });

        const sources = getInputSourceManager();
        cleanup.connect(sources, 'current-source-changed', (manager, old) => {
            const now = manager.currentSource;
            if (isSourceSwitch(old?.id, now?.id))
                this._show({ type: 'source', source: now });
        });
    }

    disable() {
        // Everything is in the cleanup registry
        this._badge = null;
        this._shown = null;
    }

    /** The badge on screen, or null (for tests and the harness). */
    get badge() {
        return this._shown && this._badge?.visible ? { ...this._shown, actor: this._badge } : null;
    }

    _ensureBadge() {
        if (this._badge)
            return this._badge;
        const badge = this._cleanup.actor(new St.BoxLayout({
            style_class: 'guava-input-badge', visible: false, opacity: 0, reactive: false,
        }));
        // ⇪ is missing from many UI fonts: Guava's own symbolic icon draws it
        this._capsIcon = new St.Icon({
            gicon: Gio.FileIcon.new(this._ctx.extension.dir.resolve_relative_path(CAPS_ICON)),
            style_class: 'guava-input-badge-icon', y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({ style_class: 'guava-input-badge-label', y_align: Clutter.ActorAlign.CENTER });
        badge.add_child(this._capsIcon);
        badge.add_child(this._label);
        // Above the windows and the panel, outside the input region: not chrome
        Main.layoutManager.uiGroup.add_child(badge);
        // Guava glass (a fill on the label itself); solid when glass is off
        const glass = Glass.attach(badge, {
            surface: 'overlays', role: 'content', radius: 7,
            isDark: () => St.Settings.get().color_scheme !== St.SystemColorScheme.PREFER_LIGHT,
        });
        this._cleanup.add(() => glass.destroy());
        badge.set_pivot_point(0, 0);
        this._badge = badge;
        return badge;
    }

    _show(event) {
        const content = badgeFor(event, this._config);
        if (!content)
            return;
        const badge = this._ensureBadge();
        for (const s of STYLES)
            badge.remove_style_class_name(`guava-input-badge-${s}`);
        badge.add_style_class_name(`guava-input-badge-${content.style}`);
        const caps = content.style !== 'source';
        this._capsIcon.visible = caps;
        this._label.visible = !caps;
        this._label.text = caps ? '' : content.text;
        A11y.name(badge, content.style === 'source' ? content.text
            : content.style === 'caps-on' ? this._ctx.gettext('Caps Lock on') : this._ctx.gettext('Caps Lock off'), A11y.Role.ALERT);

        const [px, py] = global.get_pointer();
        const caret = this._caret.rect;
        const monitors = Main.layoutManager.monitors;
        const at = caret ?? { x: px, y: py };
        const area = monitors.find(m => contains(m, at.x, at.y)) ?? Main.layoutManager.primaryMonitor;
        const [, natW] = badge.get_preferred_width(-1);
        const [, natH] = badge.get_preferred_height(natW);
        const pos = placeBadge({
            caret, pointer: { x: px, y: py }, size: { width: natW, height: natH },
            area: { x: area.x, y: area.y, width: area.width, height: area.height },
        });
        badge.set_position(pos.x, pos.y);
        this._shown = { ...content, anchor: pos.anchor, x: pos.x, y: pos.y };

        const motion = this._ctx.motion;
        const wasVisible = badge.visible && badge.opacity > 0;
        badge.visible = true;
        badge.get_parent()?.set_child_above_sibling(badge, null);
        if (!wasVisible) {
            badge.set_scale(0.86, 0.86);
            motion.ease(badge, { scale_x: 1, scale_y: 1 }, { duration: 'short', curve: 'emphasized' }, this._cleanup);
        }
        motion.ease(badge, { opacity: 255 }, { duration: 'micro', curve: 'standard' }, this._cleanup);

        if (this._hideToken)
            this._cleanup.release(this._hideToken);
        this._hideToken = this._cleanup.timeout(BADGE_MS, () => {
            this._hideToken = 0;
            this._hide();
        }, { name: 'input-badge-hide' });
    }

    _hide() {
        const badge = this._badge;
        if (!badge)
            return;
        this._ctx.motion.ease(badge, { opacity: 0 }, {
            duration: 'short', curve: 'exit',
            onDone: finished => {
                if (finished) {
                    badge.visible = false;
                    this._shown = null;
                }
            },
        }, this._cleanup);
    }
}
