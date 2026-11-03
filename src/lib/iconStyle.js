// SPDX-License-Identifier: GPL-3.0-or-later
// IconStyle: the Tahoe icon styles (Default, Dark, Clear, Tinted) on Guava-drawn app icons.
//
//   import { IconStyle } from '../../lib/iconStyle.js';
//   const handle = IconStyle.apply(icon);     // dock tile, Spotlight row, switcher, Launchpad
//   cleanup.add(() => handle.destroy());      // or let the icon be destroyed: it untracks itself
//
// extension.js configures it with Guava's settings (`appearance-icon-style`) and resets it on
// disable, which takes every effect off again. The look comes from lib/iconStyleModel.js; the
// effects are stock Clutter ones (no shaders), added once per icon and changed only when the
// style, the colour scheme or the accent changes. An offscreen effect keeps its texture until
// the icon itself redraws, so there is no per-frame cost.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import St from 'gi://St';

import { GNOME_ACCENTS, effectPlan } from './iconStyleModel.js';

const LOG = '[Guava]';
const KEY = 'appearance-icon-style';
const EFFECT_PREFIX = 'guava-icon-style-';
const MAX_EFFECTS = 2;

function _tintColor(rgb) {
    return new Cogl.Color({ red: rgb[0], green: rgb[1], blue: rgb[2], alpha: 255 });
}

function _makeEffect(spec) {
    switch (spec.kind) {
    case 'desaturate':
        return new Clutter.DesaturateEffect({ factor: spec.factor });
    case 'brightness': {
        const e = new Clutter.BrightnessContrastEffect();
        e.set_brightness(spec.brightness);
        e.set_contrast(spec.contrast);
        return e;
    }
    case 'colorize':
        return new Clutter.ColorizeEffect({ tint: _tintColor(spec.tint) });
    default:
        return null;
    }
}

class IconStyleHandle {
    constructor(service, actor) {
        this._service = service;
        this.actor = actor;
    }

    destroy() {
        this._service._untrack(this.actor);
        this._service = null;
    }
}

class IconStyleService {
    constructor() {
        this._settings = null;
        this._signals = [];
        this._actors = new Map();    // actor -> {destroyId, key, opacity}
        this._plan = effectPlan('default');
    }

    /** extension.js: Guava's Gio.Settings on enable, null on disable (removes every effect). */
    configure(settings) {
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._settings = settings;
        if (settings) {
            const theme = St.ThemeContext.get_for_stage(global.stage);
            this._signals.push([settings, settings.connect(`changed::${KEY}`, () => this._refresh())]);
            this._signals.push([St.Settings.get(), St.Settings.get().connect('notify::color-scheme', () => this._refresh())]);
            // The theme context re-reads the accent colour and emits 'changed' after it
            this._signals.push([theme, theme.connect('changed', () => this._refresh())]);
        }
        this._refresh();
        if (!settings) {
            for (const actor of [...this._actors.keys()])
                this._untrack(actor);
        }
    }

    /** The current style name (for features that pick a plate or a glyph colour). */
    get style() {
        return this._plan.style;
    }

    /**
     * Style an app icon (any actor that paints one) and keep it styled until the handle is
     * destroyed or the actor is.
     *
     * @param {Clutter.Actor} actor
     * @returns {IconStyleHandle}
     */
    apply(actor) {
        if (!this._actors.has(actor)) {
            const destroyId = actor.connect('destroy', () => this._actors.delete(actor));
            this._actors.set(actor, { destroyId, key: null, opacity: actor.opacity });
        }
        this._paint(actor);
        return new IconStyleHandle(this, actor);
    }

    _env() {
        const dark = St.Settings.get().color_scheme !== St.SystemColorScheme.PREFER_LIGHT;
        let tint = GNOME_ACCENTS.blue;
        try {
            // GNOME 47+: [accent, foreground] as Cogl colours
            const [accent] = St.ThemeContext.get_for_stage(global.stage).get_accent_color();
            tint = [accent.red, accent.green, accent.blue];
        } catch (e) {
            console.debug(`${LOG} icon style: no accent colour from the theme: ${e.message}`);
        }
        return { dark, tint };
    }

    _refresh() {
        const style = this._settings?.get_string(KEY) ?? 'default';
        this._plan = effectPlan(style, this._env());
        for (const actor of this._actors.keys())
            this._paint(actor);
    }

    _paint(actor) {
        const rec = this._actors.get(actor);
        const plan = this._plan;
        if (!rec || rec.key === plan.key)
            return;
        rec.key = plan.key;
        for (let i = 0; i < MAX_EFFECTS; i++)
            actor.remove_effect_by_name(`${EFFECT_PREFIX}${i}`);
        plan.effects.forEach((spec, i) => {
            const effect = _makeEffect(spec);
            if (effect)
                actor.add_effect_with_name(`${EFFECT_PREFIX}${i}`, effect);
        });
        actor.opacity = plan.opacity === 255 ? rec.opacity : Math.round(rec.opacity * plan.opacity / 255);
    }

    _untrack(actor) {
        const rec = this._actors.get(actor);
        if (!rec)
            return;
        this._actors.delete(actor);
        actor.disconnect(rec.destroyId);
        for (let i = 0; i < MAX_EFFECTS; i++)
            actor.remove_effect_by_name(`${EFFECT_PREFIX}${i}`);
        actor.opacity = rec.opacity;
    }
}

export const IconStyle = new IconStyleService();
