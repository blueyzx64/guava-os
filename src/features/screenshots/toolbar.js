// SPDX-License-Identifier: GPL-3.0-or-later
// The macOS Shift+Command+5 strip, drawn over GNOME's screenshot UI while it is open:
//
//   [x] | Entire Screen  Window  Selection | Record Screen  Record Selection | Options v  [Capture]
//
// It is a child of Main.screenshotUI (the stock UI holds the input grab, so only its own
// children get events), on the primary monitor, and replaces the stock bottom panel, which the
// adapter hides. The Options popover (Save to, Timer, Options) is a sibling above the bar.
// The toolbar only reports clicks; index.js drives the screenshot UI.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as A11y from '../../lib/a11y.js';
import { Glass } from '../../lib/glass.js';
import { MODES, TIMERS, normalizeDestination, normalizeTimer } from './model.js';

const MODE_INFO = {
    'screen': { icon: 'screenshot-ui-display-symbolic', label: 'Entire Screen', a11y: 'Capture Entire Screen' },
    'window': { icon: 'screenshot-ui-window-symbolic', label: 'Window', a11y: 'Capture Selected Window' },
    'selection': { icon: 'screenshot-ui-area-symbolic', label: 'Selection', a11y: 'Capture Selected Portion' },
    'record-screen': { icon: 'media-record-symbolic', label: 'Record Screen', a11y: 'Record Entire Screen' },
    'record-selection': { icon: 'screenshot-ui-area-symbolic', label: 'Record Selection', a11y: 'Record Selected Portion', record: true },
};

const SAVE_TO = [
    ['desktop', 'Desktop'], ['documents', 'Documents'], ['clipboard', 'Clipboard'],
    ['pictures', 'Pictures/Screenshots'], ['other', 'Other Location…'],
];
const TOGGLES = [
    ['screenshots-thumbnail', 'Show Floating Thumbnail'],
    ['screenshots-remember-selection', 'Remember Last Selection'],
    ['screenshots-show-pointer', 'Show Mouse Pointer'],
];

export class ScreenshotToolbar {
    /**
     * @param {object} p
     * @param {Clutter.Actor} p.parent the screenshot UI
     * @param {{x: number, y: number, width: number, height: number}} p.area where the bar may go:
     *   the primary work area (layout.workArea), so it sits above the dock
     * @param {import('../../lib/settings.js').GuavaSettings} p.ks
     * @param {object} p.motion ctx.motion
     * @param {(s: string) => string} p._ gettext
     * @param {{mode: Function, capture: Function, close: Function, pickFolder: Function}} p.on
     */
    constructor({ parent, area, ks, motion, _, on }) {
        this._ks = ks;
        this._motion = motion;
        this._ = _;
        this._on = on;
        this._mode = 'selection';
        this._modeButtons = new Map();
        this._optionRows = [];

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(), name: 'guava-screenshot-toolbar-host',
            x: area.x, y: area.y, width: area.width, height: area.height,
        });
        parent.add_child(this.actor);

        this._bar = new St.BoxLayout({
            style_class: 'guava-screenshot-toolbar',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END,
            x_expand: true, y_expand: true, reactive: true,
            accessible_name: _('Screenshot'), accessible_role: A11y.Role.TOOL_BAR,
        });
        this.actor.add_child(this._bar);
        // Tab and the arrow keys walk the toolbar
        global.focus_manager.add_group(this._bar);
        this._build();
        this._glass = Glass.attach(this._bar, { surface: 'overlays', role: 'content' });

        this._popover = null;       // built the first time Options opens
        this._popoverGlass = null;
        this._watch = ks.watch(['screenshots-save-to', 'screenshots-timer', 'screenshots-other-folder',
            ...TOGGLES.map(t => t[0])], () => this._syncOptions());

        this._bar.opacity = 0;
        this._bar.translation_y = 16;
        this._anim = motion.ease(this._bar, { opacity: 255, translation_y: 0 }, { duration: 'short', curve: 'enter' });
    }

    destroy() {
        this._anim?.cancel();
        this._watch?.();
        this._glass?.destroy();
        this._popoverGlass?.destroy();
        this.actor.destroy();
    }

    get mode() {
        return this._mode;
    }

    get optionsOpen() {
        return !!this._popover?.visible;
    }

    /** Reflect the chosen mode, and which modes the stock UI can do right now. */
    sync({ mode, castAvailable, windowsAvailable }) {
        this._mode = mode;
        for (const [m, button] of this._modeButtons) {
            button.checked = m === mode;
            const enabled = m.startsWith('record') ? castAvailable : m !== 'window' || windowsAvailable || mode === 'window';
            button.reactive = enabled;
            button.opacity = enabled ? 255 : 110;
        }
        const record = mode.startsWith('record');
        this._capture.label = record ? this._('Record') : this._('Capture');
        this._capture.accessible_name = this._capture.label;
    }

    /** Hide while a timer counts down, so the bar is not in the way. */
    setHidden(hidden) {
        this.actor.visible = !hidden;
    }

    toggleOptions(open = !this.optionsOpen) {
        if (open && !this._popover)
            this._createPopover();
        if (!this._popover)
            return;
        if (open) {
            // Line the popover up with the Options button, just above the bar (the popover
            // rests on the bottom of the monitor, so it moves up by the bar's distance)
            const [bx] = this._optionsButton.get_transformed_position();
            const [, barY] = this._bar.get_transformed_position();
            const [hx, hy] = this.actor.get_transformed_position();
            const [hw, hh] = this.actor.get_transformed_size();
            this._popover.translation_x = Math.min(Math.max(0, bx - hx), Math.max(0, hw - this._popover.width));
            this._popover.translation_y = -(hy + hh - barY + 8);
        }
        this._popover.visible = open;
        this._optionsButton.checked = open;
    }

    _createPopover() {
        const _ = this._;
        this._popover = new St.BoxLayout({
            style_class: 'guava-screenshot-options',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.END,
            x_expand: true, y_expand: true, reactive: true, visible: false,
            accessible_name: _('Options'), accessible_role: A11y.Role.MENU,
        });
        global.focus_manager.add_group(this._popover);
        this.actor.add_child(this._popover);
        this._buildOptions();
        this._popoverGlass = Glass.attach(this._popover, { surface: 'menus', role: 'content' });
        this._syncOptions();
    }

    // ---- building --------------------------------------------------------------------

    _button(props) {
        return new St.Button({ can_focus: true, accessible_name: props.accessible_name ?? props.label, ...props });
    }

    _separator() {
        this._bar.add_child(new St.Widget({ style_class: 'guava-screenshot-separator', y_expand: true }));
    }

    _build() {
        const _ = this._;
        const close = this._button({
            style_class: 'guava-screenshot-close', accessible_name: _('Close'),
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        close.connect('clicked', () => this._on.close());
        this._bar.add_child(close);
        this._separator();

        MODES.forEach((mode, i) => {
            if (i === 3)
                this._separator();
            const info = MODE_INFO[mode];
            const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER });
            const iconBox = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER });
            iconBox.add_child(new St.Icon({ icon_name: info.icon, icon_size: 20 }));
            if (info.record) {
                iconBox.add_child(new St.Icon({
                    icon_name: 'media-record-symbolic', icon_size: 9, style_class: 'guava-screenshot-record-dot',
                    x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END,
                }));
            }
            box.add_child(iconBox);
            box.add_child(new St.Label({ text: _(info.label), style_class: 'guava-screenshot-mode-label' }));
            const button = this._button({
                style_class: 'guava-screenshot-mode', accessible_name: _(info.a11y),
                toggle_mode: true, child: box, accessible_role: A11y.Role.TOGGLE_BUTTON,
            });
            button.connect('clicked', () => {
                button.checked = this._mode === mode;
                this._on.mode(mode);
            });
            this._modeButtons.set(mode, button);
            this._bar.add_child(button);
        });
        this._separator();

        const optBox = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        optBox.add_child(new St.Label({ text: _('Options'), y_align: Clutter.ActorAlign.CENTER }));
        optBox.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12 }));
        this._optionsButton = this._button({
            style_class: 'guava-screenshot-options-button', accessible_name: _('Options'),
            toggle_mode: true, child: optBox, accessible_role: A11y.Role.TOGGLE_BUTTON, y_align: Clutter.ActorAlign.CENTER,
        });
        this._optionsButton.connect('clicked', () => this.toggleOptions());
        this._bar.add_child(this._optionsButton);

        this._capture = this._button({
            style_class: 'guava-screenshot-capture', label: _('Capture'), y_align: Clutter.ActorAlign.CENTER,
        });
        this._capture.connect('clicked', () => this._on.capture());
        this._bar.add_child(this._capture);
    }

    _header(text) {
        this._popover.add_child(new St.Label({ text, style_class: 'guava-screenshot-options-header' }));
    }

    _row(text, isOn, activate) {
        const check = new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 14, style_class: 'guava-screenshot-check' });
        const label = new St.Label({ text, y_align: Clutter.ActorAlign.CENTER });
        const box = new St.BoxLayout({ x_expand: true });
        box.add_child(check);
        box.add_child(label);
        const row = this._button({
            style_class: 'guava-screenshot-options-row', accessible_name: text, child: box, x_expand: true,
            accessible_role: A11y.Role.CHECK_MENU_ITEM,
        });
        row.connect('clicked', activate);
        this._optionRows.push({ row, check, label, isOn });
        this._popover.add_child(row);
        return { row, label };
    }

    _buildOptions() {
        const _ = this._;
        const ks = this._ks;
        this._header(_('Save to'));
        for (const [value, text] of SAVE_TO) {
            const r = this._row(_(text), () => normalizeDestination(ks.string('screenshots-save-to')) === value, () => {
                if (value === 'other')
                    this._on.pickFolder();
                else
                    ks.setString('screenshots-save-to', value);
            });
            if (value === 'other')
                this._otherRow = r;
        }
        this._popover.add_child(new St.Widget({ style_class: 'guava-screenshot-options-separator' }));
        this._header(_('Timer'));
        for (const s of TIMERS) {
            const text = s === 0 ? _('None') : _('%d Seconds').replace('%d', String(s));
            this._row(text, () => normalizeTimer(ks.int('screenshots-timer')) === s, () => ks.setInt('screenshots-timer', s));
        }
        this._popover.add_child(new St.Widget({ style_class: 'guava-screenshot-options-separator' }));
        this._header(_('Options'));
        for (const [key, text] of TOGGLES)
            this._row(_(text), () => ks.bool(key), () => ks.setBool(key, !ks.bool(key)));
    }

    _syncOptions() {
        if (!this._popover)
            return;
        for (const { row, check, isOn } of this._optionRows) {
            const on = isOn();
            check.opacity = on ? 255 : 0;
            row.checked = on;
        }
        const folder = this._ks.string('screenshots-other-folder');
        this._otherRow.label.text = folder
            ? `${this._('Other Location…')} (${folder.split('/').filter(Boolean).pop() ?? folder})`
            : this._('Other Location…');
    }
}
