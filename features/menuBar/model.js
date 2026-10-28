// SPDX-License-Identifier: GPL-3.0-or-later
// Pure logic of the menu bar: the adaptive look (wallpaper luminance, solid or clear), the
// About This PC facts, Recent Items, Force Quit rows and the privacy dots. No Shell objects:
// the adapters in this folder pass plain values in.

// ---- adaptive look ---------------------------------------------------------------------------

// Black text beats white text on a background brighter than this (equal contrast point)
export const TEXT_FLIP_LUMINANCE = 0.179;
// How far past the flip point the band must move before the text flips back (hysteresis)
export const TEXT_FLIP_HYSTERESIS = 0.04;
// A band whose luminance spread is wider than this is "mixed": a soft scrim is drawn
export const MIXED_SPREAD = 0.35;

// Text on the wallpaper must reach this contrast ratio (WCAG large-text AA) on the worst part of
// the band, or the bar falls back to its solid look. Below SCRIM_CONTRAST a scrim helps.
export const SAFE_CONTRAST = 3;
export const SCRIM_CONTRAST = 4.5;
// The other text colour must beat the previous one by this factor before the text flips
// (hysteresis, so wallpapers of similar brightness do not flicker)
export const TEXT_FLIP_FACTOR = 1.2;

/** WCAG contrast of white text (luminance 1) over a background of luminance `lum`. */
export const contrastOfLight = lum => 1.05 / (lum + 0.05);
/** WCAG contrast of black text over a background of luminance `lum`. */
export const contrastOfDark = lum => (lum + 0.05) / 0.05;

/**
 * Dark or light text over the band. Each colour is judged on the worst part of the band (the
 * darkest tenth for dark text, the brightest tenth for light text), so a half-black, half-white
 * wallpaper cannot leave grey text on a dark patch. When neither is readable the bar is solid.
 *
 * @param {{mean: number, spread: number, low?: number, high?: number}} stats low and high are
 *   the 10th and 90th percentile luminance (default: the mean)
 * @param {?boolean} previousDark the last choice (null: none yet)
 * @returns {{darkText: boolean, scrim: boolean, solid: boolean}}
 */
export function chooseText(stats, previousDark = null) {
    const dark = contrastOfDark(stats.low ?? stats.mean);
    const light = contrastOfLight(stats.high ?? stats.mean);
    let darkText = dark > light;
    if (previousDark === true && light < dark * TEXT_FLIP_FACTOR)
        darkText = true;
    else if (previousDark === false && dark < light * TEXT_FLIP_FACTOR)
        darkText = false;
    const best = darkText ? dark : light;
    return {
        darkText,
        scrim: best < SCRIM_CONTRAST || stats.spread > MIXED_SPREAD,
        solid: best < SAFE_CONTRAST,
    };
}

/**
 * Does a window touch the menu bar (macOS: the bar turns solid)?
 *
 * @param {{y: number, x: number, width: number}} frame the window's frame rect
 * @param {{x: number, y: number, width: number}} area the work area of its monitor (its top
 *   is the bottom of the menu bar)
 * @returns {boolean}
 */
export function touchesBar(frame, area) {
    const overlapsX = frame.x < area.x + area.width && frame.x + frame.width > area.x;
    return overlapsX && frame.y <= area.y;
}

/**
 * The menu bar's look.
 *
 * @param {object} s
 * @param {boolean} s.transparent the "transparent menu bar" setting
 * @param {boolean} s.windowAtTop a window touches the bar or is maximized
 * @param {boolean} s.solidOnWindow the "solid when a window touches the bar" setting
 * @param {boolean} s.solidOnly high contrast or reduced transparency
 * @returns {'clear'|'solid'}
 */
export function barLook({ transparent, windowAtTop, solidOnWindow, solidOnly }) {
    if (!transparent || solidOnly || (solidOnWindow && windowAtTop))
        return 'solid';
    return 'clear';
}

/**
 * The box pointer's source alignment that puts the menu's leading edge on the clicked item's
 * leading edge. The pointer reads the item's content box straight from its allocation, so the
 * box starts where the item sits in its parent plus its padding: both are taken back here
 * with an alignment outside 0..1 (a stock quirk that shifts every bar menu by a few pixels).
 *
 * @param {object} s
 * @param {boolean} s.rtl right-to-left text direction
 * @param {number} s.width the item's width
 * @param {number} s.contentStart where the content box starts, as the pointer reads it
 * @param {number} s.contentWidth width of the content box
 * @returns {number}
 */
export function leadingAlignment({ rtl, width, contentStart, contentWidth }) {
    if (contentWidth <= 0)
        return rtl ? 1 : 0;
    return ((rtl ? width : 0) - contentStart) / contentWidth;
}

// ---- About This PC ---------------------------------------------------------------------------

/** os-release text -> {NAME, VERSION, PRETTY_NAME, LOGO, ...} */
export function parseOsRelease(text) {
    const out = {};
    for (const line of (text ?? '').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (!m)
            continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
            v = v.slice(1, -1);
        out[m[1]] = v.replace(/\\(["'\\$`])/g, '$1');
    }
    return out;
}

/** /proc/cpuinfo -> {model, threads} */
export function parseCpuInfo(text) {
    let model = null;
    let threads = 0;
    for (const line of (text ?? '').split('\n')) {
        const [k, ...rest] = line.split(':');
        const key = k?.trim();
        const value = rest.join(':').trim();
        if (key === 'processor')
            threads++;
        else if (!model && (key === 'model name' || key === 'Hardware' || key === 'cpu model' || key === 'Model'))
            model = value;
    }
    return { model: model ? model.replace(/\s+/g, ' ').replace(/\((R|TM)\)/g, '') : null, threads };
}

/** /proc/meminfo -> total bytes (or 0) */
export function parseMemTotal(text) {
    const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(text ?? '');
    return m ? Number(m[1]) * 1024 : 0;
}

const MEMORY_SIZES_GB = [1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 36, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

/**
 * Bytes as macOS writes them (decimal units): '512 GB', '1.5 TB'.
 * Memory is shown as the installed size ("16 GB"): MemTotal is a little less than that (the
 * kernel and the graphics chip keep some), so it rounds up to the next standard module size.
 *
 * @param {number} bytes
 * @param {{memory?: boolean}} [opts]
 */
export function formatBytes(bytes, { memory = false } = {}) {
    if (!(bytes > 0))
        return '';
    if (memory) {
        const gib = bytes / 1024 ** 3;
        if (gib < 1)
            return `${Math.round(gib * 1024) / 1024} GB`;
        const size = MEMORY_SIZES_GB.find(n => n >= gib - 0.05);
        return `${size ?? Math.round(gib)} GB`;
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    const s = v >= 100 || i === 0 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
    return `${s} ${units[i]}`;
}

/**
 * The model line: "Vendor Model", without repeating the vendor and without filler DMI strings.
 *
 * @param {?string} vendor
 * @param {?string} model
 * @returns {?string}
 */
export function deviceModel(vendor, model) {
    const junk = /^(to be filled by o\.e\.m\.|system product name|default string|none|unknown|o\.e\.m\.|not specified)$/i;
    const v = vendor && !junk.test(vendor.trim()) ? vendor.trim() : '';
    const m = model && !junk.test(model.trim()) ? model.trim() : '';
    if (!m)
        return v || null;
    return v && !m.toLowerCase().startsWith(v.toLowerCase()) ? `${v} ${m}` : m;
}

/** Chassis (hostname1) -> a symbolic icon name. */
export function chassisIcon(chassis) {
    switch (chassis) {
    case 'laptop':
    case 'convertible':
        return 'computer-laptop-symbolic';
    case 'tablet':
        return 'tablet-symbolic';
    case 'handset':
        return 'phone-symbolic';
    default:
        return 'computer-symbolic';
    }
}

/**
 * Switcheroo GPUs (aa{sv}, unpacked) -> names, the default one first.
 *
 * @param {{Name?: string, Default?: boolean}[]} gpus
 * @returns {string[]}
 */
export function gpuNames(gpus) {
    return [...(gpus ?? [])]
        .filter(g => g?.Name)
        .sort((a, b) => Number(!!b.Default) - Number(!!a.Default))
        .map(g => g.Name);
}

// ---- Recent Items ----------------------------------------------------------------------------

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * The most recent documents of a recently-used.xbel file.
 *
 * @param {string} xml
 * @param {number} [limit]
 * @returns {{uri: string, name: string, time: number, mime: ?string}[]} newest first
 */
export function parseRecentXbel(xml, limit = 10) {
    const out = [];
    const re = /<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/g;
    let m;
    while ((m = re.exec(xml ?? ''))) {
        const attrs = m[1];
        const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
        if (!href)
            continue;
        const stamp = /\bvisited="([^"]*)"/.exec(attrs)?.[1] ?? /\bmodified="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const time = Date.parse(stamp) || 0;
        const mime = /<mime:mime-type\s+type="([^"]*)"/.exec(m[2])?.[1] ?? null;
        const uri = decodeXml(href);
        let name = uri.replace(/\/+$/, '').split('/').pop() ?? uri;
        try {
            name = decodeURIComponent(name);
        } catch (_e) {
            // keep the raw name
        }
        out.push({ uri, name, time, mime });
    }
    out.sort((a, b) => b.time - a.time);
    const seen = new Set();
    return out.filter(r => !seen.has(r.uri) && seen.add(r.uri)).slice(0, limit);
}

// ---- Force Quit ------------------------------------------------------------------------------

/**
 * Rows of the Force Quit dialog: apps with windows, by name, the unresponsive ones flagged.
 *
 * @param {{id: string, name: string, windows: {alive: boolean}[]}[]} apps
 * @returns {{id: string, name: string, notResponding: boolean}[]}
 */
export function forceQuitRows(apps) {
    return apps
        .filter(a => a.windows.length > 0)
        .map(a => ({ id: a.id, name: a.name, notResponding: a.windows.some(w => !w.alive) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Does the pending Force Quit confirmation still name the selected app? The question names one
 * app; any other selection (click, Up or Down) must ask again instead of killing it unnamed.
 *
 * @param {?string} confirmedId the app the question named (null: no question is showing)
 * @param {?string} selectedId the selected row
 * @returns {boolean}
 */
export function confirmationHolds(confirmedId, selectedId) {
    return confirmedId !== null && confirmedId === selectedId;
}

// ---- text ------------------------------------------------------------------------------------

/**
 * Fill the %s placeholders of a translated string in order. String.replace with a string
 * replacement reads `$&` and `$$` in an app or user name as patterns; this does not.
 *
 * @param {string} template
 * @param {...string} values
 * @returns {string}
 */
export function fillPlaceholders(template, ...values) {
    let i = 0;
    return String(template).replace(/%s/g, m => (i < values.length ? String(values[i++]) : m));
}

// ---- menu strip layout -------------------------------------------------------------------------

/**
 * Which menus of the strip fit, as macOS does on a narrow screen: the app name and as many
 * menus as fit stay, the rest move into a "»" menu that gets the room it needs. In
 * right-to-left text the strip starts at the right edge.
 *
 * @param {number[]} widths natural widths, the app name first
 * @param {number} available strip width
 * @param {number} moreWidth width of the "»" button
 * @param {boolean} [rtl]
 * @returns {{shown: number, more: boolean, xs: number[], moreX: number}} xs: left edge per
 *   shown menu; moreX: left edge of the "»" button (when `more`)
 */
export function fitMenus(widths, available, moreWidth, rtl = false) {
    const total = widths.reduce((s, w) => s + w, 0);
    let shown = widths.length;
    const more = total > available + 0.5;
    if (more) {
        shown = Math.min(1, widths.length);
        let used = widths[0] ?? 0;
        while (shown < widths.length && used + widths[shown] + moreWidth <= available + 0.5)
            used += widths[shown++];
    }
    const xs = [];
    let x = 0;
    for (let i = 0; i < shown; i++) {
        xs.push(rtl ? available - x - widths[i] : x);
        x += widths[i];
    }
    return { shown, more, xs, moreX: rtl ? available - x - moreWidth : x };
}

// ---- privacy dots ----------------------------------------------------------------------------

/**
 * The dots to show, in macOS order (left to right: screen, camera, microphone).
 *
 * @param {{mic: boolean, camera: boolean, screen: boolean}} state
 * @returns {('screen'|'camera'|'mic')[]}
 */
export function privacyDots({ mic, camera, screen }) {
    return [screen && 'screen', camera && 'camera', mic && 'mic'].filter(Boolean);
}

/**
 * Apps recording from the microphone, from the mixer's source outputs (the same rule as the
 * Shell's microphone indicator: level meters of volume controls do not count).
 *
 * @param {{appId: ?string, name: ?string}[]} outputs
 * @returns {string[]} unique display names
 */
export function micApps(outputs) {
    const skipped = new Set(['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol']);
    const names = [];
    for (const o of outputs) {
        if (skipped.has(o.appId))
            continue;
        const name = o.name || o.appId;
        if (name && !names.includes(name))
            names.push(name);
    }
    return names;
}

/**
 * Icon names to try for the system logo, symbolic first (it follows the bar's text colour by
 * itself); the plain one is recoloured by logoTint.js.
 *
 * @param {string} logo os-release LOGO
 * @returns {string[]}
 */
export function systemLogoNames(logo) {
    return logo.endsWith('-symbolic') ? [logo] : [`${logo}-symbolic`, logo];
}
