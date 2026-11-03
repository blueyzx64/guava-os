// SPDX-License-Identifier: GPL-3.0-or-later
// The one way Guava reads a wallpaper: through lib/wallpaperProbe.js in a helper process, so a
// big picture never stalls the Shell. The tint (wallpaperTint.js), Launchpad's backdrop and the
// menu bar's band measurement all go through here.
//
//   const slide = await resolveWallpaper(uri, cancellable);     // {uri, until}
//   const pixbuf = await decodeWallpaper(slide.uri, 48, 27, false, cancellable);
//   const stats = await measureBand(slide.uri, 'zoom', monitor, 32, cancellable);

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import { isXmlBackground, xmlSlideAt } from './wallpaperModel.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const PROBE = GLib.filename_from_uri(import.meta.url.replace(/[^/]*$/, 'wallpaperProbe.js'))[0];

/**
 * The picture a background shows now: the file itself, or the one an XML day/night background
 * shows at this moment.
 *
 * @param {string} uri
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<{uri: string, until: ?number}>} until: seconds to the next picture (null: never)
 */
export async function resolveWallpaper(uri, cancellable) {
    if (!isXmlBackground(uri))
        return { uri, until: null };
    const xml = Gio.File.new_for_uri(uri);
    const [bytes] = await xml.load_contents_async(cancellable);
    const slide = xmlSlideAt(new TextDecoder().decode(bytes), new Date());
    if (!slide)
        throw new Error('the background lists no picture');
    const file = GLib.path_is_absolute(slide.path) ? Gio.File.new_for_path(slide.path)
        : xml.get_parent().resolve_relative_path(slide.path);
    return { uri: file.get_uri(), until: slide.until };
}

async function probe(argv, cancellable) {
    const proc = new Gio.Subprocess({
        argv: ['gjs', '-m', PROBE, ...argv],
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    proc.init(null);
    const stop = cancellable.connect(() => proc.force_exit());
    try {
        const [out, err] = await proc.communicate_utf8_async(null, cancellable);
        if (!proc.get_successful())
            throw new Error(err?.trim() || 'the picture cannot be decoded');
        return JSON.parse(out);
    } finally {
        cancellable.disconnect(stop);
    }
}

/**
 * A picture scaled to a small GdkPixbuf.
 *
 * @param {string} uri a picture (not an XML background: resolveWallpaper first)
 * @param {number} width
 * @param {number} height
 * @param {boolean} keepAspect fit inside width x height instead of filling it
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<GdkPixbuf.Pixbuf>}
 */
export async function decodeWallpaper(uri, width, height, keepAspect, cancellable) {
    const t = await probe(['thumb', Gio.File.new_for_uri(uri).get_path(), String(width), String(height),
        keepAspect ? '1' : '0'], cancellable);
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(GLib.base64_decode(t.data)), GdkPixbuf.Colorspace.RGB,
        t.channels === 4, 8, t.width, t.height, t.rowstride);
}

/**
 * Luminance of the band under the menu bar.
 *
 * @returns {Promise<?{mean: number, spread: number, low: number, high: number}>} null when the
 *   picture does not reach the bar
 */
export function measureBand(uri, option, monitor, band, cancellable) {
    return probe(['band', Gio.File.new_for_uri(uri).get_path(), option, String(monitor.width),
        String(monitor.height), String(band)], cancellable);
}
