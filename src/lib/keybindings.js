// SPDX-License-Identifier: GPL-3.0-or-later
// KeybindingService: every Guava global shortcut is registered and removed here.
//
//   import { Keybindings } from '../lib/keybindings.js';
//   Keybindings.add(cleanup, 'clipboard-shortcut', ctx.settings, () => toggle());
//
// The binding is removed when `cleanup` is disposed, so enable()/disable() stay mirrors.
// The key must be an `as` key in Guava's schema; changing it in prefs rebinds live.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { BindingTable, KNOWN_DEFAULTS, findConflicts, normalizeAccel } from './keybindingsModel.js';

const LOG = '[Guava]';

// Schemas that hold the accelerators a new Guava shortcut can collide with
const SCAN_SCHEMAS = [
    'org.gnome.shell.keybindings',
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

/** Action modes for a shortcut that opens a Guava modal: also active in POPUP, its own mode. */
export const MODAL_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;

class KeybindingService {
    constructor() {
        this._table = new BindingTable();
    }

    /**
     * @param {object} cleanup CleanupRegistry of the owning feature
     * @param {string} name `as` key in Guava's schema
     * @param {Gio.Settings} settings Guava's settings (the schema that owns `name`)
     * @param {Function} handler called on the shortcut
     * @param {{flags?: number, modes?: number}} [opts] default: IGNORE_AUTOREPEAT, NORMAL | OVERVIEW.
     *   A shortcut that opens a modal passes MODAL_MODES so it also works (to close) while it is open.
     * @returns {boolean} false when the name is taken or the Shell refused it
     */
    add(cleanup, name, settings, handler, opts = {}) {
        if (!this._table.claim(name)) {
            console.warn(`${LOG} keybinding ${name} is already registered`);
            return false;
        }
        const flags = opts.flags ?? Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const modes = opts.modes ?? (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        try {
            const action = Main.wm.addKeybinding(name, settings, flags, modes, handler);
            if (action === Meta.KeyBindingAction.NONE)
                throw new Error('the Shell refused the binding');
        } catch (e) {
            this._table.release(name);
            console.warn(`${LOG} keybinding ${name} failed: ${e.message}`);
            return false;
        }
        cleanup.add(() => this.remove(name));
        return true;
    }

    remove(name) {
        if (!this._table.release(name))
            return;
        try {
            Main.wm.removeKeybinding(name);
        } catch (e) {
            console.warn(`${LOG} removing keybinding ${name} failed: ${e.message}`);
        }
    }

    removeAll() {
        this._table.names().forEach(n => this.remove(n));
    }

    has(name) {
        return this._table.has(name);
    }

    names() {
        return this._table.names();
    }

    /**
     * Stock shortcuts that use any of `accels`. Reads the live GNOME schemas (cheap gsettings
     * reads, no file I/O) and falls back to a short built-in list.
     *
     * @param {string[]} accels
     * @returns {{accel: string, with: string}[]}
     */
    conflicts(accels) {
        const taken = new Map(Object.entries(KNOWN_DEFAULTS));
        const source = Gio.SettingsSchemaSource.get_default();
        for (const id of SCAN_SCHEMAS) {
            const schema = source?.lookup(id, true);
            if (!schema)
                continue;
            const gs = new Gio.Settings({ settings_schema: schema });
            for (const key of schema.list_keys()) {
                if (schema.get_key(key).get_value_type().dup_string() !== 'as')
                    continue;
                for (const accel of gs.get_strv(key)) {
                    const n = normalizeAccel(accel);
                    if (n)
                        taken.set(n, `${id} ${key}`);
                }
            }
        }
        return findConflicts(accels, taken);
    }
}

export const Keybindings = new KeybindingService();
