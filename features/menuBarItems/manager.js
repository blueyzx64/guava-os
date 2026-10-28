// SPDX-License-Identifier: GPL-3.0-or-later
// The menu bar item manager (Tahoe's Menu Bar settings, Bartender/Ice): every status item on
// the right of the menu bar, Guava's and others', in the user's order (menubar-item-order),
// minus the ones the user hid (menubar-item-hidden). When they do not fit beside the notch,
// the ones at the left end go behind a chevron (menubar-overflow), whose menu opens theirs.
//
// Items come from pinned.js (pin:*), host.js (sni:*) and the foreign items adopted here:
// GNOME's input-source menu (stock:keyboard; GNOME already shows it only with two or more
// sources) and the AppIndicator extension's icons (appindicator-* roles) while
// Guava defers to it. A foreign item is never destroyed: it is hidden with a tracked restore
// and put back at its old index on disable.
//
// Places: PanelLayout claims, chained left to right: the chevron before the show-desktop,
// clipboard, privacy and Control Center slots, then each item after the previous one.
// Private Shell API: Main.panel._rightBox, _centerBox, statusArea (48-51).

import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { PanelLayout } from '../../core/panelLayout.js';
import { LazyMenu } from '../../lib/lazyMenu.js';
import { MenuGlass } from '../../lib/menuGlass.js';
import { GuavaSettings } from '../../lib/settings.js';
import { barOrder, planBar, sniId, updateRegistry } from './model.js';

export const CHEVRON_ID = 'guava-menubar-overflow';
const ANCHOR = ['show-desktop', 'clipboard', 'guava-menubar-privacy', 'quickSettings'];
const FOREIGN_ROLES = { keyboard: 'stock:keyboard' };
const APPINDICATOR_PREFIX = 'appindicator-';

const Chevron = GObject.registerClass(
class GuavaMenuBarChevron extends PanelMenu.Button {
    _init(name, fill) {
        super._init(0.5, name, false);
        this.setMenu(new LazyMenu(this, fill));
        this.add_style_class_name('guava-menubar-chevron');
        this.add_child(new St.Icon({ icon_name: 'pan-start-symbolic', style_class: 'system-status-icon' }));
    }
});

/** Keeps a foreign actor hidden and remembers what its owner wants meanwhile. */
class Hold {
    constructor(actor, onWanted) {
        this.wanted = actor.visible;
        this._actor = actor;
        this._self = false;
        this._id = actor.connect('notify::visible', () => {
            if (this._self)
                return;
            this.wanted = actor.visible;
            if (actor.visible)
                this._hide();
            onWanted();
        });
        this._hide();
    }

    _hide() {
        this._self = true;
        this._actor.hide();
        this._self = false;
    }

    release() {
        try {
            this._actor.disconnect(this._id);
            this._actor.visible = this.wanted;
        } catch (_e) {
            // Destroyed by its owner
        }
    }
}

export class BarManager {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._items = new Map();     // id -> item
        this._slots = new Map();     // id -> PanelLayout slot
        this._foreign = new Map();   // id -> {item, box, index, hold, token}
        this._applied = [];          // order last placed
        this._overflow = [];
        this._idle = 0;
        this._chevron = null;
    }

    /** {shown, overflow, chevron, order} of the last pass (tests, harness). */
    get state() {
        return { ...this._last };
    }

    get chevron() {
        return this._chevron;
    }

    item(id) {
        return this._items.get(id) ?? null;
    }

    start() {
        const cleanup = this._cleanup;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._ks.watch(['menubar-item-order', 'menubar-item-hidden', 'menubar-overflow'], () => this.queue());

        const _ = this._ctx.gettext;
        this._chevron = new Chevron(_('More Menu Bar Items'), menu => this._fillChevron(menu));
        Main.panel.addToStatusArea(CHEVRON_ID, this._chevron, 0, 'right');
        new MenuGlass(cleanup).add(this._chevron.menu);
        this._chevron.container.hide();
        cleanup.add(() => {
            this._chevron.destroy();
            this._chevron = null;
        });

        const right = Main.panel._rightBox;
        const center = Main.panel._centerBox;
        // The Shell is going away (its panel first): plan nothing more
        cleanup.connect(Main.panel, 'destroy', () => this.stop());
        cleanup.connect(right, 'child-added', () => this.queue(true));
        cleanup.connect(right, 'child-removed', () => this.queue(true));
        cleanup.connect(right, 'notify::width', () => this.queue());
        cleanup.connect(Main.panel, 'notify::width', () => this.queue());
        if (center)
            cleanup.connect(center, 'notify::width', () => this.queue());

        cleanup.add(() => {
            for (const id of [...this._foreign.keys()])
                this._dropForeign(id);
            for (const slot of this._slots.values())
                slot.release();
            this._slots.clear();
        });
        this.queue(true);
    }

    /**
     * Add an item. It calls handle.changed() when its width, title or `wanted` change.
     *
     * @param {{id: string, title: string, container: Clutter.Actor, wanted: boolean,
     *   gicon?: () => ?Gio.Icon, fillMenu?: (menu) => void, activate?: () => void}} item
     */
    add(item) {
        this._items.set(item.id, item);
        this.queue();
        let destroyToken = 0;
        const handle = {
            changed: () => this.queue(),
            remove: () => {
                if (this._items.get(item.id) !== item)
                    return;
                this._cleanup.release(destroyToken);
                this._items.delete(item.id);
                this._slots.get(item.id)?.release();
                this._slots.delete(item.id);
                this.queue();
            },
        };
        destroyToken = this._cleanup.connect(item.container, 'destroy', () => handle.remove());
        return handle;
    }

    /** Stop planning: the parts are being torn down (runs first on disable). */
    stop() {
        this._stopped = true;
        if (this._idle)
            this._cleanup.release(this._idle);
        this._idle = 0;
    }

    queue(rescan = false) {
        this._rescan ||= rescan;
        if (this._idle || this._stopped)
            return;
        this._idle = this._cleanup.idle(() => {
            this._idle = 0;
            if (this._rescan) {
                this._rescan = false;
                this._scanForeign();
            }
            this._replan();
        }, { name: 'menu bar items layout' });
    }

    // ---- foreign items ----------------------------------------------------------------

    _scanForeign() {
        const right = Main.panel._rightBox;
        const seen = new Set();
        for (const [role, indicator] of Object.entries(Main.panel.statusArea ?? {})) {
            const container = indicator?.container;
            if (!container || container.get_parent() !== right)
                continue;
            let id = FOREIGN_ROLES[role] ?? null;
            if (!id && role.startsWith(APPINDICATOR_PREFIX))
                id = sniId(indicator._indicator?.id, indicator.accessible_name, role.slice(APPINDICATOR_PREFIX.length));
            if (!id || this._items.has(id) && !this._foreign.has(id))
                continue;
            seen.add(id);
            if (!this._foreign.has(id))
                this._adoptForeign(id, role, indicator);
        }
        for (const id of [...this._foreign.keys()]) {
            if (!seen.has(id))
                this._dropForeign(id);
        }
    }

    _adoptForeign(id, role, indicator) {
        const container = indicator.container;
        const box = container.get_parent();
        const entry = { box, index: box.get_children().indexOf(container), hold: null, token: 0 };
        entry.item = {
            id,
            title: indicator.accessible_name || role,
            container,
            foreign: true,
            get wanted() {
                return entry.hold ? entry.hold.wanted : container.visible;
            },
            gicon: () => null,
            fillMenu: null,
            activate: () => indicator.menu?.toggle?.(),
        };
        entry.token = this._cleanup.connect(container, 'notify::visible', () => {
            if (!entry.hold)
                this.queue();
        });
        entry.destroyToken = this._cleanup.connect(container, 'destroy', () => {
            entry.dead = true;
            this._dropForeign(id);
        });
        this._foreign.set(id, entry);
        this._items.set(id, entry.item);
    }

    _dropForeign(id) {
        const entry = this._foreign.get(id);
        if (!entry)
            return;
        this._foreign.delete(id);
        this._items.delete(id);
        this._cleanup.release(entry.token);
        this._cleanup.release(entry.destroyToken);
        this._slots.get(id)?.release();
        this._slots.delete(id);
        if (entry.dead)
            return;
        entry.hold?.release();
        const actor = entry.item.container;
        try {
            if (actor.get_parent() === entry.box)
                entry.box.set_child_at_index(actor, Math.min(entry.index, entry.box.get_n_children() - 1));
        } catch (_e) {
            // Gone with its owner
        }
    }

    _setShown(item, shown) {
        if (!item.foreign) {
            item.container.visible = shown;
            return;
        }
        const entry = this._foreign.get(item.id);
        if (!shown && !entry.hold) {
            entry.hold = new Hold(item.container, () => this.queue());
        } else if (shown && entry.hold) {
            const hold = entry.hold;
            entry.hold = null;
            hold.release();
        }
    }

    // ---- planning -----------------------------------------------------------------------

    _available() {
        const panel = Main.panel;
        const right = panel._rightBox;
        const [, centerNat] = panel._centerBox?.get_preferred_width(-1) ?? [0, 0];
        const side = Math.floor(Math.max(0, panel.width - centerNat) / 2);
        const managed = new Set([...this._items.values()].map(i => i.container));
        managed.add(this._chevron.container);
        let fixed = 0;
        for (const child of right.get_children()) {
            if (child.visible && !managed.has(child))
                fixed += child.get_preferred_width(-1)[1];
        }
        return side - fixed;
    }

    _replan() {
        if (!this._chevron)
            return;
        const ids = [...this._items.keys()];
        const order = barOrder(this._ks.strv('menubar-item-order'), ids);
        this._remember(order);
        const widths = new Map(order.map(id => [id, this._items.get(id).container.get_preferred_width(-1)[1]]));
        const plan = planBar({
            order,
            hidden: this._ks.strv('menubar-item-hidden'),
            idle: order.filter(id => !this._items.get(id).wanted),
            widths,
            available: this._available(),
            chevron: this._chevron.container.get_preferred_width(-1)[1],
            overflow: this._ks.bool('menubar-overflow'),
        });
        this._last = { ...plan, order };
        this._overflow = plan.overflow;

        if (order.join('\n') !== this._applied.join('\n') || order.some(id => !this._slots.has(id)))
            this._place(order);
        const shown = new Set(plan.shown);
        for (const id of order)
            this._setShown(this._items.get(id), shown.has(id));
        this._chevron.container.visible = plan.chevron;
        if (!plan.chevron)
            this._chevron.menu.close();
    }

    _place(order) {
        let prev = null;
        for (const id of [CHEVRON_ID, ...order]) {
            const anchor = prev ? { after: [prev], fallback: 'last' } : { before: ANCHOR, fallback: 'last' };
            const slot = this._slots.get(id);
            if (slot) {
                slot.update({ box: 'right', anchor });
            } else {
                const actor = id === CHEVRON_ID ? this._chevron.container : this._items.get(id).container;
                this._slots.set(id, PanelLayout.claim(null, { id, actor, box: 'right', anchor }));
            }
            prev = id;
        }
        this._applied = order;
    }

    /** The prefs list the items they have seen (menubar-item-registry). */
    _remember(order) {
        const items = order.map(id => ({ id, title: this._items.get(id).title }));
        const old = this._ks.strv('menubar-item-registry');
        const next = updateRegistry(old, items);
        if (next.join('\n') !== old.join('\n'))
            this._ks.setStrv('menubar-item-registry', next);
    }

    // ---- the chevron menu ----------------------------------------------------------------

    _fillChevron(menu) {
        const _ = this._ctx.gettext;
        menu.removeAll();
        for (const id of this._overflow) {
            const item = this._items.get(id);
            if (!item)
                continue;
            if (item.fillMenu) {
                const gicon = item.gicon?.() ?? null;
                const sub = new PopupMenu.PopupSubMenuMenuItem(item.title, !!gicon);
                if (gicon)
                    sub.icon.gicon = gicon;
                sub.menu.connect('open-state-changed', (m, open) => {
                    if (open)
                        item.fillMenu(m);
                });
                // A submenu opens only with an item in it
                item.fillMenu(sub.menu);
                menu.addMenuItem(sub);
            } else {
                const row = new PopupMenu.PopupMenuItem(item.title);
                row.connect('activate', () => {
                    // After the chevron menu closed, so the item's own menu can grab
                    this._cleanup.idle(() => item.activate?.(), { name: 'menu bar overflow item' });
                });
                menu.addMenuItem(row);
            }
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem(_('Menu Bar Settings…'));
        settings.connect('activate', () => this._ctx.extension?.openPreferences?.());
        menu.addMenuItem(settings);
    }
}

