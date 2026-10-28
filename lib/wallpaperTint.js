// SPDX-License-Identifier: GPL-3.0-or-later
// WallpaperTint: the average colour of the current wallpaper, for the glass tint.
//
// The picture is decoded once per change, in a helper process (wallpaperDecode.js, so a big
// file never stalls the Shell), straight to a 32x32 thumbnail, and averaged. Results are cached
// per picture for the session (an XML day/night background is sampled again when its next
// picture comes up), so switching between Light and Dark (two pictures) costs nothing after
// the first time. Nothing runs per frame, and nothing at all while the wallpaper is unchanged.
// An unreadable picture (a format without a loader, a missing file) means "no tint", silently.
//
//   const tint = new WallpaperTint();
//   tint.start(registry, color => ...);   // color: [r, g, b] or null; called on every change
//   tint.color                            // latest value

import Gio from 'gi://Gio';

import { decodeWallpaper, resolveWallpaper } from './wallpaperDecode.js';
import { ColorCache, SAMPLE_SIZE, averageRgb, slideDelayMs, wallpaperSource } from './wallpaperModel.js';

const BG_SCHEMA = 'org.gnome.desktop.background';
const IFACE_SCHEMA = 'org.gnome.desktop.interface';
const BG_KEYS = ['picture-uri', 'picture-uri-dark', 'picture-options', 'primary-color'];

// Session cache: a wallpaper is decoded once however often glass restarts
const cache = new ColorCache();

export class WallpaperTint {
    constructor() {
        this.color = null;
        this._cancellable = null;
        this._onChange = null;
        this._bg = null;
        this._iface = null;
        this._registry = null;
        this._slideToken = 0;
    }

    /**
     * Follow the wallpaper until `registry` is disposed.
     *
     * @param {import('./disposables.js').CleanupRegistry} registry
     * @param {(color: ?number[]) => void} onChange
     */
    start(registry, onChange) {
        this._onChange = onChange;
        this._registry = registry;
        this._bg = new Gio.Settings({ schema_id: BG_SCHEMA });
        this._iface = new Gio.Settings({ schema_id: IFACE_SCHEMA });
        for (const key of BG_KEYS)
            registry.connect(this._bg, `changed::${key}`, () => this._sample());
        registry.connect(this._iface, 'changed::color-scheme', () => this._sample());
        registry.add(() => {
            this._cancellable?.cancel();
            this._cancellable = null;
            this._slideToken = 0;
            this._registry = null;
            this._onChange = null;
            this._bg = null;
            this._iface = null;
        });
        this._sample();
    }

    _source() {
        return wallpaperSource({
            pictureUri: this._bg.get_string('picture-uri'),
            pictureUriDark: this._bg.get_string('picture-uri-dark'),
            options: this._bg.get_string('picture-options'),
            primaryColor: this._bg.get_string('primary-color'),
            colorScheme: this._iface.get_string('color-scheme'),
        });
    }

    _set(color) {
        const same = color === this.color ||
            (color && this.color && color.every((c, i) => c === this.color[i]));
        this.color = color;
        if (!same)
            this._onChange?.(color);
    }

    _sample() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._registry.release(this._slideToken);
        this._slideToken = 0;
        const source = this._source();
        if (source.kind === 'none') {
            this._set(null);
            return;
        }
        if (source.kind === 'color') {
            this._set(source.color);
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._load(source.uri, cancellable).then(color => {
            if (cancellable.is_cancelled())
                return;
            this._cancellable = null;
            this._set(color);
        }).catch(e => {
            if (cancellable.is_cancelled() || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // No loader for this format, a missing file or a picture over the size cap: glass
            // keeps its neutral tint
            this._cancellable = null;
            this._set(null);
        });
    }

    // The average colour of the picture shown now; the next sample is set for an XML background's
    // next picture
    async _load(uri, cancellable) {
        const slide = await resolveWallpaper(uri, cancellable);
        if (slide.until !== null && !cancellable.is_cancelled()) {
            this._slideToken = this._registry.timeout(slideDelayMs(slide.until), () => {
                this._slideToken = 0;
                this._sample();
            }, { name: 'wallpaper tint slide' });
        }
        const cached = cache.get(slide.uri);
        if (cached !== undefined)
            return cached;
        const color = await this._average(slide.uri, cancellable);
        cache.set(slide.uri, color);
        return color;
    }

    async _average(uri, cancellable) {
        const pixbuf = await decodeWallpaper(uri, SAMPLE_SIZE, SAMPLE_SIZE, false, cancellable);
        return averageRgb(pixbuf.read_pixel_bytes().toArray(), {
            width: pixbuf.get_width(),
            height: pixbuf.get_height(),
            rowstride: pixbuf.get_rowstride(),
            channels: pixbuf.get_n_channels(),
        });
    }
}
