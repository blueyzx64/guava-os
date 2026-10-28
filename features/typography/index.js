// SPDX-License-Identifier: GPL-3.0-or-later
// Typography (registry id 'typography', always running; each part has its own key):
// - macOS text rendering (macos-text-rendering): unhinted glyphs with grayscale antialiasing,
//   as macOS draws them. Owns org.gnome.desktop.interface font-hinting and font-antialiasing.
// - macOS font (macos-font): SF Pro when installed, else Inter, for the interface and
//   document fonts at the user's own size; SF Mono for the monospace font when installed.
//   Owns font-name, document-font-name (and monospace-font-name). Nothing is set while
//   neither family is installed; installing one (the preferences offer Inter) applies it.
// The Shell and every app follow these GNOME keys. Each key is owned through core/originals:
// the user's value comes back when the part goes off or Guava stops, even after a crash.
// Picking another font or rendering in GNOME Settings or Tweaks turns that part off.
//
// Installed families come from `fc-list` in a subprocess (fresh after an install, no sync
// fontconfig scan in the Shell); the font directories are watched for installs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { GuavaSettings } from '../../lib/settings.js';
import { SettingOwner } from '../../core/originals.js';
import { MACOS_RENDERING, parseFcList, plan, withFamily } from './model.js';

const IFACE_SCHEMA = 'org.gnome.desktop.interface';
const KEYS = { rendering: 'macos-text-rendering', font: 'macos-font' };
const FONT_DIRS = () => ['/usr/share/fonts', GLib.build_filenamev([GLib.get_user_data_dir(), 'fonts'])];
/** An install writes many files: one scan after the burst. */
const RESCAN_DELAY_MS = 2000;
const LOG = '[Guava] typography:';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

export class Typography {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._ks = null;
        this._iface = null;
        this._rendering = [];   // SettingOwners of the rendering keys
        this._fonts = [];       // SettingOwners of the font keys
        this._plan = { ui: null, mono: null };
        this._cancellable = null;
        this._rescan = 0;
    }

    enable() {
        const cleanup = this._cleanup;
        this._ks = new GuavaSettings(this._ctx.settings);
        this._ks.attach(cleanup);
        this._iface = new Gio.Settings({ schema_id: IFACE_SCHEMA });
        this._cancellable = new Gio.Cancellable();
        cleanup.add(() => this._cancellable.cancel());
        cleanup.add(() => {
            this._releaseAll(this._rendering);
            this._releaseAll(this._fonts);
        });

        this._ks.watch(KEYS.rendering, () => this._syncRendering());
        this._ks.watch(KEYS.font, () => this._syncFonts());
        this._syncRendering();
        this._watchFontDirs();
        this._scan();
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }

    /** What the font part uses now (tests, harness). */
    get families() {
        return { ...this._plan };
    }

    _releaseAll(owners) {
        for (const o of owners)
            o.release();
        owners.length = 0;
    }

    _own(key, opts, partKey) {
        return new SettingOwner(this._ctx.originals, this._iface, key, {
            type: 's',
            ...opts,
            // The user chose their own value: the part goes off, their value stands
            yieldToUser: true,
            onOriginalChanged: () => this._ks.setBool(partKey, false),
        });
    }

    _syncRendering() {
        const want = this._ks.bool(KEYS.rendering);
        if (!want) {
            this._releaseAll(this._rendering);
            return;
        }
        if (this._rendering.length)
            return;
        for (const [key, value] of Object.entries(MACOS_RENDERING)) {
            const owner = this._own(key, { value }, KEYS.rendering);
            owner.sync(true);
            this._rendering.push(owner);
        }
    }

    _syncFonts() {
        this._releaseAll(this._fonts);
        const { ui, mono } = this._plan;
        if (!this._ks.bool(KEYS.font) || !ui)
            return;
        const owned = [['font-name', ui, 11], ['document-font-name', ui, 11]];
        if (mono)
            owned.push(['monospace-font-name', mono, 10]);
        for (const [key, family, size] of owned) {
            const owner = this._own(key, { transform: original => withFamily(original, family, size) }, KEYS.font);
            owner.sync(true);
            this._fonts.push(owner);
        }
    }

    async _scan() {
        try {
            const proc = new Gio.Subprocess({
                argv: ['fc-list', ':', 'family'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(this._cancellable);
            const [out] = await proc.communicate_utf8_async(null, this._cancellable);
            const next = plan(parseFcList(out));
            if (next.ui === this._plan.ui && next.mono === this._plan.mono)
                return;
            this._plan = next;
            this._syncFonts();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`${LOG} cannot list the installed fonts:`, e.message);
        }
    }

    _watchFontDirs() {
        for (const path of FONT_DIRS()) {
            try {
                const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
                this._cleanup.connect(monitor, 'changed', () => this._scanSoon());
                this._cleanup.add(() => monitor.cancel());
            } catch (_e) {
                // No such directory (no user fonts yet): nothing to watch
            }
        }
    }

    _scanSoon() {
        if (this._rescan)
            return;
        this._rescan = this._cleanup.timeout(RESCAN_DELAY_MS, () => {
            this._rescan = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        }, { name: 'typography-rescan' });
    }
}
