// SPDX-License-Identifier: GPL-3.0-or-later
// The Trash at the end of the dock: empty or full icon, click opens it in Files, the menu has
// Open and Empty Trash (with the macOS confirmation), and files from the Downloads stack can be
// dropped on it. Dropping a dock icon on it removes the icon from the dock.
//
// The count comes from GVfs (trash:/// trash::item-count, async); changes are noticed with a
// local monitor on the home trash, which needs no D-Bus round trip to set up.
//
// Shell API: ui/modalDialog.js ModalDialog, ui/dialog.js MessageDialogContent.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { IconStyle } from '../../lib/iconStyle.js';
import { DockItem } from './items.js';

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'trash_async', 'trash_finish');

export const TRASH_URI = 'trash:///';
const BATCH = 64;

const cancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

export class TrashItem extends DockItem {
    constructor(host, spec) {
        super(host, spec, host.gettext('Trash'));
        const m = host.metrics;
        this._icon = new St.Icon({
            icon_name: 'user-trash', icon_size: m.icon,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this.content.add_child(this._icon);
        const style = IconStyle.apply(this._icon);
        this.cleanup.add(() => style.destroy());
        this.count = 0;
        this._counting = false;
        this._dirty = false;
        this._cancellable = new Gio.Cancellable();
        this.cleanup.add(() => this._cancellable.cancel());
        this._trash = Gio.File.new_for_uri(TRASH_URI);

        const files = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'Trash', 'files']));
        try {
            const monitor = files.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
            this.cleanup.connect(monitor, 'changed', () => this.refresh());
            this.cleanup.add(() => monitor.cancel());
        } catch (e) {
            console.warn('[Guava] dock: cannot watch the trash:', e.message);
        }
        this.refresh();
    }

    get iconActor() {
        return this._icon;
    }

    /** Re-read the item count (coalesced: one query at a time, one more if things changed). */
    refresh() {
        if (this._counting) {
            this._dirty = true;
            return;
        }
        this._counting = true;
        this._count().finally(() => {
            this._counting = false;
            if (this._dirty && !this._cancellable.is_cancelled()) {
                this._dirty = false;
                this.refresh();
            }
        });
    }

    async _count() {
        try {
            const info = await this._trash.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, this._cancellable);
            this.count = info.get_attribute_uint32('trash::item-count');
        } catch (e) {
            if (cancelled(e))
                return;
            this.count = 0;
        }
        // The query can finish just as the tile is destroyed (the dock toggled): its actors are gone
        if (this._cancellable.is_cancelled())
            return;
        this._icon.icon_name = this.count > 0 ? 'user-trash-full' : 'user-trash';
        this.setName(this.count > 0
            ? this._host.ngettext('Trash, %d item', 'Trash, %d items', this.count).format(this.count)
            : this._host.gettext('Trash'));
    }

    activate() {
        this._host.openUri(TRASH_URI);
    }

    openMenu() {
        this._host.openTrashMenu(this);
    }

    /** Ask, then delete everything in the trash for good. */
    confirmEmpty() {
        const _ = this._host.gettext;
        const dialog = new ModalDialog.ModalDialog({ styleClass: 'guava-dock-dialog' });
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Are you sure you want to permanently erase the items in the Trash?'),
            description: _('You can’t undo this action.'),
        }));
        dialog.addButton({ label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape });
        dialog.addButton({
            label: _('Empty Trash'), default: true,
            action: () => {
                dialog.close();
                this._empty().catch(e => console.error('[Guava] dock: emptying the trash failed:', e));
            },
        });
        this.cleanup.add(() => dialog.close());
        dialog.open();
    }

    async _empty() {
        const enumerator = await this._trash.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, this._cancellable);
        for (;;) {
            const infos = await enumerator.next_files_async(BATCH, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (!infos.length)
                break;
            // The trash backend removes a trashed folder with everything in it
            await Promise.all(infos.map(info => this._trash.get_child(info.get_name())
                .delete_async(GLib.PRIORITY_DEFAULT, this._cancellable)));
        }
        this.refresh();
    }

    // ---- drops ----

    handleDragOver(source) {
        if (source?.guavaFile || this._host.canRemove(source))
            return DND.DragMotionResult.MOVE_DROP;
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source) {
        if (source?.guavaFile) {
            source.guavaFile.trash_async(GLib.PRIORITY_DEFAULT, this._cancellable)
                .then(() => this.refresh())
                .catch(e => {
                    if (!cancelled(e))
                        console.error('[Guava] dock: could not move to the trash:', e);
                });
            return true;
        }
        if (this._host.canRemove(source)) {
            this._host.removeFromDock(source, null);
            return true;
        }
        return false;
    }
}
