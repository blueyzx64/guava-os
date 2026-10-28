// SPDX-License-Identifier: GPL-3.0-or-later
// Colour filters (accessibility): greyscale, the three colour-blindness corrections and a
// colour tint on the whole screen, like macOS Accessibility > Display > Colour Filters.
//
// GNOME 50 has no colour-filter keys (org.gnome.desktop.a11y.* has none; the magnifier's
// colour effects only act on its zoom region), so Guava puts one shader effect on Main.uiGroup,
// the parent of the wallpaper, the windows and all the chrome. One effect means one offscreen
// picture and one attach at enable, when the group already has its size (an effect added to a
// 0x0 child makes Cogl assert on its viewport). With a partial redraw clip Clutter culls every
// descendant outside the damage while the effect clears its picture, so after a window
// animation the rest, the wallpaper above all, stayed empty. So the stage's paint-view handler
// widens each frame's clip to the whole view, which only enlarges frames that are drawn
// anyway: an idle desktop stays idle. The effect is a 3x3 colour matrix (model.js) given as
// nine float uniforms, so a change of type, intensity or hue costs a uniform update, not a
// recompile.
//
// Shell API: Main.uiGroup effects, global.stage paint-view; lib/compat.js
// createShaderEffect (48-51 shader APIs).

import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GuavaSettings } from '../../lib/settings.js';
import { createShaderEffect, floatUniform } from '../../lib/compat.js';
import { filterMatrix } from './model.js';

const EFFECT_NAME = 'guava-color-filter';
const KEYS = ['color-filter-kind', 'color-filter-intensity', 'color-filter-hue'];
const UNIFORMS = ['m00', 'm01', 'm02', 'm10', 'm11', 'm12', 'm20', 'm21', 'm22'].map(n => `guava_${n}`);

// The texture is premultiplied, so the (linear) matrix acts on it as it is; alpha stays.
const DECLARATIONS = UNIFORMS.map(u => `uniform float ${u};`).join('\n');
const EFFECT_FN = `
vec4 guava_effect(vec2 uv, vec4 color) {
    mat3 m = mat3(guava_m00, guava_m10, guava_m20,
                  guava_m01, guava_m11, guava_m21,
                  guava_m02, guava_m12, guava_m22);
    return vec4(clamp(m * color.rgb, 0.0, color.a), color.a);
}`;

export class ColorFilters {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._effect = null;
        this._values = null;         // the nine uniform values now in force
    }

    enable() {
        const effect = createShaderEffect({ declarations: DECLARATIONS, effectFn: EFFECT_FN });
        if (!effect)
            return;
        this._effect = effect;
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(this._cleanup);
        const sync = () => {
            const m = filterMatrix({
                kind: ks.string('color-filter-kind'),
                intensity: ks.int('color-filter-intensity'),
                hue: ks.int('color-filter-hue'),
            });
            this._values = m.flat();
            this._setUniforms(effect);
            effect.queue_repaint();
        };
        sync();
        ks.watch(KEYS, sync);
        const group = Main.uiGroup;
        group.add_effect_with_name(EFFECT_NAME, effect);
        // Widen each frame's redraw clip to the whole view, before it is painted
        this._cleanup.connect(global.stage, 'paint-view', (_stage, _view, clip) => {
            const { width, height } = global.stage;
            clip.union(Mtk.Region.create_rectangle(
                new Mtk.Rectangle({ x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height) })));
        });
        this._cleanup.add(() => {
            group.remove_effect(effect);
            this._effect = null;
        });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    _setUniforms(effect) {
        this._values.forEach((v, i) => effect.set_uniform_value(UNIFORMS[i], floatUniform(v)));
    }
}
