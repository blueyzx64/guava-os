// SPDX-License-Identifier: GPL-3.0-or-later
// Guava dock: the pure decisions (no gi imports). index.js and the views feed it plain values.
//
//   readConfig(get)            settings -> a frozen config object
//   dockItems(...)             what the dock shows, in order (macOS layout)
//   pushRecent / stableOrder   the recent section and a running order that does not jump
//   clickAction / nextWindow   what a click on an app icon does
//   menuEntries                the right-click menu of an app icon
//   dockMetrics                sizes in px for one icon size
//   Reveal                     auto-hide: when the dock shows and hides
//   Downloads stack            downloadEntry, sortDownloads, packageKind, stackView, fanLayout
//   Open at Login              autostartState, autostartText (Guava-marked files only)
//   dropIndex / pinPosition    drag-reorder targets
//   magnify                    magnification: scales and offsets for a pointer position
//   bounceSteps                the launch and attention bounce
//   badgeText                  the red count on an icon
//   folderStack / addFolder    folder stacks kept in the dock
//

export const POSITIONS = Object.freeze(['bottom', 'left', 'right']);
export const STACK_VIEWS = Object.freeze(['automatic', 'fan', 'grid', 'list']);

/** "Show suggested and recent apps in Dock" keeps three apps (macOS). */
export const RECENT_MAX = 3;

/** Icon sizes the Size setting allows (macOS's slider spans about 16..128). */
export const ICON_SIZE_MIN = 24;
export const ICON_SIZE_MAX = 128;

/** Largest magnified icon (macOS's slider ends at about two and a half times the default). */
export const MAGNIFIED_SIZE_MAX = 160;

/** A fan stays readable up to this many files; more open as a grid (macOS "Automatic"). */
export const FAN_MAX = 10;

/** Desktop-entry key that marks an autostart file as Guava's (the only kind Guava removes). */
export const AUTOSTART_MARK = 'X-Guava-Autostart';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isAbsolutePath = p => typeof p === 'string' && p.startsWith('/') && p.length > 1;

/**
 * The dock's config from its settings.
 *
 * @param {{bool: Function, int: Function, string: Function}} get typed getters (GuavaSettings)
 * @returns {object} frozen
 */
export function readConfig(get) {
    const position = get.string('dock-position');
    const view = get.string('dock-downloads-view');
    return Object.freeze({
        position: POSITIONS.includes(position) ? position : 'bottom',
        iconSize: clamp(get.int('dock-icon-size'), ICON_SIZE_MIN, ICON_SIZE_MAX),
        autohide: get.bool('dock-autohide'),
        autohideDelay: Math.max(0, get.int('dock-autohide-delay')),
        showRecents: get.bool('dock-show-recents'),
        runningDots: get.bool('dock-running-dots'),
        minimizeToApp: get.bool('dock-minimize-to-app'),
        downloads: get.bool('dock-downloads'),
        // The Launchpad tile shows while Launchpad itself is on
        launchpad: get.bool('dock-launchpad') && get.bool('launchpad'),
        missionControl: get.bool('dock-mission-control'),
        stackView: STACK_VIEWS.includes(view) ? view : 'automatic',
        magnification: get.bool('dock-magnification'),
        magnifiedSize: clamp(get.int('dock-magnification-size'), ICON_SIZE_MIN, MAGNIFIED_SIZE_MAX),
        launchBounce: get.bool('dock-launch-animation'),
        attentionBounce: get.bool('dock-attention-bounce'),
        badges: get.bool('dock-badges'),
        backgroundApps: get.bool('dock-background-apps'),
        folders: get.strv('dock-folders').filter(isAbsolutePath),
    });
}

/** True for a dock along the bottom edge (icons in a row). */
export const isHorizontal = position => position === 'bottom';

const DOCK_BORDER = 1;   // px, the pill's hairline edge (view.js sets it inline)

/**
 * Sizes for one icon size. The dock floats a small gap off the edge (Big Sur); the claim on the
 * edge includes that gap and the same gap again on the window side, so maximized and tiled
 * windows stop one gap short of the dock.
 *
 * @param {number} iconSize px
 * @returns {{icon, tile, padding, border: DOCK_BORDER, gap, thickness, size, radius, tileRadius, dot}}
 */
export function dockMetrics(iconSize) {
    const icon = clamp(Math.round(iconSize), ICON_SIZE_MIN, ICON_SIZE_MAX);
    const itemPad = Math.max(3, Math.round(icon / 12));
    const tile = icon + 2 * itemPad;
    const padding = Math.max(4, Math.round(icon / 8));
    const gap = Math.max(4, Math.round(icon / 8));
    const thickness = tile + 2 * (padding + DOCK_BORDER);
    const radius = Math.round(thickness * 0.3);
    return Object.freeze({
        icon, tile, padding, border: DOCK_BORDER, gap, thickness,
        size: thickness + 2 * gap,
        radius,
        tileRadius: Math.max(4, radius - padding),
        dot: Math.max(4, Math.round(icon / 12)),
    });
}

/** `prev` order for the ids still in `current`, then the new ones in `current` order. */
export function stableOrder(prev, current) {
    const now = new Set(current);
    const kept = prev.filter(id => now.has(id));
    const seen = new Set(kept);
    return [...kept, ...current.filter(id => !seen.has(id))];
}

/** The recent list with `appId` first (deduplicated, at most `max`). */
export function pushRecent(recents, appId, max = RECENT_MAX) {
    if (!appId)
        return recents;
    return [appId, ...recents.filter(id => id !== appId)].slice(0, max);
}

/**
 * What the dock shows, in order (macOS):
 *   Launchpad | pinned apps | separator | running unpinned and recent apps | separator | minimized
 *   windows, Downloads, Trash
 * With recents off, running unpinned apps follow the pinned ones with no separator.
 *
 * @param {object} p
 * @param {string[]} p.pinned favourites, in order
 * @param {string[]} p.running running app ids, in a stable order
 * @param {string[]} p.recents recent unpinned app ids, newest first
 * @param {boolean} p.showRecents
 * @param {number[]} [p.minimized] window ids that get their own tile
 * @param {boolean} [p.downloads] show the Downloads stack
 * @param {string[]} [p.background] apps running in the background with no window (grey dot)
 * @param {string[]} [p.folders] folder stacks (absolute paths), after Downloads
 * @param {boolean} [p.launchpad] show the Launchpad tile first
 * @returns {object[]} {kind: 'launchpad'|'app'|'separator'|'window'|'downloads'|'folder'|'trash', id, ...}
 *   app items carry `background: true` when only a background process runs
 */
export function dockItems({ pinned, running, recents, showRecents, minimized = [], downloads = true, background = [], folders = [], launchpad = false, missionControl = false }) {
    const items = [];
    if (launchpad)
        items.push({ kind: 'launchpad', id: 'launchpad' });
    const windowed = new Set(running);
    // A background app counts as running (macOS keeps its icon, with a grey indicator)
    running = [...running, ...background.filter(id => !windowed.has(id))];
    const live = new Set(running);
    const pinnedSet = new Set(pinned);
    const bg = id => live.has(id) && !windowed.has(id);
    for (const id of pinned)
        items.push({ kind: 'app', id, section: 'pinned', running: live.has(id), background: bg(id) });
    // Mission Control (optional, off by default) sits with the pinned apps, as the macOS app does
    if (missionControl)
        items.push({ kind: 'mission-control', id: 'mission-control', section: 'pinned' });
    const unpinned = running.filter(id => !pinnedSet.has(id));
    let second = unpinned.map(id => ({ kind: 'app', id, section: 'running', running: true, background: bg(id) }));
    if (showRecents) {
        const closed = recents.filter(id => !live.has(id) && !pinnedSet.has(id))
            .slice(0, Math.max(0, RECENT_MAX - unpinned.length));
        second = [
            ...unpinned.map(id => ({ kind: 'app', id, section: 'recent', running: true, background: bg(id) })),
            ...closed.map(id => ({ kind: 'app', id, section: 'recent', running: false, background: false })),
        ];
        if (second.length && items.length)
            items.push({ kind: 'separator', id: 'separator-recent' });
    }
    items.push(...second);
    items.push({ kind: 'separator', id: 'separator-system' });
    for (const windowId of minimized)
        items.push({ kind: 'window', id: `window-${windowId}`, windowId });
    if (downloads)
        items.push({ kind: 'downloads', id: 'downloads' });
    for (const path of new Set(folders))
        items.push({ kind: 'folder', id: `folder:${path}`, path });
    items.push({ kind: 'trash', id: 'trash' });
    return items;
}

/**
 * The window after `focusedId` in the app's window list (cycling), or the first.
 *
 * @param {{id: number}[]} windows most recently used first
 * @param {?number} focusedId
 * @returns {?number}
 */
export function nextWindow(windows, focusedId) {
    if (!windows.length)
        return null;
    const i = windows.findIndex(w => w.id === focusedId);
    if (i < 0)
        return windows[0].id;
    // MRU order puts the focused window first; cycle to the least recently used one so that
    // repeated clicks visit every window, as GNOME's dash and Dash to Dock do
    return windows[(i + windows.length - 1) % windows.length].id;
}

/**
 * What a click on an app icon does.
 *   - Not running: launch it.
 *   - Middle click: a new window (when the app can open one).
 *   - Running, not in front: bring its most recent window (un-minimizing it).
 *   - In front with one visible window: nothing, as on macOS (a minimized one stays in the
 *     Dock; the user takes it out from there).
 *   - In front with several visible windows: the next visible one (cycle).
 *
 * @param {object} p
 * @param {{id: number, minimized: boolean}[]} p.windows the app's windows, most recent first
 * @param {boolean} p.focused the app owns the focused window
 * @param {?number} p.focusedWindow id of the focused window
 * @param {number} p.button 1 primary, 2 middle
 * @param {boolean} p.canNewWindow
 * @returns {{type: 'launch'|'new-window'|'activate'|'none', windowId?: number}}
 */
export function clickAction({ windows, focused, focusedWindow, button, canNewWindow }) {
    if (button === 2 && canNewWindow)
        return { type: 'new-window' };
    if (!windows.length)
        return { type: 'launch' };
    if (!focused)
        return { type: 'activate', windowId: windows[0].id };
    const visible = windows.filter(w => !w.minimized);
    if (visible.length === 1)
        return { type: 'none' };
    return { type: 'activate', windowId: nextWindow(visible.length ? visible : windows, focusedWindow) };
}

/** Drop separators at the ends and repeated ones. */
function tidy(entries) {
    const out = [];
    for (const e of entries) {
        if (e.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator'))
            continue;
        out.push(e);
    }
    while (out.length && out[out.length - 1].type === 'separator')
        out.pop();
    return out;
}

/**
 * The right-click menu of an app icon (macOS order): open windows; desktop actions; New Window
 * (or Open); Options ▸ Keep in Dock, Open at Login, Show in Files; Show All Windows; Quit (Force Quit
 * with Alt).
 *
 * @param {object} p
 * @param {{id, title, minimized}[]} p.windows
 * @param {?number} p.focusedWindow
 * @param {{id: string, name: string}[]} p.actions desktop actions of the .desktop file
 * @param {boolean} p.canNewWindow
 * @param {boolean} p.pinned
 * @param {boolean} p.hasDesktopFile false for window-backed apps (no file to pin or autostart)
 * @param {{enabled: boolean, editable: boolean}} p.autostart
 * @param {boolean} p.alt Alt (Option) held: Quit becomes Force Quit
 * @param {boolean} [p.background] the app runs only in the background (no window)
 * @param {boolean} [p.showAllWindows] offer "Show All Windows" (App Exposé)
 * @returns {object[]} entries {type, ...}
 */
export function menuEntries({ windows, focusedWindow, actions, canNewWindow, pinned, hasDesktopFile, autostart, alt, background = false, showAllWindows = false }) {
    const running = windows.length > 0;
    const entries = windows.map(w => ({
        type: 'window', id: w.id, title: w.title || '', focused: w.id === focusedWindow, minimized: !!w.minimized,
    }));
    entries.push({ type: 'separator' });
    // An app's own "new-window" action would repeat the New Window item
    const ownNewWindow = running && canNewWindow;
    for (const a of actions.filter(x => !(ownNewWindow && /^new-?window$/i.test(x.id))))
        entries.push({ type: 'action', id: a.id, label: a.name });
    if (running && canNewWindow)
        entries.push({ type: 'new-window' });
    else if (!running)
        entries.push({ type: 'open' });
    entries.push({ type: 'separator' });
    entries.push({
        type: 'options',
        items: [
            { type: 'keep-in-dock', checked: pinned, sensitive: hasDesktopFile },
            { type: 'open-at-login', checked: autostart.enabled, sensitive: hasDesktopFile && autostart.editable },
            { type: 'show-in-files', sensitive: hasDesktopFile },
        ],
    });
    if (running) {
        entries.push({ type: 'separator' });
        // App Exposé, when Mission Control runs
        if (showAllWindows)
            entries.push({ type: 'show-all-windows' });
        entries.push({ type: alt ? 'force-quit' : 'quit' });
    } else if (background) {
        // macOS 27: an app left running in the background can be stopped from its icon
        entries.push({ type: 'separator' });
        entries.push({ type: 'stop-background' });
    }
    return tidy(entries);
}

/**
 * Index at which a dragged item lands among items whose centres (along the dock) are given.
 *
 * @param {number[]} centres in order
 * @param {number} coord pointer position along the dock
 * @returns {number} 0..centres.length
 */
export function dropIndex(centres, coord) {
    let i = 0;
    while (i < centres.length && centres[i] < coord)
        i++;
    return i;
}

/**
 * Favourites position for a drop: dropping anywhere among the apps pins there (macOS: dragging
 * a recent app into the pinned part keeps it). Past the pinned apps means "last pinned".
 *
 * @param {string[]} pinned current favourites without the dragged app
 * @param {number} index dropIndex() over the centres of those pinned apps
 * @returns {number}
 */
export function pinPosition(pinned, index) {
    return clamp(index, 0, pinned.length);
}

// ---- Downloads stack ------------------------------------------------------------------------

const PARTIAL = /\.(part|crdownload|download|partial)$/i;

/** 'rpm' | 'flatpak' | 'appimage' | null: packages get a badge (install flow). */
export function packageKind(name) {
    const n = (name ?? '').toLowerCase();
    if (n.endsWith('.rpm'))
        return 'rpm';
    if (n.endsWith('.flatpakref') || n.endsWith('.flatpak'))
        return 'flatpak';
    if (n.endsWith('.appimage'))
        return 'appimage';
    return null;
}

/**
 * A write to a partial download (.part, .crdownload ...) says nothing about the folder: the
 * browser appends to it many times a second. Only its creation, rename or deletion matters.
 *
 * @param {string} name file name from the monitor
 * @param {boolean} contentWrite true for a plain 'changed' event (data written)
 */
export const isPartialWrite = (name, contentWrite) => contentWrite && PARTIAL.test(name ?? '');

/** Rows a Grid or List builds at a time; more are built as the list scrolls near its end. */
export const STACK_PAGE = 60;

/**
 * One file of the Downloads folder as the stack sees it.
 *
 * @param {{name: string, displayName?: string, hidden?: boolean, backup?: boolean,
 *   changed?: number, created?: number, modified?: number}} info times in seconds
 * @returns {?object} null for files the stack never shows (hidden, backups)
 */
export function downloadEntry(info) {
    if (!info.name || info.hidden || info.backup || info.name.startsWith('.'))
        return null;
    // "Date Added": the moment the file arrived in the folder. A move or rename into the folder
    // sets ctime; birth time when the file was made there; mtime as the last resort.
    const added = Math.max(info.changed ?? 0, info.created ?? 0) || (info.modified ?? 0);
    const partial = PARTIAL.test(info.name);
    return Object.freeze({
        name: info.name,
        label: (info.displayName ?? info.name).replace(PARTIAL, ''),
        added,
        partial,
        badge: partial ? null : packageKind(info.name),
    });
}

/** Newest first (Date Added), names breaking ties so the order is stable. */
export function sortDownloads(entries) {
    return [...entries].sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
}

/**
 * A download that just finished: a file that was partial in `before` and is now final, or a
 * new final file whose partial twin is gone.
 *
 * @param {object[]} before entries
 * @param {object[]} after entries
 * @returns {boolean}
 */
export function downloadFinished(before, after) {
    const partials = new Set(before.filter(e => e.partial).map(e => e.label));
    if (!partials.size)
        return false;
    const stillPartial = new Set(after.filter(e => e.partial).map(e => e.label));
    return after.some(e => !e.partial && partials.has(e.label) && !stillPartial.has(e.label));
}

/**
 * The view a stack opens in. A fan only rises from a bottom dock; Automatic picks the fan for a
 * short stack and the grid otherwise (macOS).
 *
 * @param {string} setting 'automatic' | 'fan' | 'grid' | 'list'
 * @param {string} position dock position
 * @param {number} count files
 * @returns {'fan'|'grid'|'list'}
 */
export function stackView(setting, position, count) {
    const bottom = isHorizontal(position);
    if (setting === 'grid' || setting === 'list')
        return setting;
    if (setting === 'fan')
        return bottom ? 'fan' : 'list';
    return bottom && count <= FAN_MAX ? 'fan' : 'grid';
}

/**
 * Rows of the fan, nearest the dock first: each row a little higher, further right and turned
 * a little more, so the column bends like the macOS fan.
 *
 * @param {number} count rows
 * @param {number} step px between rows
 * @returns {{dx: number, dy: number, angle: number}[]} offsets from the stack icon centre
 *   (dy negative is up), angle in degrees (clockwise)
 */
export function fanLayout(count, step) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        const t = i / Math.max(1, FAN_MAX - 1);
        rows.push({
            dx: Math.round(step * 1.6 * t * t),
            dy: -Math.round(step * (i + 1)),
            angle: Math.round((2 + 10 * t) * 10) / 10,
        });
    }
    return rows;
}

// ---- Open at Login ---------------------------------------------------------------------------

/** The [Desktop Entry] keys of a .desktop text (first group only). */
function entryKeys(text) {
    const keys = new Map();
    let inEntry = false;
    for (const raw of (text ?? '').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            inEntry = line === '[Desktop Entry]';
            continue;
        }
        const eq = line.indexOf('=');
        if (inEntry && eq > 0)
            keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return keys;
}

/**
 * The Open at Login state from the app's autostart file.
 *
 * @param {?string} text the file's contents, null when there is none
 * @returns {{enabled: boolean, guava: boolean, editable: boolean}} editable: Guava may change
 *   it (no file yet, or a file Guava wrote)
 */
export function autostartState(text) {
    if (text === null || text === undefined)
        return { enabled: false, guava: false, editable: true };
    const keys = entryKeys(text);
    const guava = keys.get(AUTOSTART_MARK) === 'true';
    const enabled = keys.get('Hidden') !== 'true' && keys.get('X-GNOME-Autostart-enabled') !== 'false';
    return { enabled, guava, editable: guava };
}

/**
 * The autostart file Guava writes: the app's own desktop entry, marked as Guava's, without the
 * keys that would keep it from starting.
 *
 * @param {string} desktopText the app's .desktop file
 * @returns {string}
 */
export function autostartText(desktopText) {
    const out = [];
    let inEntry = false;
    for (const raw of desktopText.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            inEntry = line === '[Desktop Entry]';
            out.push(raw);
            if (inEntry)
                out.push(`${AUTOSTART_MARK}=true`);
            continue;
        }
        if (inEntry && /^(Hidden|X-GNOME-Autostart-enabled|X-Guava-Autostart)\s*=/.test(line))
            continue;
        out.push(raw);
    }
    return `${out.join('\n').trimEnd()}\n`;
}

// ---- Auto-hide -------------------------------------------------------------------------------

/**
 * When an auto-hiding dock shows. The adapter reports what happens (hover on the edge and on
 * the dock, pressure, its delay timer, things that keep the dock up) and calls settle() once
 * per batch of events, so the leave of one actor and the enter of the next never hide the dock
 * in between. `visible` and `wantsTimer` are what it applies.
 *   - Off: always visible.
 *   - The pointer resting on the screen edge arms the delay; when it fires the dock shows.
 *     Pushing against the edge (pressure) shows it at once.
 *   - It hides as soon as the pointer has left it, unless a menu, a stack or a drag holds it.
 */
export class Reveal {
    constructor(autohide = false) {
        this._autohide = autohide;
        this._shown = false;
        this._edge = false;
        this._hover = false;
        this._holds = 0;
    }

    get visible() {
        return !this._autohide || this._shown;
    }

    /** The adapter should run the reveal delay now (the pointer rests on the edge). */
    get wantsTimer() {
        return this._autohide && !this._shown && this._edge;
    }

    get holds() {
        return this._holds;
    }

    setAutohide(on) {
        this._autohide = on;
        this._shown = false;
    }

    edge(hovered) {
        this._edge = hovered;
    }

    dock(hovered) {
        this._hover = hovered;
    }

    /** The reveal delay ran out, or the pointer pushed against the edge. */
    reveal() {
        if (this._autohide)
            this._shown = true;
    }

    hold() {
        this._holds++;
    }

    unhold() {
        this._holds = Math.max(0, this._holds - 1);
    }

    /** Apply the rules after a batch of inputs. @returns {boolean} visible */
    settle() {
        if (this._shown && !this._hover && !this._edge && this._holds === 0)
            this._shown = false;
        return this.visible;
    }
}

// ---- magnification ---------------------------------------------------------------------------

/** How far the magnification reaches, in tiles from the pointer (macOS: about two icons). */
export const MAGNIFY_REACH = 2.5;

/**
 * Magnification for one pointer position. Each icon grows by a raised-cosine falloff of its
 * rest distance to the pointer (1 + (max - 1) * (1 + cos(pi * d / reach)) / 2, nothing past
 * `reach`); icons stay edge to edge, and the point under the pointer stays where it is.
 * Everything is computed from the rest layout, so the result never feeds back into the input
 * (no jitter). Writes into `out` (preallocated arrays) and allocates nothing.
 *
 * @param {object} p
 * @param {ArrayLike<number>} p.centres rest centres along the dock (px)
 * @param {ArrayLike<number>} p.sizes rest extents along the dock (px)
 * @param {ArrayLike<number>} p.weights 1 for icons, 0 for what does not grow (separators)
 * @param {number} p.count items used from the arrays
 * @param {number} p.pointer the pointer along the dock, same coordinates
 * @param {number} p.tile rest tile size (px)
 * @param {number} p.maxScale scale right under the pointer
 * @param {number} p.amount 0..1, eases the whole effect in and out
 * @param {{scales: number[], offsets: number[], before: number, after: number}} out
 *   offsets: where each centre moves (px, along the dock); before/after: what the row grew
 *   on each side
 * @returns {object} out
 */
export function magnify({ centres, sizes, weights, count, pointer, tile, maxScale, amount }, out) {
    const reach = MAGNIFY_REACH * tile;
    const gain = Math.max(0, maxScale - 1) * clamp(amount, 0, 1);
    let total = 0;
    let shift = 0;
    for (let i = 0; i < count; i++) {
        const d = Math.abs(centres[i] - pointer);
        const s = d < reach ? 1 + gain * weights[i] * (1 + Math.cos(Math.PI * d / reach)) / 2 : 1;
        out.scales[i] = s;
        const extra = (s - 1) * sizes[i];
        // The part of the growth that lies before the pointer pushes the row back
        const start = centres[i] - sizes[i] / 2;
        shift += extra * clamp((pointer - start) / Math.max(1, sizes[i]), 0, 1);
        out.offsets[i] = total + extra / 2;
        total += extra;
    }
    for (let i = 0; i < count; i++)
        out.offsets[i] -= shift;
    out.before = shift;
    out.after = total - shift;
    return out;
}

/** Scale under the pointer for a magnified size (never below 1). */
export const magnifyScale = (iconSize, magnifiedSize) => Math.max(1, magnifiedSize / Math.max(1, iconSize));

// ---- bounce ------------------------------------------------------------------------------------

/** macOS bounces a launching app until it is up, at most this many times. */
export const LAUNCH_BOUNCES_MAX = 10;
/** An app asking for attention bounces this many times, or until it is focused. */
export const ATTENTION_BOUNCES = 3;

/**
 * One bounce of an icon: up with an ease-out, down with an ease-in (a ball's arc).
 *
 * @param {number} tile px
 * @returns {{height: number, up: number, down: number}} px and ms
 */
export function bounceSteps(tile) {
    return { height: Math.round(tile * 0.5), up: 230, down: 260 };
}

/**
 * Whether to bounce again after one bounce ended.
 *
 * @param {'launch'|'attention'} reason
 * @param {number} done bounces finished
 * @param {boolean} pending the app still starts (launch) / still wants attention
 * @returns {boolean}
 */
export function bounceAgain(reason, done, pending) {
    if (!pending)
        return false;
    return done < (reason === 'launch' ? LAUNCH_BOUNCES_MAX : ATTENTION_BOUNCES);
}

// ---- badges ------------------------------------------------------------------------------------

/**
 * The text of a count badge, or null for none (macOS shows big counts in full; Guava caps
 * them so the badge stays a badge).
 *
 * @param {{count: number, countVisible: boolean}} entry
 * @returns {?string}
 */
export function badgeText(entry) {
    if (!entry?.countVisible)
        return null;
    const n = Math.trunc(entry.count);
    if (!(n > 0))
        return null;
    return n > 9999 ? '9999+' : String(n);
}

/** Progress (0..1) to draw, or null for no bar. */
export function badgeProgress(entry) {
    if (!entry?.progressVisible || !Number.isFinite(entry.progress))
        return null;
    return clamp(entry.progress, 0, 1);
}

// ---- folder stacks -----------------------------------------------------------------------------

/**
 * The folder list with `path` added (once, at the end). Downloads already has its own stack.
 *
 * @param {string[]} folders
 * @param {string} path absolute
 * @param {?string} downloadsPath
 * @returns {string[]} the same array when nothing changes
 */
export function addFolder(folders, path, downloadsPath = null) {
    if (!isAbsolutePath(path) || folders.includes(path) || path === downloadsPath)
        return folders;
    return [...folders, path];
}

/** The folder list without `path`. */
export function removeFolder(folders, path) {
    return folders.includes(path) ? folders.filter(f => f !== path) : folders;
}

/**
 * Where a drop along the dock lands: a folder dropped past the system separator makes a
 * stack; elsewhere it is not taken (macOS keeps documents and folders on that side).
 *
 * @param {number} coord drop position along the dock
 * @param {?number} separatorEnd where the system separator ends, same coordinates
 * @returns {boolean}
 */
export function folderDropAccepted(coord, separatorEnd) {
    return separatorEnd !== null && coord >= separatorEnd;
}

/** True when the point lies inside `rect` {x, y, width, height} (a null rect holds nothing). */
export function rectContains(rect, x, y) {
    return !!rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
