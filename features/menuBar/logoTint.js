// SPDX-License-Identifier: GPL-3.0-or-later
// Recolours the system's own logo (the Fedora logo icon: a blue drop with a white "f") to the
// bar's text colour, as a mask: the drop takes the text colour and the "f" is cut out of it,
// the way macOS draws a template image. The icon is drawn by the icon theme at the screen's
// scale, so it stays crisp on HiDPI; this only changes its colours.
//
// A shader effect on the St.Icon (lib/compat.js createShaderEffect, 48-51 shader APIs). The
// "f" is told from the drop by its red channel (white 1.0, drop blue about 0.3). The texture is
// premultiplied, so the colour is multiplied by the new alpha.

import { createShaderEffect, floatUniform } from '../../lib/compat.js';

const EFFECT_NAME = 'guava-logo-tint';
const CHANNELS = ['guava_r', 'guava_g', 'guava_b'];

const DECLARATIONS = CHANNELS.map(c => `uniform float ${c};`).join('\n');
const EFFECT_FN = `
vec4 guava_effect(vec2 uv, vec4 color) {
    float red = color.a > 0.001 ? color.r / color.a : 0.0;
    float a = color.a * (1.0 - smoothstep(0.5, 0.9, red));
    return vec4(vec3(guava_r, guava_g, guava_b) * a, a);
}`;

/**
 * Tint `icon` with its own text colour for as long as `cleanup` lives.
 *
 * @param {St.Icon} icon
 * @param {CleanupRegistry} cleanup
 * @returns {boolean} false when the shader is unavailable (the icon then keeps its colours)
 */
export function tintWithText(icon, cleanup) {
    const effect = createShaderEffect({ declarations: DECLARATIONS, effectFn: EFFECT_FN });
    if (!effect)
        return false;
    const sync = () => {
        // Before the button is in the stage there is no theme node yet: 'style-changed' comes
        // once it is added
        if (!icon.get_stage())
            return;
        const c = icon.get_theme_node().get_foreground_color();
        [c.red, c.green, c.blue].forEach((v, i) => effect.set_uniform_value(CHANNELS[i], floatUniform(v / 255)));
        effect.queue_repaint();
    };
    icon.add_effect_with_name(EFFECT_NAME, effect);
    cleanup.connect(icon, 'style-changed', sync);
    // The effect goes with the icon when the button is destroyed first
    let gone = false;
    cleanup.connect(icon, 'destroy', () => (gone = true));
    cleanup.add(() => {
        if (!gone)
            icon.remove_effect(effect);
    });
    sync();
    return true;
}
