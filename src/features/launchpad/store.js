// SPDX-License-Identifier: GPL-3.0-or-later
// LaunchpadStore: Launchpad's apps, folders and order, read from and written to GNOME's own
// settings so the Activities app grid and Launchpad never drift:
//
//   folders  org.gnome.desktop.app-folders folder-children, and one relocatable
//            org.gnome.desktop.app-folders.folder per folder (name, translate, apps,
//            categories, excluded-apps) under <path>folders/<id>/
//   order    org.gnome.shell app-picker-layout (aa{sv}: pages of {id: {position: i}})
//
// Writes are the user's own edits (reorder, new folder, rename, take out), made the same way
// GNOME's AppDisplay makes them (js/ui/appDisplay.js createFolder, FolderView.removeApp,
// PageManager.pages, checked on GNOME 50). Unlike the Shell's grid, Launchpad also shows the
// dock's favourites (macOS shows every app); their positions are stored too and the Shell
// simply skips them.
//
// Shell API: Shell.AppSystem get_installed / lookup_app / 'installed-changed',
// Shell.util_get_translated_folder_name, global.settings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {
    addToFolder, buildItems, createFolder, folderMembers, folderNameFor, removeFromFolder,
    serializeLayout,
} from './model.js';

const FOLDERS_SCHEMA = 'org.gnome.desktop.app-folders';
const FOLDER_SCHEMA = 'org.gnome.desktop.app-folders.folder';
const LAYOUT_KEY = 'app-picker-layout';

const splitList = s => String(s ?? '').split(';').filter(Boolean);

export class LaunchpadStore {
    /**
     * @param {object} cleanup CleanupRegistry
     * @param {{gettext: Function, onChanged: Function}} opts onChanged runs (coalesced) when
     *   apps, folders or the order changed outside a write of ours
     */
    constructor(cleanup, { gettext, onChanged }) {
        this._cleanup = cleanup;
        this._ = gettext;
        this._onChanged = onChanged;
        this._appSystem = Shell.AppSystem.get_default();
        this._foldersSettings = new Gio.Settings({ schema_id: FOLDERS_SCHEMA });
        this._folders = new Map();     // id -> {settings, token}
        this._writing = false;
        this._queued = 0;
        this._apps = null;             // cached app descriptions, null when stale

        cleanup.connect(this._appSystem, 'installed-changed', () => {
            this._apps = null;
            this._changed();
        });
        cleanup.connect(this._foldersSettings, 'changed::folder-children', () => {
            this._syncFolders();
            this._changed();
        });
        cleanup.connect(global.settings, `changed::${LAYOUT_KEY}`, () => this._changed());
        cleanup.add(() => {
            for (const f of this._folders.values())
                cleanup.release(f.token);
            this._folders.clear();
        });
        this._syncFolders();
    }

    _changed() {
        if (this._writing || this._queued)
            return;
        this._queued = this._cleanup.idle(() => {
            this._queued = 0;
            this._onChanged();
        }, { name: 'launchpad-store' });
    }

    _syncFolders() {
        const ids = this._foldersSettings.get_strv('folder-children');
        for (const [id, f] of this._folders) {
            if (!ids.includes(id)) {
                this._cleanup.release(f.token);
                this._folders.delete(id);
            }
        }
        for (const id of ids) {
            if (this._folders.has(id))
                continue;
            const settings = this._folderSettings(id);
            const token = this._cleanup.connect(settings, 'changed', () => this._changed());
            this._folders.set(id, { settings, token });
        }
    }

    _folderSettings(id) {
        return new Gio.Settings({ schema_id: FOLDER_SCHEMA, path: `${this._foldersSettings.path}folders/${id}/` });
    }

    /** Is the order writable (a locked key: Launchpad stays read-only, like the Shell's grid). */
    get writable() {
        return global.settings.is_writable(LAYOUT_KEY) && this._foldersSettings.is_writable('folder-children');
    }

    /** Installed apps the Shell would show: {id, name, categories, generic, keywords}. */
    apps() {
        if (!this._apps) {
            this._apps = [];
            for (const info of this._appSystem.get_installed()) {
                let id;
                try {
                    id = info.get_id();  // invalid file encodings throw (as in the Shell)
                } catch (_e) {
                    continue;
                }
                if (!info.should_show() || !this._appSystem.lookup_app(id))
                    continue;
                this._apps.push({
                    id,
                    name: info.get_name() ?? id,
                    categories: splitList(info.get_categories?.()),
                    generic: info.get_generic_name?.() ?? '',
                    keywords: info.get_keywords?.() ?? [],
                });
            }
        }
        return this._apps;
    }

    app(id) {
        return this._appSystem.lookup_app(id);
    }

    _folderName(settings) {
        const name = settings.get_string('name');
        if (settings.get_boolean('translate'))
            return Shell.util_get_translated_folder_name(name) ?? name;
        return name;
    }

    /** One folder as plain values. */
    folder(id) {
        const f = this._folders.get(id);
        if (!f)
            return null;
        const s = f.settings;
        return {
            id,
            name: this._folderName(s) || this._('Untitled Folder'),
            apps: s.get_strv('apps'),
            categories: s.get_strv('categories'),
            excluded: s.get_strv('excluded-apps'),
        };
    }

    /** The top level of the grid, in GNOME's order (model.buildItems). */
    items() {
        const folders = [...this._folders.keys()].map(id => this.folder(id));
        return buildItems(this.apps(), folders, global.settings.get_value(LAYOUT_KEY).recursiveUnpack());
    }

    members(folderId) {
        const f = this.folder(folderId);
        return f ? folderMembers(f, this.apps()) : [];
    }

    _write(fn) {
        this._writing = true;
        try {
            fn();
        } finally {
            this._writing = false;
        }
    }

    /** Store the top-level order (ids) as app-picker-layout pages of perPage. */
    saveOrder(order, perPage) {
        const pages = serializeLayout(order, perPage).map(page => Object.fromEntries(
            Object.entries(page).map(([id, { position }]) =>
                [id, new GLib.Variant('a{sv}', { position: GLib.Variant.new_int32(position) })])));
        this._write(() => global.settings.set_value(LAYOUT_KEY, new GLib.Variant('aa{sv}', pages)));
    }

    /** Two loose apps make a folder in the target's place. Returns the folder id or null. */
    createFolder(order, dragId, targetId, perPage) {
        const id = GLib.uuid_string_random();
        const plan = createFolder(order, dragId, targetId, id);
        if (!plan)
            return null;
        const byId = new Map(this.apps().map(a => [a.id, a]));
        const name = folderNameFor(plan.folder.apps.map(a => byId.get(a)?.categories ?? []));
        this._write(() => {
            const s = this._folderSettings(id);
            s.delay();
            s.set_string('name', name ? this._(name) : this._('Untitled Folder'));
            s.set_boolean('translate', false);
            s.set_strv('apps', plan.folder.apps);
            s.apply();
            this._foldersSettings.set_strv('folder-children',
                [...this._foldersSettings.get_strv('folder-children'), id]);
            this._syncFolders();
        });
        this.saveOrder(plan.order, perPage);
        return id;
    }

    addToFolder(order, folderId, appId, perPage) {
        const f = this.folder(folderId);
        if (!f)
            return;
        const plan = addToFolder(order, f, appId);
        const s = this._folders.get(folderId).settings;
        this._write(() => {
            s.set_strv('apps', plan.apps);
            s.set_strv('excluded-apps', plan.excluded);
        });
        this.saveOrder(plan.order, perPage);
    }

    /** Take an app out of a folder, onto the top level at toIndex (or after the folder). */
    removeFromFolder(order, folderId, appId, toIndex, perPage) {
        const f = this.folder(folderId);
        if (!f)
            return;
        const plan = removeFromFolder(order, f, this.members(folderId), appId, toIndex);
        const s = this._folders.get(folderId).settings;
        this._write(() => {
            if (plan.empty) {
                // Resetting every key removes the relocatable folder (as GNOME does)
                for (const key of s.settings_schema.list_keys())
                    s.reset(key);
                this._foldersSettings.set_strv('folder-children',
                    this._foldersSettings.get_strv('folder-children').filter(id => id !== folderId));
                this._syncFolders();
            } else {
                s.set_strv('apps', plan.apps);
                s.set_strv('excluded-apps', plan.excluded);
            }
        });
        this.saveOrder(plan.order, perPage);
    }

    /** Reorder the apps inside a folder (its own list holds every member then). */
    reorderFolder(folderId, members) {
        const s = this._folders.get(folderId)?.settings;
        if (s)
            this._write(() => s.set_strv('apps', members));
    }

    renameFolder(folderId, name) {
        const s = this._folders.get(folderId)?.settings;
        if (!s)
            return;
        this._write(() => {
            s.set_string('name', name);
            s.set_boolean('translate', false);
        });
    }
}
