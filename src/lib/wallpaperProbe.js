// SPDX-License-Identifier: GPL-3.0-or-later
// Run as its own process by lib/wallpaperDecode.js; never imported into the Shell.
//
//   gjs -m wallpaperProbe.js thumb <path> <width> <height> <keep-aspect 0|1>
//       -> {width, height, rowstride, channels, data: base64 pixels} of the picture scaled to a
//          small thumbnail (the glass tint average, Launchpad's backdrop)
//   gjs -m wallpaperProbe.js band <path> <option> <monitor-w> <monitor-h> <band>
//       -> {mean, spread, low, high} luminance of the band under the menu bar, or null when the
//          picture does not reach the bar
//
// Why a process: GdkPixbuf decodes PNG and JPEG on the thread that reads them, whatever the
// target size, so a big wallpaper stalled the Shell (650 ms at 9000 px, 5 s at 14000 px). Here
// the Shell's main loop only awaits a pipe. A picture over MAX_PROBE_PIXELS is refused before
// any pixel is read.

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import System from 'system';

import { PROBE_WIDTH, bandLuminance, decodesByRatio, wallpaperBand, withinProbeCap } from './wallpaperModel.js';

const [mode, path, ...args] = ARGV; // eslint-disable-line no-undef
let sizeKnown = false;

function thumb([width, height, keepAspect]) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, Number(width), Number(height), keepAspect === '1');
    return {
        width: pixbuf.get_width(), height: pixbuf.get_height(), rowstride: pixbuf.get_rowstride(),
        channels: pixbuf.get_n_channels(), data: GLib.base64_encode(pixbuf.read_pixel_bytes().toArray()),
    };
}

function band([option, mw, mh, bandHeight]) {
    // Placements by ratio read a small decode; centred and tiled pictures use their real pixels
    // A real-pixel decode needs the real size: with an unknown one (JPEG XL) it is not safe
    if (!decodesByRatio(option) && !sizeKnown)
        throw new Error('the picture size is unknown and the placement needs it');
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, decodesByRatio(option) ? PROBE_WIDTH : -1, -1, true);
    const rect = wallpaperBand({ width: pixbuf.get_width(), height: pixbuf.get_height() },
        { width: Number(mw), height: Number(mh) }, option, Number(bandHeight));
    return rect && bandLuminance(pixbuf.read_pixel_bytes().toArray(),
        { rowstride: pixbuf.get_rowstride(), channels: pixbuf.get_n_channels() }, rect);
}

try {
    const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    // Some formats (JPEG XL) do not tell their size up front: 0x0 is unknown, not too large
    sizeKnown = width > 0 && height > 0;
    if (sizeKnown && !withinProbeCap(width, height))
        throw new Error(`the picture is too large (${width}x${height})`);
    print(JSON.stringify(mode === 'thumb' ? thumb(args) : band(args)));
} catch (e) {
    printerr(e.message);
    System.exit(1);
}
