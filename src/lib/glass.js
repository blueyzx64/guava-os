// SPDX-License-Identifier: GPL-3.0-or-later
// GlassService: Guava's one Liquid Glass. Every Guava surface (menus, Control Center,
// Spotlight, Quick Paste, the clipboard popover, the calendar, the Stage Manager floor, the
// menu bar and the dock) gets the same look from here; the rules are in lib/glassParams.js
// and the CSS in styles/base.css.
//
// The backdrop is real: lib/glassBlur.js (one effect on the surface actor) blurs what is behind
// the surface, boosts its saturation, lays the tint over it and cuts the rounded corners. The
// menu bar and the dock keep one static blur while only the wallpaper is behind them; menus and
// overlays blur live. The edge, the rim and the borders stay St style classes, plus an inline
// fragment that turns the St background transparent (the effect draws the fill). Without the
// effect (an API missing, a paint error) the St fill of glassParams carries the look alone.
// handle.setPresence(0..1) fades the glass (the menu bar leaving Mission Control) without
// touching the classes. The soft drop shadow is drawn by an optional
// "shadow host": an existing actor with the same rect right behind the surface (a menu's
// BoxPointer bin, the modal's shell). Without one a surface has no drop shadow.
//
// API (kept for every feature):
//   Glass.configure(settings)              extension.js, once; null on disable
//   Glass.attach(actor, opts) -> handle    opts: surface ('panel'|'menus'|'dock'|'overlays'),
//                                          role ('content'|'bar'), shadow (host actor),
//                                          radius (px, for targets whose CSS has none),
//                                          isDark (() => bool, default: the theme's text
//                                          colour on the actor), layers ('glass' | 'blur':
//                                          'blur' resolves but draws nothing)
//   Glass.attachMenu(menu, opts) -> handle a PopupMenu: its box, with its BoxPointer bin as host
//   handle.setVisible(bool) / setPresence(0..1) / refresh() / destroy(); handle.tier /
//                                          handle.params (the look); presence multiplies
//                                          across handles, setVisible(false) drops the classes
//   Glass.wants(surface, settings?)        is that surface glass right now
//   Glass.watch(registry, fn)              fn({snapshot, env}) now and on every change; env has
//                                          dark, highContrast (GNOME), contrast (Guava or GNOME),
//                                          opaque (Reduce Transparency or contrast), reducedMotion
//   Glass.motion                           false under reduced motion
//
// The service owns the glass settings, the colour scheme, GNOME high contrast, reduced motion
// and the wallpaper sample (lib/wallpaperTint.js). It runs only while something is attached
// or watching.

import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { CleanupRegistry } from './disposables.js';
import { GuavaSettings } from './settings.js';
import { watchReducedMotion } from './compat.js';
import { WallpaperTint } from './wallpaperTint.js';
import { GlassBlurEffect, blurSupported, governor, setFailureHandler, setPaintedView } from './glassBlur.js';
import {
    SETTING_FIELDS, readSnapshot, wantsSurface, resolve, fillStyle, glassClasses, hostClasses,
    hostStyle, stripFragments, contrastOn, opaqueOn, effectColors, captureMode, captureMargin,
} from './glassParams.js';

/**
 * One inline style fragment Guava appends to an actor's style, kept at the end even when
 * someone else rewrites the style while it is set (the calendar sets the menu width, for one).
 */
class StyleFragment {
    constructor(actor) {
        this._actor = actor;
        this._fragment = '';
        this._writing = false;
        this._notifyId = 0;
    }

    set(fragment) {
        if (fragment === this._fragment)
            return;
        const base = this._base();
        this._fragment = fragment;
        this._write(base);
        if (fragment && !this._notifyId)
            this._notifyId = this._actor.connect('notify::style', () => this._resync());
        else if (!fragment && this._notifyId)
            this._disconnect();
    }

    /** The actor's style without any Guava fragment. */
    _base() {
        return stripFragments(this._actor.get_style());
    }

    _write(base) {
        this._writing = true;
        try {
            const style = base + this._fragment;
            this._actor.set_style(style || null);
        } finally {
            this._writing = false;
        }
    }

    // Someone replaced the whole style: put ours back after theirs
    _resync() {
        if (this._writing || !this._fragment)
            return;
        const base = this._base();
        if ((this._actor.get_style() ?? '') !== base + this._fragment)
            this._write(base);
    }

    _disconnect() {
        if (this._notifyId)
            this._actor.disconnect(this._notifyId);
        this._notifyId = 0;
    }

    /** Remove the fragment; dead: the actor is disposed, only forget. */
    clear(dead = false) {
        if (dead) {
            this._notifyId = 0;
            this._fragment = '';
            return;
        }
        this.set('');
    }
}

/** A set of style classes Guava puts on one actor. */
class ClassSet {
    constructor(actor) {
        this._actor = actor;
        this._classes = [];
    }

    set(wanted) {
        for (const c of this._classes) {
            if (!wanted.includes(c))
                this._actor.remove_style_class_name(c);
        }
        for (const c of wanted) {
            if (!this._classes.includes(c))
                this._actor.add_style_class_name(c);
        }
        this._classes = wanted;
    }

    clear(dead = false) {
        if (dead)
            this._classes = [];
        else
            this.set([]);
    }
}

class GlassHandle {
    constructor(entry, opts) {
        this._entry = entry;
        this._visible = true;
        this._presence = 1;
        this.layers = opts.layers ?? 'glass';
    }

    get presence() { return this._presence; }

    /** Fade the glass (0..1) without dropping its classes; multiplies across handles. */
    setPresence(p) {
        if (!this._entry || this._presence === p)
            return;
        this._presence = p;
        this._entry.syncPresence();
    }

    get visible() { return this._visible; }

    /** 'off' | 'glass' | 'solid' as currently resolved. */
    get tier() { return this._entry?.look?.tier ?? 'off'; }

    /** The resolved look (lib/glassParams.js resolve()) or null. Read-only. */
    get params() { return this._entry?.look ?? null; }

    /** Caller-side hide (overview, fullscreen). The glass shows only if every handle is visible. */
    setVisible(visible) {
        if (!this._entry || this._visible === visible)
            return;
        this._visible = visible;
        this._entry.sync();
    }

    /** Kept for callers: the look lives on the target itself, so geometry needs nothing. */
    setRect(_x, _y, _width, _height) {}

    /** Re-resolve now (call after something the isDark callback reads has changed). */
    refresh() {
        this._entry?.apply();
    }

    /** Kept for callers: nothing to repaint. */
    invalidate() {}

    destroy() {
        const entry = this._entry;
        this._entry = null;
        entry?.release(this);
    }
}

class GlassEntry {
    constructor(service, target, opts) {
        this._svc = service;
        this.target = target;
        this.surface = opts.surface;
        this.opts = opts;
        this.handles = new Set();
        this.look = null;
        this._dead = false;
        this._classes = new ClassSet(target);
        this._fill = new StyleFragment(target);
        this._radius = -1;  // corner radius copied to the host, -1 while unknown
        this._hostOn = false;
        this._destroyed = false;
        this._effect = null;

        this._ids = [[target, target.connect('destroy', () => {
            this._dead = true;  // never touch the disposed actor again
            this.destroy();
        })]];
        // The theme's text colour picks dark or light glass (known once styled: a menu on its
        // first open), and its corner radius is copied to the shadow host
        this._ids.push([target, target.connect('style-changed', () => this._onStyleChanged())]);

        const host = opts.shadow ?? null;
        this._host = host;
        if (host) {
            this._hostClasses = new ClassSet(host);
            this._hostStyle = new StyleFragment(host);
            this._hostDead = false;
            this._ids.push([host, host.connect('destroy', () => {
                this._hostDead = true;
                this._hostClasses.clear(true);
                this._hostStyle.clear(true);
            })]);
        }
    }

    get _glassy() {
        for (const h of this.handles) {
            if (h.layers === 'glass')
                return true;
        }
        return false;
    }

    _onStyleChanged() {
        if (this._dead || !this.look)
            return;
        if (!this.opts.isDark && this._svc.textIsLight(this.target) !== this.look.dark) {
            this.apply();
            return;
        }
        this._syncHostRadius();
        this._syncEffect();
    }

    release(handle) {
        this.handles.delete(handle);
        if (this.handles.size === 0)
            this.destroy();
        else
            this.apply();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._classes.clear(this._dead);
        this._fill.clear(this._dead);
        this._dropEffect();
        if (this._host && !this._hostDead) {
            this._hostClasses.clear();
            this._hostStyle.clear();
        }
        for (const [obj, id] of this._ids) {
            const gone = obj === this.target ? this._dead : this._hostDead;
            if (!gone)
                obj.disconnect(id);
        }
        this._ids = [];
        for (const h of this.handles)
            h._entry = null;
        this.handles.clear();
        this._svc.forget(this);
    }

    apply() {
        if (this._dead)
            return;
        this.look = this._svc.lookFor(this);
        this.sync();
    }

    sync() {
        if (this._dead || !this.look)
            return;
        let visible = true;
        for (const h of this.handles)
            visible &&= h.visible;
        const on = this._glassy && visible;
        const hosted = !!this._host && !this._hostDead;
        const drawn = on && this.look.tier !== 'off' && this._svc.effects;
        if (drawn && !this._effect) {
            const sigma = this.look.blur?.sigma ?? 0;
            this._effect = new GlassBlurEffect({
                mode: captureMode(this.surface), margin: captureMargin(this.surface, sigma),
            });
            this.target.add_effect(this._effect);
        } else if (!drawn) {
            this._dropEffect();
        }
        this._classes.set(on ? glassClasses(this.look, this.surface) : []);
        this._fill.set(on ? fillStyle(this.look, this.opts.radius, !!this._effect) : '');
        this._syncEffect();
        this.syncPresence();
        if (hosted) {
            this._hostClasses.set(on ? hostClasses(this.look) : []);
            this._hostOn = on && this.look.tier !== 'off';
            this._radius = -1;
            this._syncHostRadius();
        }
    }

    _radiusNow() {
        if (this.opts.radius !== undefined && this.opts.radius !== null)
            return this.opts.radius;
        const node = this.target.peek_theme_node?.();
        return node ? node.get_border_radius(St.Corner.TOPLEFT) : 0;
    }

    _syncEffect() {
        if (!this._effect || this._dead)
            return;
        this._effect.setLook(effectColors(this.look), this._radiusNow());
    }

    syncPresence() {
        if (!this._effect || this._dead)
            return;
        let p = 1;
        for (const h of this.handles)
            p *= h.presence;
        this._effect.setPresence(p);
    }

    invalidate() {
        this._effect?.invalidate();
    }

    purge() {
        this._effect?.purge();
    }

    _dropEffect() {
        const effect = this._effect;
        this._effect = null;
        if (!effect)
            return;
        effect.destroyResources();
        if (!this._dead)
            this.target.remove_effect(effect);
    }

    // The host draws the drop shadow of the surface's rounded rect: same corner radius
    _syncHostRadius() {
        if (!this._host || this._hostDead)
            return;
        if (!this._hostOn) {
            this._hostStyle.set('');
            return;
        }
        const node = this.target.peek_theme_node?.();
        if (!node)
            return;
        const radius = this.opts.radius ?? node.get_border_radius(St.Corner.TOPLEFT);
        if (radius === this._radius)
            return;
        this._radius = radius;
        this._hostStyle.set(hostStyle(radius));
    }
}

class GlassService {
    constructor() {
        this._entries = new Map();      // target -> Map(surface -> GlassEntry)
        this._listeners = new Set();
        this._reg = null;               // CleanupRegistry while running
        this._tintReg = null;           // the wallpaper sampler's, while tinting is wanted
        this._gs = null;
        this._warned = false;
        this._bgIds = [];               // [BackgroundManager, handler id]
        this._snap = null;
        this._env = { dark: true, highContrast: false, reducedMotion: false, wallpaper: null, blur: false };
        this._effectsOk = blurSupported();
    }

    /** The blur effect draws the fill (false: St fills only). */
    get effects() {
        return this._effectsOk;
    }

    /** A paint error turned the effect off: every surface goes back to St fills. */
    disableEffects() {
        if (!this._effectsOk)
            return;
        this._effectsOk = false;
        this._env.blur = false;
        this._refresh();
    }

    // ---- public API -----------------------------------------------------

    /** Hand the service the extension's Gio.Settings (extension.js); null on disable. */
    configure(gsettings) {
        this._gs = gsettings;
        // A paint error in an earlier session must not switch blur off for good
        if (gsettings)
            this._effectsOk = blurSupported();
    }

    /**
     * Should this surface be glass right now? Pass the raw Gio.Settings you already
     * hold (ctx.settings) when calling before the service is running.
     */
    wants(surface, gsettings = null) {
        // Settings passed in are read fresh: a caller's 'changed' handler can run before
        // the service has refreshed its own snapshot.
        if (gsettings)
            return wantsSurface(readSnapshot(gsettings), surface);
        const gs = this._settingsObject();
        if (!this._snap && !gs)
            return false;
        return wantsSurface(this._snap ?? readSnapshot(gs), surface);
    }

    /** False under reduced motion: do not animate glass in that case. */
    get motion() {
        return !this._env.reducedMotion;
    }

    /** Current settings snapshot. */
    get snapshot() {
        if (this._snap)
            return this._snap;
        const gs = this._settingsObject();
        return gs ? readSnapshot(gs) : this._offSnapshot();
    }

    /**
     * Call fn({snapshot, env}) now and after any change that can alter how glass
     * resolves (settings, colour scheme, high contrast, reduced motion, wallpaper).
     */
    watch(registry, fn) {
        if (!this._settingsObject()) {
            fn({ snapshot: this._offSnapshot(), env: this._publicEnv() });
            return;
        }
        this._start();
        this._listeners.add(fn);
        registry.add(() => {
            this._listeners.delete(fn);
            this._maybeStop();
        });
        fn({ snapshot: this._snap, env: this._publicEnv() });
    }

    /** @returns {GlassHandle} */
    attach(target, opts = {}) {
        const options = { surface: 'overlays', ...opts };
        if (!this._settingsObject())
            return new GlassHandle(null, options);   // inert: tier 'off', every call is a no-op
        this._start();
        let bySurface = this._entries.get(target);
        if (!bySurface) {
            bySurface = new Map();
            this._entries.set(target, bySurface);
        }
        let entry = bySurface.get(options.surface);
        if (!entry) {
            entry = new GlassEntry(this, target, options);
            bySurface.set(options.surface, entry);
        }
        const handle = new GlassHandle(entry, options);
        entry.handles.add(handle);
        entry.apply();
        return handle;
    }

    /**
     * Glass on a PopupMenu (panel menus, the clipboard popover, the app menus): the rounded
     * bubble is the menu box; the BoxPointer's bin, which has the same rect right behind it,
     * carries the drop shadow. The BoxPointer itself stays untouched (an -arrow-background-color
     * there draws a square backing).
     *
     * @param {object} menu a PopupMenu.PopupMenu (box, _boxPointer)
     * @param {object} [opts] as attach(); surface defaults to 'menus'
     */
    attachMenu(menu, opts = {}) {
        // js/ui/popupMenu.js PopupMenu: _boxPointer.bin holds this.box (Shell 48-51)
        const shadow = menu._boxPointer?.bin ?? null;
        return this.attach(menu.box, { surface: 'menus', role: 'content', shadow, ...opts });
    }

    // ---- internals used by entries ---------------------------------------

    lookFor(entry) {
        const dark = entry.opts.isDark ? !!entry.opts.isDark() : this.textIsLight(entry.target);
        return resolve(this._snap, { ...this._env, dark }, entry.surface, entry.opts.role);
    }

    /** Light text on this actor means dark glass behind it. Falls back to the shell scheme. */
    textIsLight(actor) {
        const node = actor.peek_theme_node?.();
        if (!node)
            return this._env.dark;
        const c = node.get_foreground_color();
        return (0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue) / 255 > 0.5;
    }

    forget(entry) {
        const bySurface = this._entries.get(entry.target);
        bySurface?.delete(entry.surface);
        if (bySurface?.size === 0)
            this._entries.delete(entry.target);
        this._maybeStop();
    }

    _forEach(fn) {
        for (const bySurface of [...this._entries.values()]) {
            for (const entry of [...bySurface.values()])
                fn(entry);
        }
    }

    _invalidateAll() {
        this._forEach(e => e.invalidate());
    }

    // (Re)connect to the Shell's per-monitor BackgroundManagers; the Shell rebuilds them on
    // every monitor change
    _watchBackgrounds() {
        this._unwatchBackgrounds();
        this._bgIds = (Main.layoutManager._bgManagers ?? [])
            .map(m => [m, m.connect('changed', () => this._invalidateAll())]);
    }

    _unwatchBackgrounds() {
        for (const [obj, id] of this._bgIds) {
            try {
                obj.disconnect(id);
            } catch { /* destroyed with its monitor */ }
        }
        this._bgIds = [];
    }

    _publicEnv() {
        return {
            ...this._env,
            contrast: contrastOn(this._snap, this._env),
            opaque: opaqueOn(this._snap, this._env),
        };
    }

    // ---- lifecycle ------------------------------------------------------

    // Settings come only from Glass.configure() (extension.js). Unconfigured: log once, act as off.
    _settingsObject() {
        if (!this._gs && !this._warned) {
            this._warned = true;
            console.warn('[Guava] Glass used before Glass.configure(); glass stays off');
        }
        return this._gs;
    }

    _offSnapshot() {
        return { ...readSnapshot(null), liquid: false, surfaces: [] };
    }

    _start() {
        if (this._reg)
            return;
        const reg = new CleanupRegistry();
        this._reg = reg;
        const gs = this._settingsObject();

        const ks = new GuavaSettings(gs);
        ks.attach(reg);
        ks.watch(Object.keys(SETTING_FIELDS), () => this._refresh());
        this._snap = readSnapshot(gs);

        const st = St.Settings.get();
        const syncSt = () => {
            // The Shell uses its dark stylesheet unless the scheme asks for light
            this._env.dark = st.colorScheme !== St.SystemColorScheme.PREFER_LIGHT;
            this._env.highContrast = !!st.highContrast;
        };
        syncSt();
        // The wallpaper cross-fades to the other picture with no background key changing
        reg.connect(st, 'notify::color-scheme', () => { syncSt(); this._refresh(); this._invalidateAll(); });
        reg.connect(st, 'notify::high-contrast', () => { syncSt(); this._refresh(); });

        this._env.blur = this._effectsOk;
        // What lies behind the static blurs (menu bar, dock) changes: wallpaper, monitors and
        // scale, the overview going in and out
        const invalidate = () => this._invalidateAll();
        const bg = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        reg.connect(bg, 'changed', invalidate);
        reg.connect(Main.layoutManager, 'monitors-changed', () => {
            invalidate();
            this._watchBackgrounds();
        });
        // An XML day/night background swaps its picture by the clock, and the Shell announces
        // every swap on the monitor's BackgroundManager
        this._watchBackgrounds();
        reg.add(() => this._unwatchBackgrounds());
        // After a resume the GPU may have dropped the cached blur textures
        reg.connect(global.stage, 'gl-video-memory-purged', () => this._forEach(e => e.purge()));
        reg.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', invalidate);
        for (const sig of ['showing', 'hiding', 'hidden'])
            reg.connect(Main.overview, sig, invalidate);
        reg.connect(global.stage, 'before-paint', (_stage, view) => setPaintedView(view));
        reg.connect(global.stage, 'after-paint', () => setPaintedView(null));
        reg.add(() => setPaintedView(null));
        setFailureHandler(() => this.disableEffects());
        reg.add(() => setFailureHandler(null));
        reg.timeout(10000, () => {
            governor.idle();
            return true;
        }, { name: 'glass load governor', repeat: true });

        let started = false;
        watchReducedMotion(reg, reduced => {
            this._env.reducedMotion = reduced;
            if (started)
                this._refresh();
        });
        started = true;
        reg.add(() => this._stopTint());
        this._syncTint();
    }

    // The wallpaper is sampled only while its colour can show: glass on, tint on, not opaque
    _syncTint() {
        const want = !!this._snap && this._snap.liquid && this._snap.wallpaperTint &&
            !opaqueOn(this._snap, this._env);
        if (want && !this._tintReg) {
            this._tintReg = new CleanupRegistry();
            new WallpaperTint().start(this._tintReg, color => {
                this._env.wallpaper = color;
                this._refresh();
            });
        } else if (!want) {
            this._stopTint();
        }
    }

    _stopTint() {
        const reg = this._tintReg;
        this._tintReg = null;
        reg?.dispose();
        this._env.wallpaper = null;
    }

    _maybeStop() {
        if (!this._reg || this._entries.size > 0 || this._listeners.size > 0)
            return;
        const reg = this._reg;
        this._reg = null;
        this._snap = null;
        reg.dispose();
    }

    _refresh() {
        if (!this._reg)
            return;
        this._snap = readSnapshot(this._settingsObject());
        this._syncTint();
        this._forEach(e => e.apply());
        const env = this._publicEnv();
        for (const fn of [...this._listeners]) {
            try {
                fn({ snapshot: this._snap, env: { ...env } });
            } catch (e) {
                console.error('[Guava] glass listener failed:', e);
            }
        }
    }
}

export const Glass = new GlassService();
