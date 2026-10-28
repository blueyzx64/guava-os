// SPDX-License-Identifier: GPL-3.0-or-later
// WidgetView: one live widget on any surface (desktop layer, Notification Center, notch).
//
// It is the card (a faux-glass St.BoxLayout of the size class's pixel size) plus the kind's
// content. Data comes from the kind's shared provider, held only while the view is ACTIVE:
// a surface calls setActive(false) whenever the widget cannot be seen (overview, covered,
// hidden panel), and the provider stops once no active view needs it.
//
//   const view = host.createView('weather', { size: 'small', config: {} }, cleanup);
//   parent.add_child(view.actor);
//   view.setActive(true);
//   view.activate();           // what a plain click does (opens the app)
//   view.menuItems();          // the kind's own options for a right-click menu
//
// Kind definition (core/widgets/kinds/*.js):
//   {id, title, category, sizes, defaultSize, provider,
//    build(view) -> {update(data)}, open?(view), options?(view) -> [{label, active, apply()}]}

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { CleanupRegistry } from '../../lib/disposables.js';
import { Glass } from '../../lib/glass.js';
import { SIZE_PX } from './model.js';

/** Card radius at scale 1: a macOS widget's corner is about 24 pt on a 170 pt card. */
export const RADIUS = 24;
/** Inner padding (macOS 16 pt); content corners are concentric (RADIUS - PADDING). */
export const PADDING = 16;

/** Pixel size of a size class. */
export function pixelSize(size, scale = 1) {
    const s = SIZE_PX[size];
    return { width: s.width * scale, height: s.height * scale };
}

export class WidgetView {
    /**
     * @param {object} host the WidgetHost (core/widgets/index.js)
     * @param {object} def the kind
     * @param {{size: string, config?: object, scale?: number}} opts
     */
    constructor(host, def, { size, config = {}, scale = 1 }) {
        this._host = host;
        this.def = def;
        this.size = size;
        this.config = { ...config };
        this.scale = scale;
        this._ = host.gettext;
        this.cleanup = new CleanupRegistry();
        this._handle = null;
        this._off = null;
        this._destroyed = false;

        const { width, height } = pixelSize(size, scale);
        this.actor = new St.BoxLayout({
            style_class: `guava-widget guava-widget-${def.id} guava-widget-${size}`,
            orientation: Clutter.Orientation.VERTICAL,
            width,
            height,
            reactive: true,
            accessible_name: this._(def.title),
        });
        this.actor.set_style(`border-radius: ${RADIUS * scale}px; padding: ${PADDING * scale}px;`);
        this.content = new St.BoxLayout({
            style_class: 'guava-widget-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this.content);
        const glass = Glass.attach(this.actor, { surface: 'overlays', role: 'content', radius: RADIUS * scale });
        this.cleanup.add(() => glass.destroy());
        this._actorGone = false;
        this.cleanup.connect(this.actor, 'destroy', () => {
            this._actorGone = true;
            this.destroy();
        });

        // null until the provider has data: each kind shows its empty state
        this._renderer = def.build(this);
        this._renderer.update(null);
    }

    /** The running provider while active, else null (for buttons that act in place). */
    get provider() {
        return this._handle?.provider ?? null;
    }

    get active() {
        return this._handle !== null;
    }

    /** Start or stop following the data. Idempotent. */
    setActive(on) {
        if (this._destroyed || on === this.active)
            return;
        if (on) {
            this._handle = this._host.pool.acquire(this.def.provider);
            const provider = this._handle.provider;
            this._off = provider.onChange(data => this._renderer.update(data));
            this._renderer.update(provider.snapshot());
        } else {
            this._off?.();
            this._off = null;
            this._handle.release();
            this._handle = null;
        }
    }

    /** A plain click: open the app behind the widget. */
    activate() {
        try {
            this.def.open?.(this);
        } catch (e) {
            console.error(`[Guava] widget ${this.def.id} could not open its app:`, e);
        }
    }

    /** The kind's own choices for the widget's menu: [{label, active, apply()}]. */
    menuItems() {
        return this.def.options?.(this) ?? [];
    }

    /** Change config (the caller persists it) and rebuild the content. */
    setConfig(config) {
        this.config = { ...this.config, ...config };
        this.content.destroy_all_children();
        this._renderer = this.def.build(this);
        this._renderer.update(this.provider?.snapshot() ?? null);
    }

    destroy() {
        if (this._destroyed)
            return;
        this.setActive(false);
        this._destroyed = true;
        this.cleanup.dispose();
        if (!this._actorGone)
            this.actor.destroy();
    }
}
