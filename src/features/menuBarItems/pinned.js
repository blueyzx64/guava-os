// SPDX-License-Identifier: GPL-3.0-or-later
// Control Center controls pinned to the menu bar (macOS Big Sur "Show in Menu Bar", Tahoe
// F39): Wi-Fi, Bluetooth, Sound, Battery, Focus, Now Playing, Keyboard Brightness and Screen
// Recording, each "Always" or "When Active" (menubar-pinned).
//
// A pinned item does not copy GNOME's logic: it mirrors the stock Quick Settings item. Its
// icon follows the stock icon, its switch flips the stock toggle, its slider moves the stock
// slider, and its dropdown lists the stock item's own menu rows (networks, devices, outputs),
// which activate the stock rows. So it stays right whatever GNOME does inside.
//
// Private Shell API: the Quick Settings items of lib/quickSettings.js stockKeys(),
// QuickToggle/QuickMenuToggle/QuickSlider (`menu`, `slider`, `checked`, `toggleMode`),
// quickSettings._system._systemItem.powerToggle (title, gicon, _proxy), Main.screenshotUI
// (screencast-in-progress, stopScreencast). Checked against gnome-shell 50.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { spawn } from 'resource:///org/gnome/shell/misc/util.js';

import { MprisWatcher } from '../../core/mprisWatcher.js';
import { batteryTime } from '../../lib/batteryModel.js';
import { CleanupRegistry } from '../../lib/disposables.js';
import { LazyMenu } from '../../lib/lazyMenu.js';
import { MenuGlass } from '../../lib/menuGlass.js';
import { stockKeys } from '../../lib/quickSettings.js';
import { PINNABLE, batteryText, parsePins, pinShown } from '../../lib/menuBarPins.js';

const UPOWER_DISCHARGING = 2;

const PinButton = GObject.registerClass(
class GuavaPinnedControl extends PanelMenu.Button {
    _init(name, fill) {
        super._init(0.5, name, false);
        this.setMenu(new LazyMenu(this, fill));
        this.add_style_class_name('guava-menubar-pinned');
        const box = new St.BoxLayout({ style_class: 'guava-menubar-pinned-box', y_align: Clutter.ActorAlign.CENTER });
        this.icon = new St.Icon({ style_class: 'system-status-icon' });
        this.label = new St.Label({ style_class: 'guava-menubar-pinned-label', y_align: Clutter.ActorAlign.CENTER, visible: false });
        box.add_child(this.icon);
        box.add_child(this.label);
        this.add_child(box);
    }
});

// ---- mirrors of stock rows ------------------------------------------------------------------

/** Flip a stock toggle the way a click on it would. */
function flip(toggle) {
    if (toggle.toggleMode)
        toggle.checked = !toggle.checked;
    else
        toggle.emit('clicked', Clutter.BUTTON_PRIMARY);
}

function heading(text) {
    const item = new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false });
    item.add_style_class_name('guava-menubar-menu-heading');
    return item;
}

function info(text) {
    const item = new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false });
    item.label.add_style_class_name('guava-menubar-items-info');
    return item;
}

/** A switch row bound to a stock toggle while the menu shows it. */
function switchFor(toggle, title, reg) {
    const row = new PopupMenu.PopupSwitchMenuItem(title, !!toggle.checked);
    reg.connect(toggle, 'notify::checked', () => row.setToggleState(!!toggle.checked));
    row.connect('toggled', (_r, state) => {
        if (state !== !!toggle.checked)
            flip(toggle);
    });
    return row;
}

/** A slider row moving a stock Slider (both ways). */
function sliderFor(stockSlider, iconName, reg) {
    const row = new PopupMenu.PopupBaseMenuItem({ activate: false, style_class: 'guava-menubar-pinned-slider' });
    if (iconName)
        row.add_child(new St.Icon({ icon_name: iconName, style_class: 'popup-menu-icon' }));
    const slider = new Slider(stockSlider.value);
    slider.accessible_name = stockSlider.accessible_name ?? '';
    slider.x_expand = true;
    row.add_child(slider);
    let syncing = false;
    reg.connect(stockSlider, 'notify::value', () => {
        syncing = true;
        slider.value = stockSlider.value;
        syncing = false;
    });
    slider.connect('notify::value', () => {
        if (!syncing)
            stockSlider.value = slider.value;
    });
    return row;
}

/** The rows of a stock item's menu, as rows that activate the stock ones. */
function mirrorRows(menu, stockMenu, reg) {
    const walk = source => {
        for (const item of source?._getMenuItems?.() ?? []) {
            if (item instanceof PopupMenu.PopupMenuSection) {
                walk(item);
            } else if (item instanceof PopupMenu.PopupSeparatorMenuItem) {
                if (menu.numMenuItems)
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            } else if (item.visible && item._slider) {
                menu.addMenuItem(sliderFor(item._slider, null, reg));
            } else if (item.visible && (item.label ?? item._label)?.text) {
                // Network rows (ui/status/network.js) keep their name in `_label`
                const row = new PopupMenu.PopupMenuItem((item.label ?? item._label).text);
                row.setOrnament(item._ornament ?? PopupMenu.Ornament.NONE);
                row.setSensitive(item.sensitive && item.reactive);
                row.connect('activate', () => item.activate(Clutter.get_current_event()));
                menu.addMenuItem(row);
            }
        }
    };
    walk(stockMenu);
}

// ---- the items ------------------------------------------------------------------------------

/**
 * Per control: the stock source, its "active" state, its icon and its menu.
 * `src(qs, byKey)` returns the stock actor (or null when the computer lacks it).
 */
const KINDS = {
    'wifi': {
        src: (qs, byKey) => byKey.get('wifi') ?? null,
        active: t => !!t.checked && !!t.visible,
        fill: (p, menu, t) => {
            menu.addMenuItem(switchFor(t, p._('Wi-Fi'), p.menuReg));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            mirrorRows(menu, t.menu, p.menuReg);
        },
    },
    'bluetooth': {
        src: (qs, byKey) => byKey.get('bluetooth') ?? null,
        // Its subtitle names the connected device(s)
        active: t => !!t.checked && !!t.subtitle,
        fill: (p, menu, t) => {
            menu.addMenuItem(switchFor(t, p._('Bluetooth'), p.menuReg));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            mirrorRows(menu, t.menu, p.menuReg);
        },
    },
    'sound': {
        src: (qs, byKey) => byKey.get('volume-out') ?? null,
        active: s => s.slider.value > 0 && s.iconName !== 'audio-volume-muted-symbolic',
        fill: (p, menu, s) => {
            menu.addMenuItem(heading(p._('Sound')));
            menu.addMenuItem(sliderFor(s.slider, 'audio-volume-high-symbolic', p.menuReg));
            if (s.menuEnabled) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                menu.addMenuItem(heading(p._('Output')));
                mirrorRows(menu, s.menu, p.menuReg);
            }
        },
    },
    'focus': {
        src: (qs, byKey) => byKey.get('dnd') ?? null,
        active: t => !!t.checked,
        fill: (p, menu, t) => menu.addMenuItem(switchFor(t, p._('Do Not Disturb'), p.menuReg)),
    },
    'keyboard-brightness': {
        src: (qs, byKey) => byKey.get('backlight') ?? null,
        active: t => !!t.checked,
        fill: (p, menu, t) => {
            menu.addMenuItem(switchFor(t, p._('Keyboard Brightness'), p.menuReg));
            if (t.menu) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                mirrorRows(menu, t.menu, p.menuReg);
            }
        },
    },
    'battery': {
        src: qs => qs._system?._systemItem?.powerToggle ?? null,
        active: () => true,
        fill: (p, menu, t) => p.fillBattery(menu, t),
    },
    'now-playing': {
        own: true,
        active: p => p.player()?.isPlaying?.() ?? false,
        fill: p => p.fillNowPlaying(),
    },
    'screen-recording': {
        own: true,
        active: () => !!Main.screenshotUI?.screencast_in_progress,
        fill: p => p.fillRecording(),
    },
};

const ICONS = {
    'now-playing': 'audio-x-generic-symbolic',
    'screen-recording': 'media-record-symbolic',
    'focus': 'notifications-disabled-symbolic',
};

class PinnedItem {
    constructor({ id, mode, ctx, qs, byKey, manager, onDead }) {
        this.id = `pin:${id}`;
        this.kind = id;
        this._def = KINDS[id];
        this._ctx = ctx;
        this._ = ctx.gettext;
        this._qs = qs;
        this._mode = mode;
        this._manager = manager;
        this._reg = new CleanupRegistry();
        this.menuReg = null;
        this.title = this._(PINNABLE.find(p => p.id === id).title);
        this._source = this._def.own ? null : this._def.src(qs, byKey);
        this.button = new PinButton(this.title, menu => this.fillMenu(menu));
        this.button.add_style_class_name(`guava-menubar-pin-${id}`);
        this._reg.connect(this.button.menu, 'open-state-changed', (_m, open) => {
            if (!open)
                this._dropMenuReg();
        });
        this._bindIcon();
        this._watchState(onDead);
        this._handle = null;
    }

    get container() {
        return this.button.container;
    }

    get wanted() {
        // The computer lacks it (no Wi-Fi adapter, no battery)
        if (!this._def.own && !this._source?.visible)
            return false;
        return pinShown(this._mode, this.active);
    }

    get active() {
        try {
            return this._def.own ? this._def.active(this) : this._def.active(this._source);
        } catch (_e) {
            return false;
        }
    }

    gicon() {
        return this.button.icon.gicon;
    }

    attach(handle) {
        this._handle = handle;
    }

    setMode(mode) {
        this._mode = mode;
        this._handle?.changed();
    }

    destroy() {
        this._dropMenuReg();
        this._handle?.remove();
        this._reg.dispose();
        this.button.destroy();
    }

    _changed() {
        this._handle?.changed();
    }

    _dropMenuReg() {
        this.menuReg?.dispose();
        this.menuReg = null;
    }

    _bindIcon() {
        const icon = this.button.icon;
        const src = this._source;
        if (src && 'gicon' in src && (src.gicon || this.kind === 'battery')) {
            this._reg.add(bindingUndo(src.bind_property('gicon', icon, 'gicon', GObject.BindingFlags.SYNC_CREATE)));
        } else if (src) {
            this._reg.add(bindingUndo(src.bind_property('icon-name', icon, 'icon-name', GObject.BindingFlags.SYNC_CREATE)));
        } else {
            icon.icon_name = ICONS[this.kind] ?? 'emblem-system-symbolic';
        }
        if (this.kind === 'battery')
            this._syncBatteryLabel();
    }

    _syncBatteryLabel() {
        const pct = this._source?._proxy?.Percentage;
        const text = batteryText(pct, this._ctx.settings.get_boolean('menubar-battery-percentage'));
        this.button.label.text = text;
        this.button.label.visible = !!text;
    }

    _watchState(onDead) {
        const src = this._source;
        if (src) {
            // GNOME rebuilds some items (a Wi-Fi device that comes back): forget a dead one
            this._reg.connect(src, 'destroy', () => {
                this._source = null;
                onDead();
            });
            for (const prop of ['checked', 'visible', 'subtitle', 'icon-name', 'gicon', 'title'])
                this._reg.connect(src, `notify::${prop}`, () => this._onSourceChanged());
            if (src.slider)
                this._reg.connect(src.slider, 'notify::value', () => this._changed());
        }
        if (this.kind === 'battery')
            this._reg.connect(this._ctx.settings, 'changed::menubar-battery-percentage', () => this._onSourceChanged());
        if (this.kind === 'now-playing') {
            this._mpris = MprisWatcher.acquire(this._reg, this._);
            this._players = new Map();
            const track = player => {
                if (this._players.has(player))
                    return;
                this._players.set(player, player.connect('changed', () => this._changed()));
            };
            this._mpris.players.forEach(track);
            this._mpris.on('player-added', player => {
                track(player);
                this._changed();
            });
            this._mpris.on('player-removed', player => {
                const id = this._players.get(player);
                if (id)
                    player.disconnect(id);
                this._players.delete(player);
                this._changed();
            });
            this._reg.add(() => {
                for (const [player, id] of this._players)
                    player.disconnect(id);
                this._players.clear();
            });
        }
        if (this.kind === 'screen-recording' && Main.screenshotUI)
            this._reg.connect(Main.screenshotUI, 'notify::screencast-in-progress', () => this._changed());
    }

    _onSourceChanged() {
        if (this.kind === 'battery')
            this._syncBatteryLabel();
        this._changed();
    }

    player() {
        const players = this._mpris?.players ?? [];
        return players.find(p => p.isPlaying?.()) ?? players[0] ?? null;
    }

    fillMenu(menu) {
        this._dropMenuReg();
        this.menuReg = new CleanupRegistry();
        menu.removeAll();
        this._fillTarget = menu;
        try {
            this._def.fill(this, menu, this._source);
        } catch (e) {
            console.error(`[Guava] pinned ${this.kind}: menu failed:`, e);
        }
        if (!menu.numMenuItems)
            menu.addMenuItem(info(this._('Not available')));
    }

    // ---- battery ---------------------------------------------------------------------------

    fillBattery(menu, toggle) {
        const _ = this._;
        const proxy = toggle._proxy;
        menu.addMenuItem(heading(`${_('Battery')}  ${toggle.title ?? ''}`));
        const time = proxy ? batteryTime({ state: proxy.State, toEmpty: proxy.TimeToEmpty, toFull: proxy.TimeToFull }) : null;
        if (time) {
            const hm = `${time.hours}:${String(time.minutes).padStart(2, '0')}`;
            menu.addMenuItem(info(time.kind === 'remaining'
                ? _('%s remaining').replace('%s', hm) : _('%s until full').replace('%s', hm)));
        }
        const onBattery = proxy?.State === UPOWER_DISCHARGING;
        menu.addMenuItem(info(`${_('Power Source:')} ${onBattery ? _('Battery') : _('Power Adapter')}`));
        const lp = this._ctx.features.instance('low-power');
        if (lp?.available) {
            const row = new PopupMenu.PopupSwitchMenuItem(_('Low Power Mode'), lp.active);
            row.connect('toggled', () => lp.toggle());
            this.menuReg.add(this._ctx.events.on('low-power-changed', ({ active }) => row.setToggleState(active)));
            menu.addMenuItem(row);
        }
        const health = lp?.health ?? null;
        if (health) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const condition = health.condition === 'service' ? _('Service Recommended') : _('Normal');
            menu.addMenuItem(info(`${_('Battery Health:')} ${condition} (${health.percent}%)`));
            if (health.cycles)
                menu.addMenuItem(info(`${_('Cycle Count:')} ${health.cycles}`));
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem(_('Battery Settings…'));
        settings.connect('activate', () => spawn(['gnome-control-center', 'power']));
        menu.addMenuItem(settings);
    }

    // ---- now playing -----------------------------------------------------------------------

    fillNowPlaying() {
        const _ = this._;
        const menu = this._fillTarget;
        const player = this.player();
        if (!player) {
            menu.addMenuItem(info(_('Nothing is playing')));
            return;
        }
        menu.addMenuItem(heading(player.trackTitle || _('Unknown title')));
        const artists = [].concat(player.trackArtists ?? []).join(', ');
        if (artists)
            menu.addMenuItem(info(artists));
        const row = new PopupMenu.PopupBaseMenuItem({ activate: false, can_focus: false, style_class: 'guava-menubar-pinned-media' });
        const controls = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style_class: 'guava-menubar-pinned-media-box' });
        const play = player.isPlaying() ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        for (const [icon, name, fn] of [
            ['media-skip-backward-symbolic', _('Previous'), () => player.previous()],
            [play, _('Play or Pause'), () => player.playPause()],
            ['media-skip-forward-symbolic', _('Next'), () => player.next()],
        ]) {
            const button = new St.Button({
                style_class: 'guava-menubar-pinned-media-button', can_focus: true,
                accessible_name: name, child: new St.Icon({ icon_name: icon }),
            });
            button.connect('clicked', fn);
            controls.add_child(button);
        }
        row.add_child(controls);
        menu.addMenuItem(row);
    }

    // ---- screen recording ------------------------------------------------------------------

    fillRecording() {
        const _ = this._;
        const menu = this._fillTarget;
        const ui = Main.screenshotUI;
        if (ui?.screencast_in_progress) {
            const stop = new PopupMenu.PopupMenuItem(_('Stop Recording'));
            stop.connect('activate', () => ui.stopScreencast());
            menu.addMenuItem(stop);
            return;
        }
        const record = new PopupMenu.PopupMenuItem(_('Record Screen…'));
        record.connect('activate', () => Screenshot.showScreenRecordingUI());
        const shot = new PopupMenu.PopupMenuItem(_('Take Screenshot…'));
        shot.connect('activate', () => Screenshot.showScreenshotUI());
        menu.addMenuItem(record);
        menu.addMenuItem(shot);
    }
}

function bindingUndo(binding) {
    return () => binding.unbind();
}

/**
 * The pinned items: built from `menubar-pinned`, rebuilt when it changes.
 */
export class PinnedControls {
    constructor(ctx, cleanup, manager) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._manager = manager;
        this._items = new Map();   // control id -> PinnedItem
        this._qs = null;
        this._byKey = null;
        this._glass = new MenuGlass(cleanup);
    }

    /** The pinned item of a control (tests, harness). */
    item(id) {
        return this._items.get(id) ?? null;
    }

    start(qs) {
        this._qs = qs;
        this._cleanup.connect(this._ctx.settings, 'changed::menubar-pinned', () => this._sync());
        this._cleanup.connect(Main.panel, 'destroy', () => {
            this._stopped = true;
        });
        this._cleanup.add(() => {
            this._stopped = true;
            for (const item of this._items.values())
                item.destroy();
            this._items.clear();
        });
        this._sync();
    }

    /** A stock item died (GNOME rebuilt it): build its pin again on the new one. */
    _rebuild(id) {
        if (this._stopped)
            return;
        this._cleanup.idle(() => {
            if (this._stopped)
                return;
            this._items.get(id)?.destroy();
            this._items.delete(id);
            this._sync();
        }, { name: 'menu bar pinned control rebuild' });
    }

    _sync() {
        // Looked up each time: GNOME replaces some items (Wi-Fi when its device comes back)
        this._byKey = new Map([...stockKeys(this._qs)].map(([actor, key]) => [key, actor]));
        const pins = parsePins(this._ctx.settings.get_strv('menubar-pinned'));
        for (const [id, item] of [...this._items]) {
            if (!pins.has(id)) {
                item.destroy();
                this._items.delete(id);
            }
        }
        for (const [id, mode] of pins) {
            const old = this._items.get(id);
            if (old) {
                old.setMode(mode);
                continue;
            }
            try {
                const item = new PinnedItem({
                    id, mode, ctx: this._ctx, qs: this._qs, byKey: this._byKey, manager: this._manager,
                    onDead: () => this._rebuild(id),
                });
                Main.panel.addToStatusArea(`guava-pin-${id}`, item.button, 0, 'right');
                this._glass.add(item.button.menu);
                this._items.set(id, item);
                item.attach(this._manager.add(item));
            } catch (e) {
                console.error(`[Guava] pinned control ${id} failed:`, e);
            }
        }
    }
}
