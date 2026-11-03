// SPDX-License-Identifier: GPL-3.0-or-later
// The custom-colour pointer theme: the user's cursor theme with every Xcursor image recoloured
// (model.js recolorXcursor), written to ~/.local/share/icons/Guava-Pointer-<colours>/.
//
// Only folders Guava made are ever written or removed: each gets a THEME_MARKER file right after
// it is created (index.theme comes last and marks it complete), and an older Guava-Pointer-*
// folder is removed only when it has the marker. Async Gio through
// the shared user-file queue (lib/fileOps.js); never blocks the compositor.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { exists, list, makeDirectory, remove, writeText } from '../../lib/fileOps.js';
import { THEME_MARKER, THEME_PREFIX, indexTheme, pickXcursorImage, recolorXcursor, themeName } from './model.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'make_symbolic_link_async', 'make_symbolic_link_finish');

const FALLBACK_THEME = 'Adwaita';

/** Folders searched for a cursor theme, in libXcursor's order. */
function themeDirs(name) {
    const home = GLib.get_home_dir();
    const dirs = [GLib.build_filenamev([GLib.get_user_data_dir(), 'icons', name]),
        GLib.build_filenamev([home, '.icons', name])];
    for (const d of GLib.get_system_data_dirs())
        dirs.push(GLib.build_filenamev([d, 'icons', name]));
    dirs.push(GLib.build_filenamev(['/usr/share/pixmaps', name]));
    return dirs;
}

async function findCursors(name, cancellable) {
    for (const dir of themeDirs(name)) {
        if (cancellable?.is_cancelled())
            return null;
        const cursors = GLib.build_filenamev([dir, 'cursors']);
        if (await exists(cursors))
            return cursors;
    }
    return null;
}

async function copyRecolored(src, dest, fill, outline, cancellable) {
    for (const name of await list(src)) {
        if (cancellable?.is_cancelled())
            return;
        const from = Gio.File.new_for_path(GLib.build_filenamev([src, name]));
        const to = Gio.File.new_for_path(GLib.build_filenamev([dest, name]));
        const info = await from.query_info_async('standard::is-symlink,standard::symlink-target,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, cancellable);
        if (info.get_is_symlink()) {
            if (!await exists(to))
                await to.make_symbolic_link_async(info.get_symlink_target(), GLib.PRIORITY_LOW, cancellable);
            continue;
        }
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            continue;
        const [bytes] = await from.load_contents_async(cancellable);
        const out = recolorXcursor(bytes, fill, outline);
        if (out) {
            await to.replace_contents_bytes_async(new GLib.Bytes(out), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        }
    }
}

/**
 * Make (or reuse) the theme for these colours, based on `baseTheme`, and remove Guava's older
 * ones.
 *
 * @returns {Promise<?string>} the theme name, or null when no base cursors were found
 */
export async function ensureTheme(baseTheme, fill, outline, cancellable) {
    const name = themeName(fill, outline);
    const icons = GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']);
    const dir = GLib.build_filenamev([icons, name]);
    const marker = GLib.build_filenamev([dir, THEME_MARKER]);
    const index = GLib.build_filenamev([dir, 'index.theme']);
    const base = baseTheme && !baseTheme.startsWith(THEME_PREFIX) ? baseTheme : FALLBACK_THEME;
    // A folder of that name Guava did not make (no marker) is never touched
    if (await exists(dir) && !await exists(marker))
        return null;
    // index.theme is written last: without it an earlier run stopped half-way, so redo it
    if (!await exists(index)) {
        const src = await findCursors(base, cancellable) ??
            (base !== FALLBACK_THEME ? await findCursors(FALLBACK_THEME, cancellable) : null);
        if (!src || cancellable?.is_cancelled())
            return null;
        await makeDirectory(GLib.get_user_data_dir());
        await makeDirectory(icons);
        await makeDirectory(dir);
        await writeText(marker, `${base}\n`);
        const cursors = GLib.build_filenamev([dir, 'cursors']);
        await makeDirectory(cursors);
        await copyRecolored(src, cursors, fill, outline, cancellable);
        if (cancellable?.is_cancelled())
            return null;
        await writeText(index, indexTheme(base));
    }
    await removeOthers(icons, name);
    return name;
}

/** Remove Guava's pointer themes other than `keep` (only folders with Guava's marker). */
export async function removeOthers(icons, keep = null) {
    for (const entry of await list(icons)) {
        if (!entry.startsWith(THEME_PREFIX) || entry === keep)
            continue;
        const dir = GLib.build_filenamev([icons, entry]);
        if (!await exists(GLib.build_filenamev([dir, THEME_MARKER])))
            continue;
        await removeTree(dir);
    }
}

async function removeTree(dir) {
    const cursors = GLib.build_filenamev([dir, 'cursors']);
    for (const name of await list(cursors))
        await remove(GLib.build_filenamev([cursors, name]));
    await remove(cursors);
    for (const name of await list(dir)) {
        if (name !== THEME_MARKER)
            await remove(GLib.build_filenamev([dir, name]));
    }
    // The marker last: a half-removed folder is still recognised as Guava's next time
    await remove(GLib.build_filenamev([dir, THEME_MARKER]));
    await remove(dir);
}

/** The user data icons folder (for removing every Guava pointer theme). */
export function iconsDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']);
}

/**
 * The theme's cursor `cursorName` ('default' is the arrow) at the size nearest above `want`
 * pixels, so the big pointer is drawn from real pixels, not a small one scaled up.
 *
 * @returns {Promise<?object>} model.js pickXcursorImage's result, or null (no such cursor)
 */
export async function loadCursorImage(theme, cursorName, want, cancellable) {
    for (const name of [theme, FALLBACK_THEME]) {
        if (!name)
            continue;
        const dir = await findCursors(name, cancellable);
        if (!dir || cancellable?.is_cancelled())
            continue;
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, cursorName]));
        try {
            const [bytes] = await file.load_contents_async(cancellable);
            const img = pickXcursorImage(bytes, want);
            if (img)
                return img;
        } catch (e) {
            if (cancellable?.is_cancelled())
                return null;
        }
    }
    return null;
}
