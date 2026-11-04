// SPDX-License-Identifier: GPL-3.0-or-later
// The menu bar in full screen (VS auto-hide
// options): macOS hides it over a full-screen window and slides it in when the pointer
// touches the top edge; "Always show the menu bar in full screen" keeps it.
//
//   hidden (default)  the Shell hides the bar (panelBox tracks full screen). A 1 px edge at
//                     the top of the primary monitor, shown only then, reveals it on hover;
//                     it slides away when the pointer leaves the bar and no menu is open.
//   always            the panelBox stops tracking full screen while this runs.
//
// While revealed the bar wears the guava-menubar-revealed class: a darker, accent-tinted glass
// (style.css) so the items stay readable over any content. It fades with the slide.
//
// The edge reveals on a push: the pointer has to cross into it. An edge that appears under a
// pointer already at the top (the window just went full screen) stays unarmed until the
// pointer has left it once, so a maximize then full screen never leaves the bar shown.
//
// The notch stays hidden while the bar is revealed over a full-screen window (features/notch);
// only transient notch content (a notification, a live activity) shows there.
//
// Exit control (macOS slides the title bar with its traffic lights in over a full-screen window):
// while the bar is revealed, a green round button leads the bar. A click leaves full screen for
// the window it belongs to (model.fullscreenExitTarget), the same call as the green button of the
// app's titlebar (features/appButtons/greenButton.js); the bar then follows the pointer as usual.
//
// Private Shell API: Main.layoutManager._trackedActors (the panelBox's trackFullscreen flag,
// for "always"), _updateVisibility() to give the Shell its rule back. Same in 48-51.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as A11y from '../../lib/a11y.js';
import { PanelLayout } from '../../core/panelLayout.js';
import { fullscreenExitTarget } from './model.js';

const REVEALED = 'guava-menubar-revealed';
// While revealed the pointer is checked this often; the bar goes once it has been below the bar
// for LEAVE_CHECKS checks in a row (~0.4 s), so crossing the bar or its edge never flickers it
const WATCH_MS = 100;
const LEAVE_CHECKS = 4;
const BELOW_MARGIN = 6;       // px under the bar that still count as on it
const EXIT_ROLE = 'guava-menubar-fullscreen-exit';

export class FullscreenReveal {
    /**
     * @param {object} ctx the feature ctx (motion)
     * @param {CleanupRegistry} cleanup
     * @param {{always: boolean}} opts
     */
    constructor(ctx, cleanup, { always }) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._always = always;
        this._revealed = false;
        this._edge = null;
        this._armed = false;     // the pointer was off the edge since it appeared
        this._anim = null;
        this._menuWatch = 0;     // token of the one handler waiting for the open menu to close
        this._concealCheck = 0;  // token of the pending conceal check
        this._exit = null;       // the green exit-full-screen button
        this._watch = 0;         // token of the pointer watch while revealed
        this._away = 0;          // consecutive checks with the pointer below the bar
    }

    /** True while the bar is slid in over a full-screen window (tests, the harness). */
    get revealed() {
        return this._revealed;
    }

    get edge() {
        return this._edge;
    }

    start() {
        if (this._always)
            this._keepShown();
        else
            this._startEdge();
    }

    // ---- always shown -----------------------------------------------------------------------

    _keepShown() {
        const lm = Main.layoutManager;
        const data = lm._trackedActors?.find(a => a.actor === lm.panelBox);
        if (!data)
            return;
        data.trackFullscreen = false;
        lm.panelBox.show();
        this._cleanup.add(() => {
            data.trackFullscreen = true;
            lm._updateVisibility?.();
        });
    }

    // ---- reveal on the top edge -------------------------------------------------------------

    _startEdge() {
        const lm = Main.layoutManager;
        const cleanup = this._cleanup;
        const edge = new St.Widget({ name: 'guava-menubar-reveal-edge', reactive: true, visible: false, height: 1 });
        this._edge = edge;
        lm.addTopChrome(edge);
        cleanup.surface(edge);
        cleanup.add(() => {
            this._conceal(false);
            lm.removeChrome(edge);
            edge.destroy();
            this._edge = null;
        });
        cleanup.connect(edge, 'enter-event', () => {
            if (this._armed)
                this.reveal();
            return Clutter.EVENT_PROPAGATE;
        });
        cleanup.connect(edge, 'leave-event', () => {
            this._armed = true;
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildExitButton();

        // The panel (reactive, unlike its box) says when the pointer leaves the bar
        const panel = Main.panel;
        const hover = panel.track_hover;
        panel.track_hover = true;
        cleanup.add(() => (panel.track_hover = hover));
        // (the pointer watch started by reveal() decides when the pointer has left the bar)
        // Keyboard: over a full-screen window the edge is the only mapped piece, so it stands
        // for the bar in Ctrl+Alt+Tab; choosing it slides the bar in and focuses it. The bar
        // stays while the focus is in it and goes when the focus leaves.
        A11y.focusGroup(cleanup, edge, this._ctx.gettext('Top Bar'), 'view-app-grid-symbolic', {
            focus: () => this.reveal(() => Main.panel.navigate_focus(null, St.DirectionType.TAB_FORWARD, false)),
        });
        cleanup.connect(global.stage, 'notify::key-focus', () => this._maybeConceal());

        const sync = () => this._sync();
        cleanup.connect(global.display, 'in-fullscreen-changed', sync);
        cleanup.connect(lm, 'monitors-changed', sync);
        cleanup.connect(Main.overview, 'showing', sync);
        cleanup.connect(Main.overview, 'hidden', sync);
        this._sync();
    }

    _buildExitButton() {
        const button = new St.Button({
            style_class: 'guava-menubar-fullscreen-exit', can_focus: true, reactive: true, track_hover: true,
            visible: false, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: this._ctx.gettext('Exit Full Screen'),
        });
        button.set_child(new St.Icon({ icon_name: 'view-restore-symbolic', style_class: 'guava-menubar-fullscreen-exit-icon' }));
        this._exit = button;
        PanelLayout.claim(this._cleanup, {
            id: EXIT_ROLE, actor: button, box: 'left', anchor: { before: ['guava-menubar-logo'], fallback: 'first' },
        });
        this._cleanup.connect(button, 'clicked', () => {
            const win = this._exitWindow();
            win?.unmake_fullscreen();
            this._maybeConceal();
        });
        this._cleanup.add(() => {
            this._exit = null;
            button.destroy();
        });
    }

    /** The window the exit control leaves full screen (Meta.Window) or null. */
    _exitWindow() {
        const monitor = Main.layoutManager.primaryIndex;
        const focus = global.display.focus_window;
        const wins = global.get_window_actors().map(a => a.meta_window).filter(Boolean);
        return fullscreenExitTarget(wins.map(w => ({
            id: w, fullscreen: w.is_fullscreen(), minimized: w.minimized, monitor: w.get_monitor(), focused: w === focus,
        })), monitor);
    }

    _inFullscreen() {
        return !!Main.layoutManager.primaryMonitor?.inFullscreen && !Main.overview.visible;
    }

    _sync() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._edge || !monitor)
            return;
        this._edge.set_position(monitor.x, monitor.y);
        this._edge.width = monitor.width;
        const full = this._inFullscreen();
        if (!full && this._revealed)
            this._conceal(false);
        if (full && !this._edge.visible && !this._revealed)
            this._armed = global.get_pointer()[1] > monitor.y;
        this._edge.visible = full && !this._revealed;
    }

    /**
     * Slide the bar in over the full-screen window.
     *
     * @param {() => void} [onShown] runs once the bar is in place, at once when it needs no
     *   sliding (not in full screen, or already out); not when the slide is interrupted
     */
    reveal(onShown) {
        if (!this._edge || !this._inFullscreen() || this._revealed) {
            onShown?.();
            return;
        }
        const panelBox = Main.layoutManager.panelBox;
        this._revealed = true;
        this._edge.visible = false;
        this._startWatch();
        if (this._exit)
            this._exit.visible = !!this._exitWindow();
        this._anim?.cancel();
        Main.panel.add_style_class_name(REVEALED);
        panelBox.show();
        panelBox.translation_y = -this._barHeight();
        panelBox.opacity = 0;
        this._anim = this._ctx.motion.ease(panelBox, { translation_y: 0, opacity: 255 },
            { duration: 'short', curve: 'enter', onDone: finished => finished && onShown?.() }, this._cleanup);
    }

    // The panel box has no height yet while it is hidden: the panel's own preferred one then
    _barHeight() {
        return Main.layoutManager.panelBox.height || Main.panel.get_preferred_height(-1)[1];
    }

    /** Slide the bar away again once no menu is open and the pointer is off it. */
    concealWhenIdle() {
        this._maybeConceal();
    }

    // Deferred to idle: while a menu opens, the key focus moves into it before the menu manager
    // knows it is the active menu, and concealing then would hide the bar under the opening menu
    _maybeConceal() {
        if (this._concealCheck || !this._revealed)
            return;
        this._concealCheck = this._cleanup.idle(() => {
            this._concealCheck = 0;
            this._concealIfIdle();
        }, { name: 'menu bar conceal check' });
    }

    _concealIfIdle() {
        // The pointer's place, not the panel's hover: the notch and the exit button are separate
        // actors on top of the bar, and moving onto them is not leaving the bar
        if (!this._revealed || this._pointerOnBar() || A11y.focusWithin(Main.panel))
            return;
        const menu = Main.panel.menuManager.activeMenu;
        if (menu) {
            // Wait for the menu to close, then check the pointer again (one handler at a time)
            if (this._menuWatch)
                return;
            this._menuWatch = this._cleanup.connect(menu, 'open-state-changed', (_m, open) => {
                if (open)
                    return;
                this._unwatchMenu();
                this._maybeConceal();
            });
            return;
        }
        this._conceal(true);
    }

    // The pointer is on the bar: within the primary monitor, above the bar's bottom (plus a margin)
    _pointerOnBar() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const [x, y] = global.get_pointer();
        return x >= monitor.x && x < monitor.x + monitor.width &&
            y >= monitor.y - 1 && y < monitor.y + this._barHeight() + BELOW_MARGIN;
    }

    // While revealed: conceal once the pointer has stayed off the bar for a moment
    _startWatch() {
        if (this._watch)
            return;
        this._away = 0;
        this._watch = this._cleanup.timeout(WATCH_MS, () => {
            if (!this._revealed) {
                this._watch = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._away = this._pointerOnBar() ? 0 : this._away + 1;
            if (this._away >= LEAVE_CHECKS)
                this._maybeConceal();
            return GLib.SOURCE_CONTINUE;
        }, { name: 'menu bar reveal watch' });
    }

    _stopWatch() {
        if (this._watch)
            this._cleanup.release(this._watch);
        this._watch = 0;
    }

    _unwatchMenu() {
        this._cleanup.release(this._menuWatch);
        this._menuWatch = 0;
    }

    _conceal(animate) {
        if (!this._revealed)
            return;
        this._revealed = false;
        this._stopWatch();
        // Concealed with the pointer still at the top: the edge waits for it to leave once,
        // or it would reveal again at once (the bar flickering in and out)
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor && global.get_pointer()[1] <= monitor.y)
            this._armed = false;
        const panelBox = Main.layoutManager.panelBox;
        this._anim?.cancel();
        const done = () => {
            // Revealed again before the slide-out finished: the reveal owns the bar now
            if (this._revealed)
                return;
            panelBox.translation_y = 0;
            panelBox.opacity = 255;
            Main.panel.remove_style_class_name(REVEALED);
            if (this._exit)
                this._exit.visible = false;
            // The Shell's rule again: hidden while the monitor is in full screen
            if (this._inFullscreen())
                panelBox.hide();
            if (this._edge)
                this._edge.visible = this._inFullscreen();
        };
        if (!animate) {
            done();
            return;
        }
        this._anim = this._ctx.motion.ease(panelBox, { translation_y: -this._barHeight(), opacity: 0 },
            { duration: 'short', curve: 'exit', onDone: done }, this._cleanup);
    }
}
