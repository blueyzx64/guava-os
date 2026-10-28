// SPDX-License-Identifier: GPL-3.0-or-later
// The one place that knows what differs between GNOME Shell 50 and 51 (50 is the supported
// release; 51 paths are ready for the next one). Feature code asks this module; it never
// compares versions itself.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { pickReducedMotionSource, readReducedMotion, reducedMotionSignal, xidFromDescription } from './compatModel.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

export { DesktopAppInfo } from './gioCompat.js';

/** Major shell version, e.g. 49. */
export const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);

/** @param {number} major true when the running shell is `major` or newer */
export function atLeast(major) {
    return SHELL_MAJOR >= major;
}

export function maximizeWindow(win) {
    win.maximize();
}

export function unmaximizeWindow(win) {
    win.unmaximize();
}

/**
 * The X11 window id of an Xwayland (or X11) window, null for Wayland clients.
 *
 * @param {Meta.Window} win
 * @returns {?number}
 */
export function x11WindowId(win) {
    if (win.get_client_type() !== Meta.WindowClientType.X11)
        return null;
    if (typeof win.get_xwindow === 'function')
        return win.get_xwindow();
    return xidFromDescription(win.get_description());
}

/** True when the window is maximized both ways (callers watch notify::maximized-*). */
export function isMaximized(win) {
    return !!win?.is_maximized();
}

/**
 * Argument for PopupMenu.close(). 51 replaced the PopupAnimation bitmask with a params
 * object; `true` is the 50 spelling of "animate". 51 gets the closest equivalent.
 */
export const MENU_CLOSE_ARGS = atLeast(51) ? { animate: true } : true;

const A11Y_SCHEMA = 'org.gnome.desktop.a11y.interface';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

function _schemaHasKey(schemaId, key) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    return !!schema?.has_key(key);
}

// The object that carries the preference on this shell, and how to read it
function _reducedMotionSource() {
    const st = St.Settings.get();
    const kind = pickReducedMotionSource({
        st: 'reduced_motion' in st && !!St.ReducedMotion,
        a11y: _schemaHasKey(A11Y_SCHEMA, 'reduced-motion'),
        iface: _schemaHasKey(INTERFACE_SCHEMA, 'enable-animations'),
    });
    if (kind === 'st')
        return { kind, obj: st };
    if (kind === 'a11y')
        return { kind, obj: new Gio.Settings({ schema_id: A11Y_SCHEMA }) };
    if (kind === 'iface')
        return { kind, obj: new Gio.Settings({ schema_id: INTERFACE_SCHEMA }) };
    return null;
}

function _read(source) {
    return readReducedMotion(source.kind, source.obj, St.ReducedMotion?.REDUCE);
}

/**
 * Read the user's "reduce motion" preference once.
 * 51: St.Settings reduced-motion. 50: org.gnome.desktop.a11y.interface reduced-motion
 * (an enum, 'reduce' means on). Else org.gnome.desktop.interface enable-animations,
 * inverted. False when none exists. To follow changes use watchReducedMotion().
 *
 * @returns {boolean}
 */
export function reducedMotion() {
    const source = _reducedMotionSource();
    return source ? _read(source) : false;
}

/**
 * Call fn(reduced:boolean) now and whenever the preference changes. The source object is
 * built once here and its connection is torn down by `registry.dispose()`.
 *
 * @param {CleanupRegistry} registry
 * @param {Function} fn
 */
export function watchReducedMotion(registry, fn) {
    const source = _reducedMotionSource();
    if (!source) {
        fn(false);
        return;
    }
    registry.connect(source.obj, reducedMotionSignal(source.kind), () => fn(_read(source)));
    fn(_read(source));
}

/**
 * Which custom-shader API this Shell has. 48-50 replace the whole fragment program
 * (Clutter.ShaderEffect.set_shader_source, Shell.GLSLEffect also exists); 51 removed
 * Shell.GLSLEffect and set_shader_source in favour of Cogl snippets. Feature code
 * never looks at this: it calls createShaderEffect().
 */
export const SHADER_API = typeof Clutter.ShaderEffect.prototype.set_shader_source === 'function'
    ? 'program' : 'snippet';

const ProgramEffect = GObject.registerClass(
class GuavaProgramShaderEffect extends Clutter.ShaderEffect {
    constructor(source) {
        super();
        this.set_shader_source(source);
    }

    // The effect changes every pixel the actor paints, so it has no paint volume to hand out:
    // Clutter then redraws the whole actor on any damage. With a volume it repaints only the
    // damaged part into the cached offscreen picture and the rest of that picture stays empty.
    vfunc_modify_paint_volume() {
        return false;
    }
});

/**
 * Build a ShaderEffect that post-processes the actor's own texture.
 *
 * `declarations` holds uniforms and helpers. `effectFn` must define
 * `vec4 guava_effect(vec2 uv, vec4 color)` (uv is 0..1 over the actor, color is the
 * actor's texel at uv) and may call `guava_sample(vec2 uv)` to read the texture elsewhere. Set uniforms afterwards with
 * effect.set_uniform_value(name, floatValue) (pass non-integral doubles: an integral JS
 * number becomes an int uniform).
 *
 * @param {{declarations: string, effectFn: string}} src
 * @returns {Clutter.ShaderEffect|null} null when the shader could not be created
 */
export function createShaderEffect({ declarations, effectFn }) {
    try {
        if (SHADER_API === 'program') {
            return new ProgramEffect(`
                uniform sampler2D tex;
                ${declarations}
                vec4 guava_sample(vec2 uv) { return texture2D(tex, uv); }
                ${effectFn}
                void main() { vec2 uv = cogl_tex_coord_in[0].xy; cogl_color_out = guava_effect(uv, texture2D(tex, uv)); }
            `);
        }
        // Snippet declarations are emitted at file scope before the hook, where the
        // layer-0 sampler cogl_sampler0 is already declared.
        return Clutter.ShaderEffect.new_with_snippet(Cogl.Snippet.new(
            Cogl.SnippetHook.FRAGMENT,
            `${declarations}
             vec4 guava_sample(vec2 uv) { return texture2D(cogl_sampler0, uv); }
             ${effectFn}`,
            `cogl_color_out = guava_effect(cogl_tex_coord_in[0].xy, cogl_color_out);`));
    } catch (e) {
        console.error('[Guava] shader effect unavailable:', e);
        return null;
    }
}

/** A float uniform value for effect.set_uniform_value (a plain JS number would become an int). */
export function floatUniform(v) {
    const value = new GObject.Value();
    value.init(GObject.TYPE_FLOAT);
    value.set_float(v);
    return value;
}

/**
 * Shell.GLSLEffect (an OffscreenEffect whose pipeline takes Cogl snippets and per-instance
 * uniforms) on 48-50; null on 51, which removed it. Subclass it lazily, never at import.
 * Its pipeline blends with "SRC_COLOR * SRC_COLOR[A]", so a snippet must leave
 * cogl_color_out un-premultiplied.
 */
export const GLSL_EFFECT = Shell.GLSLEffect ?? null;

/**
 * Hold direct scanout (unredirect) off while Shell UI is drawn over a fullscreen window, or
 * release it. Calls must be paired by the caller. A no-op where the compositor has no such
 * call (X11 support went away in 50, and the API may follow).
 *
 * @param {boolean} allowed true = the compositor may unredirect again
 */
export function setUnredirectAllowed(allowed) {
    const compositor = global.compositor;
    const fn = allowed ? compositor?.enable_unredirect : compositor?.disable_unredirect;
    if (typeof fn === 'function')
        fn.call(compositor);
}

// --- notifications and OSD ---------------------------------------------------------------
// Checked against messageTray.js and osdWindow.js at 48.0, 49.0, 50.0 and main.
// MessageTray: `_showNotification()` (called from `_updateState()` once the stock filters for
// acknowledged, urgency, DND, busy and fullscreen have run), `_notificationQueue` and the
// 'queue-changed' signal are the same in all four. The class changed from registerClass() to
// a native class in 50, so patch MessageTray.prototype, never an instance.
// OSD: the public show() changed in 49 (show(monitor, icon, label, level, max) became
// show(icon, label, levels), plus showOne/showAll), but every path ends in
// `_showOsdWindow(monitorIndex, icon, label, level, maxLevel)`, unchanged since 48.

/**
 * Take the head of the banner queue, as MessageTray._showNotification() does.
 * @param {object} tray Main.messageTray
 * @returns {object|undefined} the Notification
 */
export function takeQueuedBanner(tray) {
    const notification = tray._notificationQueue?.shift();
    tray.emit('queue-changed');
    return notification;
}

/** Ask the tray to look at its queue again (shows or diverts the next banner). */
export function kickTray(tray) {
    if (typeof tray._updateState === 'function')
        tray._updateState();
}

/** @returns {boolean} the running Shell has the hooks the banner and OSD diversion need */
export function canDivertBanners(tray) {
    return Array.isArray(tray?._notificationQueue) && typeof tray._showNotification === 'function';
}

/** @returns {boolean} */
export function canDivertOsd(osdWindowManager) {
    return typeof osdWindowManager?._showOsdWindow === 'function';
}

/**
 * Put a notification back at the head of the banner queue so the stock banner shows it.
 * Used when a sink goes away while still holding a card. No-op for destroyed notifications.
 *
 * @param {object} tray Main.messageTray
 * @param {object} notification
 */
export function requeueBanner(tray, notification) {
    if (!Array.isArray(tray?._notificationQueue) || notification._destroyed)
        return;
    if (!tray._notificationQueue.includes(notification)) {
        tray._notificationQueue.unshift(notification);
        tray.emit('queue-changed');
    }
    // The tray drops acknowledged notifications from its queue
    notification.acknowledged = false;
}
