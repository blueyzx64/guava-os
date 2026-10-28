// SPDX-License-Identifier: GPL-3.0-or-later
// Pure look and motion rules for ModalSurface (no gi imports, unit-tested).
// The frame is its own backing: a rounded, translucent St CSS fill with a 1px rim and a soft
// shadow (stylesheet.css, .guava-modal*). No blur actor sits behind it.

export const SHOW_MS = 180;
export const HIDE_MS = 120;
export const FROM_SCALE = 0.96;

/**
 * Style classes for the frame.
 *
 * @param {{dark: boolean, highContrast?: boolean}} env
 * @returns {string[]}
 */
export function frameClasses({ dark, highContrast = false }) {
    const classes = ['guava-modal', dark ? 'guava-modal-dark' : 'guava-modal-light'];
    if (highContrast)
        classes.push('guava-modal-opaque');
    return classes;
}

/**
 * How the frame opens or closes. Reduced motion keeps only the fade (no scale); animations
 * off makes it instant.
 *
 * @param {'show'|'hide'} phase
 * @param {{reducedMotion?: boolean, animations?: boolean}} env
 * @returns {{duration: number, scaleFrom: number, scaleTo: number, opacityFrom: number, opacityTo: number}}
 */
export function motionFor(phase, { reducedMotion = false, animations = true } = {}) {
    const show = phase === 'show';
    const scaled = show ? [FROM_SCALE, 1] : [1, FROM_SCALE];
    const [scaleFrom, scaleTo] = reducedMotion ? [1, 1] : scaled;
    return {
        duration: animations ? (show ? SHOW_MS : HIDE_MS) : 0,
        scaleFrom, scaleTo,
        opacityFrom: show ? 0 : 255,
        opacityTo: show ? 255 : 0,
    };
}
