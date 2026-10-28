// SPDX-License-Identifier: GPL-3.0-or-later
// Full screen Split View (macOS, on by default). Builds on full screen as
// its own Space (features/fullscreenSpace): a full-screen window is alone in its Space.
//
//   1. A shortcut on a full-screen window tiles it to the left or right of the screen
//      (split-view-left-shortcut, split-view-right-shortcut; macOS offers this on the green
//      button, which GTK apps' own buttons cannot show on GNOME).
//   2. The window leaves full screen but stays in its Space (WindowState 'splitView', which
//      fullscreenSpace honours) and takes that half of the work area.
//   3. The other half shows thumbnails (live clones) of the other windows; a click moves that
//      window into the Space, on the other half. Esc or a click on the tiled half cancels: the
//      window goes back to full screen.
//   4. The pair ends when one window closes, is minimized, goes full screen or maximizes: that
//      window goes back to the workspace the partner came from, and the other one is full
//      screen again, alone in the Space.
//
// Disable (Guava disables on every screen lock) only clears the flags and the picker: windows
// keep their place and size, so nothing jumps.
//
// Shell API: Meta.Window make_fullscreen / unmake_fullscreen / move_resize_frame /
// change_workspace, Clutter.Clone of window actors (as the overview does), Main.pushModal; checked on GNOME 50.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as A11y from '../../lib/a11y.js';
import { WindowState, skipsTaskbar } from '../../core/windowState.js';
import { isMaximized, unmaximizeWindow } from '../../lib/compat.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { Keybindings } from '../../lib/keybindings.js';
import { isCandidate, preSplitRect, splitRects, survivorAfter, thumbnailRects } from './model.js';

const FLAG = 'splitView';

const isNormal = w => w.get_window_type() === Meta.WindowType.NORMAL;

export class SplitView {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ = s => ctx.gettext(s);
        this._pairs = [];          // {a, b, ws, home, before, reg}
        this._picker = null;       // {win, side, ws, reg, overlay, grab}
        this._settling = null;     // CleanupRegistry while a window waits to leave full screen
    }

    enable() {
        const cleanup = this._cleanup;
        for (const side of ['left', 'right']) {
            Keybindings.add(cleanup, `split-view-${side}-shortcut`, this._ctx.settings,
                () => this.tile(global.display.focus_window, side));
        }
        cleanup.add(() => {
            this._settling?.dispose();
            this._settling = null;
            this._cancelPicker({ refullscreen: false });
            for (const pair of [...this._pairs])
                this._forget(pair);
            WindowState.clearFlag(FLAG);
        });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    /** The pair a window is in, or null. */
    pairOf(win) {
        return this._pairs.find(p => p.a === win || p.b === win) ?? null;
    }

    _candidates(except) {
        return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null).filter(w => isCandidate({
            type: isNormal(w) ? 'normal' : 'other',
            skipTaskbar: skipsTaskbar(w),
            fullscreen: w.is_fullscreen(),
            inSplit: !!this.pairOf(w),
            isTiled: w === except,
        }) && w.get_monitor() === except.get_monitor());
    }

    // ---- tile and pick -----------------------------------------------------------------------

    /** Tile a full-screen window to one half and show the picker on the other. */
    tile(win, side) {
        if (!win?.is_fullscreen() || this.pairOf(win) || this._picker || this._settling)
            return false;
        const candidates = this._candidates(win);
        if (!candidates.length)
            return false;
        const area = win.get_work_area_current_monitor();
        const rects = splitRects(area, side);
        const ws = win.get_workspace();
        WindowState.set(win, FLAG, true);
        win.unmake_fullscreen();
        // The window's own size comes back with its first resize: that is the size it returns
        // to when it leaves the pair. The half is only asked for after that.
        const settle = new CleanupRegistry();
        this._settling = settle;
        const place = () => {
            settle.dispose();
            this._settling = null;
            const before = preSplitRect(win.get_frame_rect(), area);
            win.move_resize_frame(true, rects.tiled.x, rects.tiled.y, rects.tiled.width, rects.tiled.height);
            this._showPicker(win, side, ws, rects.other, candidates, before);
        };
        settle.connect(win, 'size-changed', place);
        settle.connect(win, 'unmanaged', () => {
            settle.dispose();
            this._settling = null;
        });
        return true;
    }

    _showPicker(win, side, ws, half, candidates, before) {
        const _ = this._;
        const reg = new CleanupRegistry();
        const overlay = reg.actor(new St.Widget({
            name: 'guava-split-picker', style_class: 'guava-split-picker', reactive: true, can_focus: true,
            accessible_name: _('Choose a Window'), accessible_role: A11y.Role.DIALOG,
            layout_manager: new Clutter.FixedLayout(),
            x: half.x, y: half.y, width: half.width, height: half.height,
        }));
        const local = { x: 0, y: 0, width: half.width, height: half.height };
        const rects = thumbnailRects(candidates.map(w => w.get_frame_rect()), local);
        candidates.forEach((w, i) => {
            const r = rects[i];
            const actor = w.get_compositor_private();
            const button = new St.Button({
                style_class: 'guava-split-thumb', reactive: true, can_focus: true, track_hover: true,
                accessible_name: w.get_title() ?? _('Window'),
                x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12,
            });
            const box = new St.Widget({ layout_manager: new Clutter.FixedLayout() });
            if (actor)
                box.add_child(new Clutter.Clone({ source: actor, x: 6, y: 6, width: r.width, height: r.height }));
            button.set_child(box);
            button.connect('clicked', () => this._pick(w));
            overlay.add_child(button);
            const label = new St.Label({
                style_class: 'guava-split-thumb-label', text: w.get_title() ?? '',
                x: r.x, y: r.y + r.height + 10, width: r.width,
            });
            label.clutter_text.ellipsize = 3;  // Pango.EllipsizeMode.END
            overlay.add_child(label);
        });
        Main.layoutManager.uiGroup.add_child(overlay);
        global.focus_manager.add_group(overlay);
        const grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.POPUP });
        reg.add(() => Main.popModal(grab));
        reg.connect(overlay, 'key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._cancelPicker({ refullscreen: true });
            return Clutter.EVENT_STOP;
        });
        // A click outside the picker (the tiled half) cancels, as on macOS
        reg.connect(global.stage, 'captured-event', (_s, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            if (x >= half.x && x < half.x + half.width && y >= half.y && y < half.y + half.height)
                return Clutter.EVENT_PROPAGATE;
            this._cancelPicker({ refullscreen: true });
            return Clutter.EVENT_STOP;
        });
        reg.connect(win, 'unmanaged', () => this._cancelPicker({ refullscreen: false }));
        overlay.grab_key_focus();
        overlay.opacity = 0;
        this._ctx.motion.ease(overlay, { opacity: 255 }, { duration: 'short', curve: 'standard' }, reg);
        this._picker = { win, side, ws, half, reg, before };
    }

    _cancelPicker({ refullscreen }) {
        const picker = this._picker;
        if (!picker)
            return;
        this._picker = null;
        picker.reg.dispose();
        if (!refullscreen)
            return;
        WindowState.set(picker.win, FLAG, false);
        picker.win.make_fullscreen();
    }

    _pick(other) {
        const picker = this._picker;
        if (!picker)
            return;
        const { win, ws, half, before } = picker;
        this._picker = null;
        picker.reg.dispose();
        const home = other.get_workspace();
        const otherBefore = isMaximized(other) ? null : preSplitRect(other.get_frame_rect(), other.get_work_area_current_monitor());
        WindowState.set(other, FLAG, true);
        if (other.minimized)
            other.unminimize();
        if (isMaximized(other))
            unmaximizeWindow(other);
        if (home !== ws)
            other.change_workspace(ws);
        other.move_resize_frame(true, half.x, half.y, half.width, half.height);
        other.activate(global.get_current_time());
        this._watch({ a: win, b: other, ws, home, before: new Map([[win, before], [other, otherBefore]]) });
    }

    _watch(pair) {
        const reg = new CleanupRegistry();
        pair.reg = reg;
        this._pairs.push(pair);
        for (const w of [pair.a, pair.b]) {
            reg.connect(w, 'unmanaged', () => this._end(pair, w, { closed: true }));
            reg.connect(w, 'notify::minimized', () => w.minimized && this._end(pair, w));
            reg.connect(w, 'notify::fullscreen', () => w.is_fullscreen() && this._end(pair, w, { fullscreen: true }));
            reg.connect(w, 'notify::maximized-horizontally', () => isMaximized(w) && this._end(pair, w));
            reg.connect(w, 'workspace-changed', () => w.get_workspace() !== pair.ws && this._end(pair, w));
        }
        this._ctx.events.emit('split-view-changed', { windows: [pair.a, pair.b], active: true });
    }

    /** Stop tracking a pair (flags off), without moving anything. */
    _forget(pair) {
        this._pairs = this._pairs.filter(p => p !== pair);
        pair.reg.dispose();
        WindowState.set(pair.a, FLAG, false);
        WindowState.set(pair.b, FLAG, false);
        this._ctx.events.emit('split-view-changed', { windows: [pair.a, pair.b], active: false });
    }

    /**
     * One window leaves the pair: it goes back to where the partner came from (unless it was
     * closed or made full screen itself), and the other one is full screen again in the Space.
     */
    _end(pair, gone, { closed = false, fullscreen = false } = {}) {
        if (!this._pairs.includes(pair))
            return;
        this._forget(pair);
        const survivor = survivorAfter(pair, gone);
        const home = pair.home && pair.home !== pair.ws ? pair.home : null;
        if (fullscreen) {
            // It took the Space for itself: the partner goes back to where it came from
            if (home && survivor?.get_compositor_private())
                survivor.change_workspace(home);
            return;
        }
        if (!closed && home && gone.get_workspace() === pair.ws)
            gone.change_workspace(home);
        // It leaves at the size it had before the split, not as a half
        const before = pair.before.get(gone);
        if (!closed && before && !isMaximized(gone))
            gone.move_resize_frame(true, before.x, before.y, before.width, before.height);
        if (survivor?.get_compositor_private())
            survivor.make_fullscreen();
    }
}
