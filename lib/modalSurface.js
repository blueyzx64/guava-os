// SPDX-License-Identifier: GPL-3.0-or-later
// ModalSurface: the one rounded modal panel used by Quick Paste and Spotlight.
//
//   const modal = new ModalSurface(cleanup, {
//       id: 'quick-paste', width: 760, height: 440, position: 'center',
//       build: (frame, modal) => { frame.add_child(...); return entry; },   // returns the key-focus actor
//       onKeyPress: (event, modal) => Clutter.EVENT_PROPAGATE,        // bubble phase, after the focus actor
//       onCapturedKey: (event, modal) => Clutter.EVENT_PROPAGATE,     // capture phase, before St.Entry sees it
//       onClosed: () => {},
//   });
//   modal.toggle();
//
// Only one Guava modal is open at a time: opening one closes the other one and every overlay
// registered with ModalSurface.registerForeign (the Downloads fan). Esc and a click outside
// the frame close it. The frame is Guava glass (lib/glass.js, surface 'overlays'); a bare
// "shell" widget with the same rect right behind it carries the drop shadow and the open/close
// scale. With glass off the frame keeps its own solid look (.guava-modal*, lib/modalLook.js).
// It opens with a 0.96 -> 1 scale plus fade (a fade only under reduced motion). Position
// 'right' is a full-height column under the top bar (the Notification Center) that slides in
// from the right edge instead of scaling; `dim: false` drops the dim behind it.
//
// Top-bar hover switching: while a 'right' column is open (the Notification Center), moving the
// pointer onto another top-bar menu's button closes the column and opens that menu, as the stock
// PopupMenuManager does between panel menus. The modal's own grab hides the buttons from the
// panel's menu manager, so the overlay does it from its captured events.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as A11y from './a11y.js';
import { MENU_CLOSE_ARGS, reducedMotion } from './compat.js';
import { Glass } from './glass.js';
import { frameClasses, motionFor } from './modalLook.js';
import { ModalArbiter, menuAtPoint, placeNear } from './modalModel.js';

const LOG = '[Guava]';
const MARGIN = 32;
const TOP_FRACTION = 0.16;     // default top offset, as a share of the monitor height
const COLUMN_GAP = 8;          // a 'right' column's gap to the top bar and the screen edges
const SLIDE_PX = 48;           // how far a 'right' column slides in

const arbiter = new ModalArbiter();

export class ModalSurface {
    /** Register another Guava overlay to be closed whenever a modal opens. Returns unregister. */
    static registerForeign(id, close) {
        return arbiter.registerForeign(id, close);
    }

    /** Close the open Guava modal and every registered overlay. */
    static closeAll() {
        arbiter.closeAll();
    }

    /** id of the open modal or null. */
    static get openId() {
        return arbiter.current;
    }

    /**
     * @param {object} cleanup CleanupRegistry; the modal closes on dispose
     * @param {object} opts
     * @param {string} opts.id unique name
     * @param {string} opts.accessibleName what a screen reader announces when the dialog opens
     * @param {Function} opts.build (frame, modal) -> Clutter.Actor|undefined; runs on every open
     * @param {number} [opts.width] logical px (clamped to the monitor)
     * @param {number} [opts.height]
     * @param {'center'|'top'|'at'|'right'} [opts.position] 'at': next to the rect opts.anchor()
     *   gives; 'right': a column under the top bar
     * @param {Function} [opts.anchor] () -> ?{x, y, width, height} in stage coordinates (a text
     *   caret), read on every open; null falls back to 'center'. Needs width and height.
     * @param {boolean} [opts.dim] dim the screen behind (default true)
     * @param {number} [opts.offsetTop] px from the monitor top for position 'top' (default 16 % of its height)
     * @param {number} [opts.radius] frame corner radius
     * @param {string} [opts.styleClass] extra class on the frame
     * @param {Function} [opts.onKeyPress] (event, modal) -> Clutter.EVENT_*, bubble phase
     * @param {Function} [opts.onCapturedKey] (event, modal) -> Clutter.EVENT_*, capture phase: use for
     *   Up/Down, which a focused St.Entry swallows before the bubble phase
     * @param {Function} [opts.onClosed]
     */
    constructor(cleanup, opts) {
        this._opts = { position: 'center', radius: 24, dim: true, ...opts };
        this._overlay = null;
        this._frame = null;
        this._shell = null;     // the frame's parent: shadow host and what scales
        this._glass = null;
        this._grab = null;
        this._closing = false;
        this._cleanup = cleanup;
        this._retryToken = 0;
        cleanup.add(() => this.close({ immediate: true }));
    }

    get id() {
        return this._opts.id;
    }

    get isOpen() {
        return !!this._overlay;
    }

    /** The content box of the open modal, null when closed. */
    get frame() {
        return this._frame;
    }

    toggle() {
        if (this.isOpen && !this._closing)
            this.close();
        else
            this.open();
    }

    /** @returns {boolean} false when it was already open or the Shell refused the grab */
    open(retry = false) {
        const { id, build, width, radius, styleClass, offsetTop, dim } = this._opts;
        let { height } = this._opts;
        if (this._overlay && !this._closing)
            return false;
        if (this._overlay)
            this.close({ immediate: true });
        if (!arbiter.request(id))
            return false;

        const anchor = this._opts.position === 'at' ? this._opts.anchor?.() ?? null : null;
        const position = anchor ? 'at' : this._opts.position === 'at' ? 'center' : this._opts.position;
        const monitor = anchor ? this._monitorAt(anchor) : Main.layoutManager.primaryMonitor;
        const overlay = new St.Widget({
            name: `guava-modal-${id}`,
            style_class: dim ? 'guava-modal-overlay' : '',
            reactive: true,
            can_focus: true,
            layout_manager: new Clutter.BinLayout(),
        });
        // Explicit stage-sized geometry, so the overlay is never laid out from nothing; the
        // constraint keeps it right when the stage resizes
        overlay.set_position(0, 0);
        overlay.set_size(global.stage.width, global.stage.height);
        overlay.add_constraint(new Clutter.BindConstraint({
            source: global.stage, coordinate: Clutter.BindCoordinate.ALL,
        }));
        A11y.dialog(overlay, this._opts.accessibleName ?? id);
        // Tab and the arrow keys move between the dialog's controls
        global.focus_manager.add_group(overlay);
        const st = St.Settings.get();
        // Same rule as lib/glass.js, so every Guava surface agrees on the scheme
        const dark = st.color_scheme !== St.SystemColorScheme.PREFER_LIGHT;
        const look = frameClasses({ dark, highContrast: !!st.high_contrast });
        // The shell places and scales the frame; the frame fills it
        const column = position === 'right';
        const columnTop = column ? (Main.panel.height ?? 0) + COLUMN_GAP : 0;
        if (column)
            height = monitor.height - columnTop - COLUMN_GAP;
        const shell = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: column ? Clutter.ActorAlign.END
                : position === 'at' ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            y_align: position === 'center' ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        const frame = new St.BoxLayout({
            style_class: [...look, styleClass ?? ''].join(' ').trim(),
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        if (width)
            shell.set_width(Math.min(width, monitor.width - 2 * MARGIN));
        if (height)
            shell.set_height(column ? height : Math.min(height, monitor.height - 2 * MARGIN));
        frame.set_style(`border-radius: ${radius}px;`);
        let pivotY = 0.5;
        if (position === 'top') {
            shell.set_style(`margin-top: ${Math.round(offsetTop ?? monitor.height * TOP_FRACTION)}px;`);
        } else if (column) {
            shell.set_style(`margin-top: ${columnTop}px; margin-right: ${COLUMN_GAP}px;`);
        } else if (position === 'at') {
            const size = { width: shell.width, height: shell.height };
            const at = placeNear(anchor, size, monitor);
            shell.set_style(`margin-left: ${at.x}px; margin-top: ${at.y}px;`);
            pivotY = at.above ? 1 : 0;     // grows out of the caret
        }
        shell.set_pivot_point(0.5, pivotY);
        shell.add_child(frame);
        // The overlay covers the whole stage (a click anywhere outside closes it); the frame is
        // laid out inside the primary monitor only, so it never straddles a monitor seam.
        const area = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
        area.add_child(shell);
        overlay.add_child(area);
        Main.layoutManager.addTopChrome(overlay);

        // A panel menu (Quick Settings, calendar) or the overview holds the grab: let go first
        const overviewWasVisible = Main.overview.visible;
        try {
            Main.panel.menuManager?.activeMenu?.close(MENU_CLOSE_ARGS);
            if (overviewWasVisible)
                Main.overview.hide();
        } catch (e) {
            console.warn(`${LOG} modal ${id}: could not close the open menu: ${e.message}`);
        }

        let grab = null;
        try {
            grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.POPUP });
        } catch (e) {
            console.warn(`${LOG} modal ${id}: pushModal failed: ${e.message}`);
        }
        if (!grab) {
            Main.layoutManager.removeChrome(overlay);
            overlay.destroy();
            if (retry) {
                console.warn(`${LOG} modal ${id}: could not open, pushModal gave no grab (another grab is active?)`);
            } else {
                // The menu or overview is still closing: try once more when it is done
                this._retryOnce(overviewWasVisible);
            }
            return false;
        }

        this._overlay = overlay;
        this._frame = frame;
        this._shell = shell;
        this._glass = Glass.attach(frame, { surface: 'overlays', role: 'content', shadow: shell, isDark: () => dark });
        this._grab = grab;
        this._closing = false;

        overlay.connect('button-press-event', (actor, event) => {
            if (global.stage.get_event_actor(event) !== actor)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.MOTION && this._opts.position === 'right')
                return this._switchToPanelMenu(event);
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            return this._opts.onCapturedKey?.(event, this) ?? Clutter.EVENT_PROPAGATE;
        });
        overlay.connect('key-press-event', (_actor, event) => {
            const r = this._opts.onKeyPress?.(event, this);
            if (r === Clutter.EVENT_STOP)
                return r;
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        overlay.connect('destroy', () => {
            if (this._overlay !== overlay)
                return;
            // Destroyed from outside: the Shell already popped our grab; popping again throws
            this._grab = null;
            this._teardown({ destroyed: true });
        });

        arbiter.opened(id, () => this.close({ immediate: true }));

        let focus = null;
        try {
            focus = build?.(frame, this);
        } catch (e) {
            console.warn(`${LOG} modal ${id}: build failed: ${e.message}`);
            this.close({ immediate: true });
            return false;
        }
        (focus ?? overlay).grab_key_focus();

        this._animate(overlay, shell, 'show');
        return true;
    }

    // The panel menu (other than the Notification Center's own clock button) under the pointer
    _switchToPanelMenu(event) {
        const manager = Main.panel.menuManager;
        const clock = Main.panel.statusArea.dateMenu?.menu;
        const entries = (manager?._menus ?? [])
            .filter(menu => menu !== clock && menu.sourceActor?.mapped)
            .map(menu => {
                const [x, y] = menu.sourceActor.get_transformed_position();
                const [width, height] = menu.sourceActor.get_transformed_size();
                return { menu, rect: { x, y, width, height } };
            });
        const [px, py] = event.get_coords();
        const menu = menuAtPoint(entries, px, py);
        if (!menu)
            return Clutter.EVENT_PROPAGATE;
        // The grab goes first: the menu takes its own when it opens
        this.close({ immediate: true });
        menu.open();
        return Clutter.EVENT_STOP;
    }

    _monitorAt(rect) {
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        return Main.layoutManager.monitors.find(m =>
            cx >= m.x && cy >= m.y && cx < m.x + m.width && cy < m.y + m.height) ??
            Main.layoutManager.primaryMonitor;
    }

    _motionEnv() {
        return { reducedMotion: reducedMotion(), animations: !!St.Settings.get().enable_animations };
    }

    /** Fade the overlay (dim + frame together) and scale the frame's shell about its centre. */
    _animate(overlay, shell, phase, onComplete = null) {
        const m = motionFor(phase, this._motionEnv());
        if (m.duration === 0) {
            onComplete?.();
            return;
        }
        const mode = phase === 'show' ? Clutter.AnimationMode.EASE_OUT_CUBIC : Clutter.AnimationMode.EASE_OUT_QUAD;
        overlay.opacity = m.opacityFrom;
        const moves = m.scaleFrom !== m.scaleTo;
        if (this._opts.position === 'right') {
            // A column slides in from the edge it sits on (only a fade under reduced motion)
            const [from, to] = phase === 'show' ? [SLIDE_PX, 0] : [0, SLIDE_PX];
            shell.translation_x = moves ? from : 0;
            if (moves)
                shell.ease({ translation_x: to, duration: m.duration, mode });
        } else {
            shell.set_scale(m.scaleFrom, m.scaleFrom);
            if (moves)
                shell.ease({ scale_x: m.scaleTo, scale_y: m.scaleTo, duration: m.duration, mode });
        }
        overlay.ease({
            opacity: m.opacityTo, duration: m.duration, mode,
            onComplete: () => onComplete?.(),
        });
    }

    _retryOnce(waitForOverview) {
        if (this._retryToken)
            this._cleanup.release(this._retryToken);
        const go = () => {
            this._retryToken = 0;
            if (!this._overlay && arbiter.current === null)
                this.open(true);
        };
        this._retryToken = waitForOverview && Main.overview.visible
            ? this._cleanup.connect(Main.overview, 'hidden', () => {
                this._cleanup.release(this._retryToken);
                go();
            })
            : this._cleanup.idle(go, { name: `modal-${this._opts.id}-retry` });
    }

    /** @param {{immediate?: boolean}} [opts] */
    close({ immediate = false } = {}) {
        if (!this._overlay)
            return;
        if (this._closing && !immediate)
            return;
        if (immediate || motionFor('hide', this._motionEnv()).duration === 0) {
            this._teardown();
            return;
        }
        this._closing = true;
        // The grab is released at once so keys and focus go back; only the fade is deferred
        this._popGrab();
        const overlay = this._overlay;
        this._shell.remove_all_transitions();
        overlay.remove_all_transitions();
        this._animate(overlay, this._shell, 'hide', () => {
            if (this._overlay === overlay)
                this._teardown();
        });
    }

    _popGrab() {
        const grab = this._grab;
        this._grab = null;
        if (!grab)
            return;
        try {
            Main.popModal(grab);
        } catch (e) {
            console.warn(`${LOG} popModal failed: ${e.message}`);
        }
    }

    _teardown({ destroyed = false } = {}) {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._overlay = null;
        overlay.remove_all_transitions();
        if (!destroyed)
            this._shell?.remove_all_transitions();
        this._glass?.destroy();
        this._glass = null;
        if (!destroyed)
            global.focus_manager.remove_group(overlay);
        this._frame = null;
        this._shell = null;
        this._closing = false;
        arbiter.closed(this._opts.id);
        this._popGrab();
        // Whatever fails here, the reactive full-stage overlay must go
        if (!destroyed) {
            try {
                Main.layoutManager.removeChrome(overlay);
            } catch (_e) {
                // already gone
            }
            overlay.destroy();
        }
        try {
            this._opts.onClosed?.();
        } catch (e) {
            console.warn(`${LOG} modal onClosed failed: ${e.message}`);
        }
    }
}
