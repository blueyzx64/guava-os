// SPDX-License-Identifier: GPL-3.0-or-later
// The inline name editor of Rename: a text field over the icon's name, as in Finder. It takes the
// keyboard through a Shell modal grab (a window cannot have the focus while it types), so a click
// anywhere else, Enter or Tab commits and Escape cancels. The pure rules (what a valid name is,
// how much of it is selected first) are in model.js.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { stemLength } from './model.js';

export class RenameEditor {
    /**
     * @param {object} p
     * @param {import('./tile.js').IconTile} p.tile the icon being renamed
     * @param {{x: number, y: number, width: number, height: number}} p.box where the field goes (stage px)
     * @param {string} p.accessibleName
     * @param {(text: string) => ?string} p.validate null when the name is fine, else the problem to show
     * @param {(text: string) => void} p.commit
     * @param {() => void} p.cancel
     */
    constructor({ tile, box, accessibleName, validate, commit, cancel }) {
        this._tile = tile;
        this._validate = validate;
        this._commit = commit;
        this._cancel = cancel;
        this._done = false;
        this._grab = null;
        /** False when another modal was open and the editor could not start. */
        this.ok = true;

        // A transparent catcher over everything: a press outside the field commits
        this._scrim = new St.Widget({ name: 'guava-di-rename-scrim', reactive: true, x: 0, y: 0 });
        this._scrim.set_size(global.stage.width, global.stage.height);
        this._entry = new St.Entry({
            style_class: 'guava-di-rename',
            text: tile.entry.name,
            accessible_name: accessibleName,
            can_focus: true,
            x: box.x, y: box.y, width: box.width,
        });
        this._entry.clutter_text.set({ single_line_mode: true, x_align: Clutter.ActorAlign.CENTER });
        this._scrim.add_child(this._entry);
        Main.uiGroup.add_child(this._scrim);

        this._grab = Main.pushModal(this._scrim, { actionMode: Shell.ActionMode.NONE });
        if (!this._grab) {
            this._scrim.destroy();
            this._done = true;
            this.ok = false;
            return;
        }
        tile.setEditing(true);
        this._scrim.connect('button-press-event', (_a, event) => {
            const hit = global.stage.get_event_actor(event);
            if (hit !== this._entry && !this._entry.contains(hit))
                this._finish(true);
            return Clutter.EVENT_PROPAGATE;
        });
        this._entry.clutter_text.connect('key-press-event', (_t, event) => this._key(event));
        this._entry.clutter_text.connect('text-changed', () => this._check());
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_selection(0, stemLength(tile.entry.name, tile.entry.kind === 'folder'));
    }

    _check() {
        const problem = this._validate(this._entry.text);
        if (problem)
            this._entry.add_style_pseudo_class('error');
        else
            this._entry.remove_style_pseudo_class('error');
        this._entry.accessible_description = problem ?? '';
        return problem;
    }

    _key(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
        case Clutter.KEY_Tab:
            this._finish(true);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            this._finish(false);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _finish(commit) {
        if (this._done)
            return;
        // A name that is not allowed keeps the editor open, marked, until it is fixed or cancelled
        if (commit && this._check())
            return;
        this._done = true;
        const text = this._entry.text;
        this.close();
        if (commit)
            this._commit(text);
        else
            this._cancel();
    }

    /** Remove the editor without a result (the icon went away, the feature stopped). */
    close() {
        if (!this.ok)
            return;
        this.ok = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._done = true;
        this._tile.setEditing(false);
        this._scrim.destroy();
    }
}
