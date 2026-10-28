// SPDX-License-Identifier: GPL-3.0-or-later
// Colour filters (macOS Accessibility > Display > Colour Filters) as one 3x3 colour matrix
// applied to every pixel. Pure (no gi imports).
//
// Colour-blindness filters are corrections (daltonisation, Fidaner et al.): the colours a
// person with the deficiency cannot tell apart are shifted into ones they can,
//   M = I + E (I - S),  S = LMS->RGB . Sim . RGB->LMS
// Greyscale uses Rec. 709 luma; the tint maps that luma onto one colour.

export const FILTER_KINDS = Object.freeze(['greyscale', 'protanopia', 'deuteranopia', 'tritanopia', 'tint']);

const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const LUMA = [0.2126, 0.7152, 0.0722];

const RGB_TO_LMS = [
    [17.8824, 43.5161, 4.11935],
    [3.45565, 27.1554, 3.86714],
    [0.0299566, 0.184309, 1.46709],
];
const LMS_TO_RGB = [
    [0.0809444479, -0.130504409, 0.116721066],
    [-0.0102485335, 0.0540193266, -0.113614708],
    [-0.000365296938, -0.00412161469, 0.693511405],
];
const SIMULATE = {
    protanopia: [[0, 2.02344, -2.52581], [0, 1, 0], [0, 0, 1]],
    deuteranopia: [[1, 0, 0], [0.494207, 0, 1.24827], [0, 0, 1]],
    tritanopia: [[1, 0, 0], [0, 1, 0], [-0.395913, 0.801109, 0]],
};
// Where the lost information goes: into the channels the viewer still sees
const SHIFT = [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]];

export function multiply(a, b) {
    return a.map((row, i) => row.map((_v, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
}

const add = (a, b) => a.map((row, i) => row.map((v, j) => v + b[i][j]));
const scale = (a, k) => a.map(row => row.map(v => v * k));
const lerp = (a, b, t) => add(scale(a, 1 - t), scale(b, t));

/** The colour of a hue (degrees) at the tint's saturation, as linear-ish 0..1 RGB. */
export function hueColor(hue, saturation = 0.6) {
    const h = (((hue % 360) + 360) % 360) / 60;
    const x = 1 - Math.abs((h % 2) - 1);
    const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
        : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
    return [r, g, b].map(c => 1 - saturation * (1 - c));
}

function fullMatrix(kind, hue) {
    switch (kind) {
    case 'greyscale':
        return [LUMA, LUMA, LUMA];
    case 'tint':
        return hueColor(hue).map(c => LUMA.map(l => c * l));
    case 'protanopia':
    case 'deuteranopia':
    case 'tritanopia': {
        const sim = multiply(multiply(LMS_TO_RGB, SIMULATE[kind]), RGB_TO_LMS);
        return add(I, multiply(SHIFT, add(I, scale(sim, -1))));
    }
    default:
        return I;
    }
}

/**
 * The colour matrix (rows; out = M . rgb) of a filter.
 *
 * @param {{kind: string, intensity: number, hue: number}} config intensity 0..100, hue degrees
 * @returns {number[][]}
 */
export function filterMatrix({ kind, intensity, hue }) {
    const t = Math.max(0, Math.min(100, intensity)) / 100;
    return lerp(I, fullMatrix(kind, hue), t);
}

/** True when the matrix changes nothing (no effect needed). */
export function isIdentity(m, eps = 1e-6) {
    return m.every((row, i) => row.every((v, j) => Math.abs(v - I[i][j]) < eps));
}
