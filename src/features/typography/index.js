// SPDX-License-Identifier: GPL-3.0-or-later
// Typography (registry id 'typography', always running; each part has its own key):
// - macOS text rendering (macos-text-rendering): unhinted glyphs with grayscale antialiasing,
//   as macOS draws them. Owns org.gnome.desktop.interface font-rendering ('manual': GNOME 50's
//   'automatic' makes GTK4 ignore the two keys below), font-hinting and font-antialiasing.
// - Font smoothing (macos-font-smoothing): heavier text through FreeType stem darkening. A
//   Guava-marked ~/.config/environment.d file sets FREETYPE_PROPERTIES from the next login; while
//   it is on, font-hinting is 'slight' (TrueType stems darken only under light hinting). The file
//   follows the key, not enable/disable (GNOME disables extensions at every lock).
// - macOS font (macos-font): SF Pro when installed, else Inter, for the interface and
//   document fonts at the user's own size; SF Mono for the monospace font when installed.
//   Owns font-name, document-font-name (and monospace-font-name). Nothing is set while
//   neither family is installed; installing one (the preferences offer Inter) applies it.
// - Rendering style (font-rendering-style): 'macos' is the above; 'lucidglyph' is lucidglyph's
//   rendering (https://github.com/maximilionus/lucidglyph, GPL-3.0, by maximilionus): its
//   environment in the same Guava file, its fontconfig rules (./lucidglyph/, copied Guava-marked
//   to ~/.config/fontconfig/conf.d and removed again when the style goes back), and slight
//   hinting with grayscale antialiasing. The two switches above do not apply then. Takes full
//   effect after logging out and in (the environment); apps pick the rules up as they start.
// The Shell and every app follow these GNOME keys. Each key is owned through core/originals:
// the user's value comes back when the part goes off or Guava stops, even after a crash.
// Picking another font or rendering in GNOME Settings or Tweaks turns that part off.
//
// Installed families come from `fc-list` in a subprocess (fresh after an install, no sync
// fontconfig scan in the Shell); the font directories are watched for installs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { enqueueUserFileJob, exists, isSymlink, makeDirectory, readText, remove, writeText } from '../../lib/fileOps.js';
import { GuavaSettings } from '../../lib/settings.js';
import { SettingOwner } from '../../core/originals.js';
import {
    LUCIDGLYPH_RULES, SMOOTHING_FILE, ownsRendering, parseFcList, plan, renderingValues, ruleAction, smoothingAction,
    smoothingText, styleOf, withFamily,
} from './model.js';

const IFACE_SCHEMA = 'org.gnome.desktop.interface';
const KEYS = {
    rendering: 'macos-text-rendering', font: 'macos-font', smoothing: 'macos-font-smoothing', style: 'font-rendering-style',
};
const envDir = () => Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'environment.d']));
const rulesDir = () => Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'fontconfig', 'conf.d']));
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
        this._ks.watch([KEYS.smoothing, KEYS.style], () => {
            this._releaseAll(this._rendering);   // hinting differs: own it again
            this._syncRendering();
            this._syncSmoothingFile();
            this._syncRules();
        });
        this._syncRendering();
        this._syncSmoothingFile();
        this._syncRules();
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
            onOriginalChanged: () => {
                this._ks.setBool(partKey, false);
                // The rendering keys under the lucidglyph style: the style goes back too
                if (partKey === KEYS.rendering && this._style() === 'lucidglyph')
                    this._ctx.settings.set_string(KEYS.style, 'macos');
            },
        });
    }

    _style() {
        return styleOf(this._ctx.settings.get_string(KEYS.style));
    }

    _syncRendering() {
        const want = ownsRendering(this._ks.bool(KEYS.rendering), this._style());
        if (!want) {
            this._releaseAll(this._rendering);
            return;
        }
        if (this._rendering.length)
            return;
        const schema = this._iface.settings_schema;
        for (const [key, value] of Object.entries(renderingValues(this._ks.bool(KEYS.smoothing), this._style()))) {
            // font-rendering is new in GNOME 50: older shells lack the key
            if (!schema.has_key(key))
                continue;
            const owner = this._own(key, { value }, KEYS.rendering);
            owner.sync(true);
            this._rendering.push(owner);
        }
    }

    /** Bring ~/.config/environment.d/60-guava-freetype.conf in line with the key (async, queued). */
    _syncSmoothingFile() {
        const want = this._ks.bool(KEYS.smoothing);
        const style = this._style();
        const file = envDir().get_child(SMOOTHING_FILE);
        enqueueUserFileJob(async () => {
            // A symlink there is the user's (dotfiles): left alone
            if (await exists(file) && await isSymlink(file))
                return;
            const action = smoothingAction(await readText(file), want, style);
            if (action === 'remove') {
                await remove(file);
            } else if (action === 'write') {
                await makeDirectory(envDir());
                await writeText(file, smoothingText(style));
            }
        });
    }

    /** lucidglyph's fontconfig rules in ~/.config/fontconfig/conf.d follow the style (async, queued). */
    _syncRules() {
        const style = this._style();
        const shippedDir = this._ctx.extension.dir.get_child('features').get_child('typography').get_child('lucidglyph');
        enqueueUserFileJob(async () => {
            for (const name of LUCIDGLYPH_RULES) {
                const file = rulesDir().get_child(name);
                if (await exists(file) && await isSymlink(file))
                    continue;
                const shipped = style === 'lucidglyph' ? await readText(shippedDir.get_child(name)) : '';
                if (shipped === null) {
                    console.warn(`${LOG} lucidglyph rule ${name} is missing from the extension`);
                    continue;
                }
                const action = ruleAction(await readText(file), shipped, style);
                if (action === 'remove') {
                    await remove(file);
                } else if (action === 'write') {
                    await makeDirectory(rulesDir().get_parent());   // ~/.config/fontconfig, one level at a time
                    await makeDirectory(rulesDir());
                    await writeText(file, shipped);
                }
            }
        });
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
