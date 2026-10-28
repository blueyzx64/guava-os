// SPDX-License-Identifier: GPL-3.0-or-later
// GTK stylesheets for the apps' own titlebars: the macOS traffic lights of app-buttons-style
// 'macos' and the app fixes of popup-menu-styling. Which sheets: model.js gtkSheets().
//
// Imports are written only to the user's ~/.config/gtk-{3,4}.0/gtk.css, between Guava's two
// marker comments, so the extension never writes inside its own installation directory
// (system-wide installs stay read-only). The rest of the file is the
// user's and is never touched. A gtk.css that held only Guava's block is deleted; a symlinked
// one is emptied instead.
//
// Dangling imports: after a crash or an uninstall without disable() the block still points
// into the extension folder. GTK only warns about an import it cannot open; the next enable
// replaces the block, the next disable removes it. Manual fix: delete the block between the
// two "Guava OS - managed imports" comments.

import GLib from 'gi://GLib';

import { GuavaSettings } from '../../lib/settings.js';
import * as fs from '../../lib/fileOps.js';
import { gtkSheets } from './model.js';

const MARKER_BEGIN = '/* Guava OS - managed imports: begin */';
const MARKER_END = '/* Guava OS - managed imports: end */';

// The whole managed block, markers included.
const MANAGED_BLOCK_REGEX = /\/\* Guava OS - managed imports: begin \*\/[\s\S]*?\/\* Guava OS - managed imports: end \*\/\n?/g;

const KEYS = ['button-size', 'popup-menu-styling', 'app-buttons-style'];

/**
 * gtk.css text with Guava's block replaced by `block` ('' removes it), user rules untouched.
 * Pure; exported for tests.
 */
export function withManagedBlock(existing, block) {
    const rest = (existing ?? '').replace(MANAGED_BLOCK_REGEX, '');
    // Guava's imports come first so user rules can still override them
    return block + rest;
}

/**
 * Put `managedBlock` into <dirPath>/gtk.css. The file is created only when there is a block,
 * and deleted only when it held Guava's block and nothing else.
 */
export async function processUserGtkFile(dirPath, managedBlock) {
    const filePath = GLib.build_filenamev([dirPath, 'gtk.css']);
    try {
        const existing = await fs.readText(filePath);
        if (existing === null && !managedBlock)
            return;
        const next = withManagedBlock(existing, managedBlock);
        if (next === existing)
            return;
        if (!next.trim()) {
            if (await fs.isSymlink(filePath))
                await fs.writeText(filePath, '');
            else
                await fs.remove(filePath);
            return;
        }
        if (existing === null)
            await fs.makeDirectory(dirPath);
        await fs.writeText(filePath, next);
    } catch (error) {
        // Not valid UTF-8: the user's file stays as it is (rewriting it would damage its text)
        const log = error instanceof fs.NotUtf8Error ? console.warn : console.error;
        log(`[Guava] could not update ${filePath}: ${error}`);
    }
}

export class GtkTheme {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._gtkDir = GLib.build_filenamev([ctx.extension.path, 'features', 'appButtons', 'gtk']);
    }

    enable() {
        const ks = new GuavaSettings(this._ctx.settings);
        ks.attach(this._cleanup);
        ks.watch(KEYS, () => this._update(ks));
        // On stop (lock, disable): Guava's imports out of the user's files again
        this._cleanup.add(() => this._write(() => ''));
        this._update(ks);
    }

    disable() {
        // The cleanup registry, disposed right after this, removes the imports
    }

    _block(ks, version) {
        const sheets = gtkSheets({
            style: ks.string('app-buttons-style'),
            size: ks.string('button-size'),
            appFixes: ks.bool('popup-menu-styling'),
        }, version);
        if (!sheets.length)
            return '';
        const imports = sheets.map(name =>
            `@import url("${GLib.filename_to_uri(GLib.build_filenamev([this._gtkDir, name]), null)}");`);
        return `${MARKER_BEGIN}\n${imports.join('\n')}\n${MARKER_END}\n`;
    }

    // Settings are read now and the files written later, so a disable cannot starve the job.
    _update(ks) {
        const blocks = { 3: this._block(ks, '3'), 4: this._block(ks, '4') };
        this._write(v => blocks[v]);
    }

    _write(blockFor) {
        const configDir = GLib.get_user_config_dir();
        const jobs = ['3', '4'].map(v => [GLib.build_filenamev([configDir, `gtk-${v}.0`]), blockFor(v)]);
        fs.enqueueUserFileJob(async () => {
            for (const [dir, block] of jobs)
                await processUserGtkFile(dir, block);
        });
    }
}
