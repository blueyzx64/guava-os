// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager state machine. Pure: no gi imports, no clock, no Shell objects
// (tests: tests/stageManagerModel.test.js scenarios, tests/stageManagerFuzz.test.js).
//
//   const sm = new StageMachine({ allAtOnce: true, newWindows: 'replace' });
//   const effects = sm.dispatch({ type: 'add', window: info, now });
//
// Events in, effects out. The Shell adapter (index.js) turns desktop changes and user input
// into events, and only applies the effects it gets back. Time comes in with the events
// (`now`, ms), and delays go out as `timer` effects that come back as `timer` events.
//
// Vocabulary
//   window  a plain description (core/desktopModel.js WindowInfo): id, appId, type, parent,
//           workspace (-1 = on all), monitor, fullscreen, above, skipTaskbar, title, minimized,
//           flagged (another feature set it aside: WindowState 'hidden' or 'splitView')
//   entry   {id, ws, windows: [id] (lead first), set, seq}: windows shown and hidden together.
//           One app's windows (All at Once) or one window (One at a Time), or a set the user
//           built from several apps.
//   space   per workspace: {stage: entry id|null, strip: [entry id] (slot order), desktop}
//
// The rule every state obeys (checkInvariants() asserts it; the fuzz test runs it after
// every event):
//   - a managed window is in exactly one entry, of its own workspace;
//   - it is visible iff its entry is its space's stage;
//   - an attached window (a dialog or other transient) is visible iff its root is;
//   - an exempt window (sticky, always-on-top, skip-taskbar, picture-in-picture, Quick Look,
//     flagged by another feature, an orphan dialog, on another monitor, or full screen when it
//     appeared) is never hidden;
//   - every entry is either the stage or in the strip of its space, never both, and no entry
//     is empty.
//
// Effects (in this order within one dispatch):
//   {type: 'strip', ws}                   the strip of workspace ws changed: redraw it
//   {type: 'tile', left, right}           a new set was built: these windows take the left half of
//                                         the stage, those the right half (before the show flights)
//   {type: 'hide', ids, animate}          these windows leave the stage (fly to their entry)
//   {type: 'show', ids, animate}          these come onto it (fly from their entry), lead last
//   {type: 'unminimize', id}              Mutter minimized it; it lives in the strip instead
//   {type: 'focus', id}                   give it the focus (null: no window has focus)
//   {type: 'desktop', shown}              the active space's desktop was shown or hidden
//   {type: 'timer', key, ms}              send {type: 'timer', key} after ms
//   {type: 'cancel', key}                 forget that timer

/**
 * A stage that empties by a close waits this long for a new window before the next entry
 * comes back (an Open dialog closes before its document window exists).
 * The wait ends early on every signal that settles it: a new window mapping (it takes the
 * stage), a strip click, a shortcut or Show Desktop. No signal can end it the other way:
 * on Wayland an app creates its next window only after the last one is gone, so nothing
 * says "no window is coming". Mutter's own default focus during the wait is held, not obeyed.
 */
export const GRACE_MS = 400;
/** After a switch the model made, focus changes to other entries are ignored this long
 * (Mutter's default focus after a minimize, and windows that raise each other). */
export const QUIET_MS = 300;
/** "Open in current stage" waits this long for the app's window to appear. */
export const JOIN_MS = 10000;

export const DEFAULT_CONFIG = Object.freeze({
    allAtOnce: true,        // stage-manager-group-by-app
    newWindows: 'replace',  // stage-manager-new-windows: 'replace' | 'join'
});

const PIP_TITLE = /picture[\s-]*in[\s-]*picture/i;
// Apps whose windows float over the stage they were opened from: Quick Look (Sushi)
const FLOATING_APPS = ['org.gnome.NautilusPreviewer'];
const MAX_DEPTH = 16;

/** Why a window is left alone, or null when Stage Manager manages it. */
export function exemptReason(w, primary) {
    if (w.workspace === -1)
        return 'sticky';
    if (w.above)
        return 'above';
    if (w.skipTaskbar)
        return 'skip-taskbar';
    if (w.flagged)
        return 'flagged';   // another feature set it aside (Hide, Split View)
    if (w.appId && FLOATING_APPS.some(a => w.appId === a || w.appId === `${a}.desktop`))
        return 'floating';
    if (w.title && PIP_TITLE.test(w.title))
        return 'pip';
    if (w.monitor !== primary)
        return 'monitor';
    return null;
}

export class StageMachine {
    /** @param {object} [config] see DEFAULT_CONFIG */
    constructor(config = {}) {
        this._config = { ...DEFAULT_CONFIG, ...config };
        this._windows = new Map();   // id -> window description
        this._member = new Map();    // managed window id -> entry id
        this._entries = new Map();   // entry id -> entry
        this._spaces = new Map();    // ws -> space
        this._seq = 0;
        this._active = 0;
        this._primary = 0;
        this._join = null;           // {appId} while "open in current stage" is armed
        this._fx = null;
        this._hiddenBefore = null;
    }

    // ---- queries ------------------------------------------------------------------------

    get config() {
        return { ...this._config };
    }

    get activeWorkspace() {
        return this._active;
    }

    /** @returns {?{id, ws, windows, set}} a copy */
    entry(id) {
        const e = this._entries.get(id);
        return e ? { id: e.id, ws: e.ws, windows: [...e.windows], set: e.set } : null;
    }

    /** The entry a managed window is in (null for exempt, attached or unknown windows). */
    entryOf(windowId) {
        return this._member.get(windowId) ?? null;
    }

    /** The stage entry id of a workspace (default the active one). */
    stage(ws = this._active) {
        return this._spaces.get(ws)?.stage ?? null;
    }

    /** All strip entry ids of a workspace, in slot order (also those past the shown count). */
    strip(ws = this._active) {
        return [...(this._spaces.get(ws)?.strip ?? [])];
    }

    /** Every strip entry, in slot order, as copies (the strip scrolls past what fits). */
    shownStrip(ws = this._active) {
        return this.strip(ws).map(id => this.entry(id));
    }

    /** Is the desktop shown on a workspace? */
    desktopShown(ws = this._active) {
        return this._spaces.get(ws)?.desktop ?? false;
    }

    /** Windows on the stage of a workspace (managed ones), lead first. */
    stageWindows(ws = this._active) {
        const e = this._entries.get(this.stage(ws));
        return e ? [...e.windows] : [];
    }

    /** Should this window be hidden now? */
    isHidden(id) {
        const root = this._root(id);
        if (root === null)
            return false;
        const entryId = this._member.get(root);
        if (entryId === undefined)
            return false;
        const e = this._entries.get(entryId);
        return this._spaces.get(e.ws).stage !== entryId;
    }

    /** Every window the model hides. */
    hidden() {
        const out = [];
        for (const id of this._windows.keys()) {
            if (this.isHidden(id))
                out.push(id);
        }
        return out;
    }

    /** 'managed' | 'attached' | 'exempt' | 'unknown' */
    kindOf(id) {
        if (!this._windows.has(id))
            return 'unknown';
        if (this._member.has(id))
            return 'managed';
        return this._root(id) !== null ? 'attached' : 'exempt';
    }

    /** Workspaces the model holds state for. */
    workspaces() {
        return [...this._spaces.keys()];
    }

    // ---- dispatch -----------------------------------------------------------------------

    /**
     * @param {object} event {type, ...}; see the handlers below
     * @returns {object[]} effects
     */
    dispatch(event) {
        this._fx = { strip: new Set(), timers: [], cancels: [], focus: undefined, unminimize: [],
            desktop: null, tile: null, animate: event.animate ?? true };
        this._hiddenBefore = new Set(this.hidden());
        const now = event.now ?? 0;
        const handler = HANDLERS[event.type];
        if (!handler)
            throw new Error(`StageMachine: unknown event '${event.type}'`);
        handler.call(this, event, now);
        return this._flush();
    }

    // ---- event handlers (called through HANDLERS) ----------------------------------------

    _onConfig(e) {
        for (const k of ['newWindows']) {
            if (k in e)
                this._config[k] = e[k];
        }
        for (const ws of this._spaces.keys())
            this._fx.strip.add(ws);
    }

    _onMonitors(e) {
        this._primary = e.primary;
        for (const w of [...this._windows.values()])
            this._reclassify(w.id, e.now ?? 0);
    }

    _onWorkspace(e) {
        if (e.active === this._active)
            return;
        this._active = e.active;
        this._fx.strip.add(e.active);
    }

    // Enable: every window at once, oldest focus first, no motion. `focus` is the focused id.
    _onInit(e) {
        this._fx.animate = false;
        this._primary = e.primary ?? 0;
        this._active = e.active ?? 0;
        // Least recent first, so each later entry pushes the earlier ones down the strip
        for (const w of [...e.windows].reverse())
            this._windows.set(w.id, { ...w });
        for (const w of [...e.windows].reverse()) {
            if (!this._isManagedNow(w))
                continue;
            const entry = this._entryForInit(w);
            entry.windows.unshift(w.id);
            this._member.set(w.id, entry.id);
            if (w.minimized)
                this._fx.unminimize.push(w.id);
            this._switchTo(entry, 'front', { focus: false });
        }
        // The focused window's entry is the stage (it is already, unless focus is elsewhere)
        const root = e.focus !== null && e.focus !== undefined ? this._root(e.focus) : null;
        const entryId = root !== null ? this._member.get(root) : undefined;
        if (entryId !== undefined)
            this._switchTo(this._entries.get(entryId), 'front', { focus: false });
    }

    _onAdd(e, now) {
        if (this._windows.has(e.window.id)) {
            this._onChange({ window: e.window }, now);
            return;
        }
        this._windows.set(e.window.id, { ...e.window });
        if (this._isManagedNow(e.window)) {
            this._arrive(e.window.id, now);
            return;
        }
        // A new dialog of a window in the strip brings that window's entry to the stage, so it
        // is never shown nowhere
        const root = this._root(e.window.id);
        if (root !== null && root !== e.window.id && this.isHidden(e.window.id)) {
            const entry = this._entries.get(this._member.get(root));
            const focus = entry.ws === this._active;
            this._switchTo(entry, 'front', { focus, focusId: e.window.id });
            this._space(entry.ws).quietUntil = now + QUIET_MS;
        }
    }

    _onChange(e, now) {
        const old = this._windows.get(e.window.id);
        if (!old) {
            this._onAdd(e, now);
            return;
        }
        const next = { ...old, ...e.window };
        this._windows.set(next.id, next);
        const id = next.id;
        if (next.minimized && !old.minimized && this._member.has(id)) {
            this._fx.unminimize.push(id);
            this._minimize(id, now);
            return;
        }
        if (this._member.has(id) && next.workspace !== old.workspace && next.workspace !== -1) {
            this._leave(id, now);
            this._arrive(id, now);
            return;
        }
        this._reclassify(id, now);
        if (next.maximized && !old.maximized && this._member.has(id))
            this._splitOnMaximize(id, now);
    }

    _onRemove(e, now) {
        if (!this._windows.has(e.id))
            return;
        if (this._member.has(e.id))
            this._leave(e.id, now, { closed: true });
        this._windows.delete(e.id);
    }

    _onFocus(e, now) {
        if (e.id === null || e.id === undefined)
            return;
        const root = this._root(e.id);
        const entryId = root !== null ? this._member.get(root) : undefined;
        if (entryId === undefined)
            return;
        const entry = this._entries.get(entryId);
        const space = this._space(entry.ws);
        if (space.stage === entry.id) {
            this._toFront(entry, root);
            return;
        }
        const stage = this._entries.get(space.stage);
        if (this._join && stage && (this._join.appId === null || this._join.appId === this._windows.get(root).appId)) {
            // "Open in current stage" on a running app: its window joins the set
            this._join = null;
            this._fx.cancels.push('join');
            this._toFront(entry, root);
            this._merge(entry, stage);
            space.quietUntil = now + QUIET_MS;
            return;
        }
        if (space.graceKey) {
            // The stage emptied a moment ago: Mutter's default focus, wait for a new window
            space.pendingFocus = entry.id;
            return;
        }
        if (now < space.quietUntil) {
            // Not the user: keep the focus on the stage
            this._fx.focus = this._lead(space.stage);
            return;
        }
        this._toFront(entry, root);
        // The window already has the focus (maybe a dialog of the root): do not move it
        this._switchTo(entry, 'front', { focus: false });
        space.quietUntil = now + QUIET_MS;
    }

    // A strip entry was clicked (add: Shift held) or dropped on the stage (add: true)
    _onActivate(e, now) {
        const entry = this._entries.get(e.entry);
        if (!entry)
            return;
        const space = this._space(entry.ws);
        this._cancelGrace(space);
        space.quietUntil = now + QUIET_MS;
        const stage = this._entries.get(space.stage);
        if (e.add && stage && stage !== entry) {
            this._merge(entry, stage);
            this._fx.focus = stage.windows[0];
            return;
        }
        this._switchTo(entry, 'swap');
    }

    // The window controls' minimize, routed here by WindowState.interceptMinimize
    _onMinimize(e, now) {
        if (this._member.has(e.id))
            this._minimize(e.id, now);
    }

    _onRemoveFromSet(e, now) {
        const entryId = this._member.get(e.id);
        if (entryId === undefined)
            return;
        const entry = this._entries.get(entryId);
        if (entry.windows.length < 2)
            return;
        this._split(entry, e.id, now);
    }

    // A stage window dropped on another strip entry joins that entry
    _onMoveToEntry(e, now) {
        const from = this._member.get(e.id);
        const target = this._entries.get(e.entry);
        if (from === undefined || !target || from === target.id || target.ws !== this._entries.get(from).ws)
            return;
        const space = this._space(target.ws);
        this._detach(e.id);
        target.windows.push(e.id);
        this._member.set(e.id, target.id);
        target.set = true;
        this._fx.strip.add(target.ws);
        space.quietUntil = now + QUIET_MS;
        if (space.stage === null)
            this._fx.focus = null;
        else
            this._fx.focus = this._lead(space.stage);
    }

    // The strip entry `dragged` was dropped on the strip entry `target` (`side`: where the
    // dragged windows go): they become one set, open on the stage, and are tiled side by side.
    _onGroup(e, now) {
        const from = this._entries.get(e.dragged);
        const into = this._entries.get(e.target);
        if (!from || !into || from === into || from.ws !== into.ws)
            return;
        const space = this._space(into.ws);
        if (space.stage === from.id || space.stage === into.id)
            return;
        const side = e.side === 'right' ? 'right' : 'left';
        const dragged = [...from.windows];
        const target = [...into.windows];
        space.quietUntil = now + QUIET_MS;
        this._merge(from, into);
        this._switchTo(into, 'swap');
        this._fx.tile = side === 'left' ? { left: dragged, right: target } : { left: target, right: dragged };
    }

    _onToggleDesktop(e, now) {
        const ws = e.ws ?? this._active;
        const space = this._space(ws);
        space.quietUntil = now + QUIET_MS;
        if (space.desktop) {
            const back = this._entries.get(space.desktopPrev) ?? null;
            space.desktop = false;
            space.desktopPrev = null;
            this._fx.desktop = false;
            if (back && back.ws === ws)
                this._switchTo(back, 'swap');
            return;
        }
        this._cancelGrace(space);
        const stage = this._entries.get(space.stage);
        if (stage) {
            space.strip.unshift(stage.id);
            space.stage = null;
            this._fx.strip.add(ws);
        }
        space.desktop = true;
        space.desktopPrev = stage?.id ?? null;
        this._fx.desktop = true;
        this._fx.focus = null;
    }

    // Keyboard: the next or previous entry, in the order the entries were made
    _onCycle(e, now) {
        const space = this._space(this._active);
        const ring = [...this._entries.values()].filter(x => x.ws === this._active)
            .sort((a, b) => a.seq - b.seq);
        if (ring.length === 0)
            return;
        const i = ring.findIndex(x => x.id === space.stage);
        const dir = e.dir < 0 ? -1 : 1;
        const next = i < 0 ? ring[dir > 0 ? 0 : ring.length - 1] : ring[(i + dir + ring.length) % ring.length];
        if (next.id === space.stage)
            return;
        space.quietUntil = now + QUIET_MS;
        this._switchTo(next, 'swap');
    }

    // Keyboard: strip slot n (1-based)
    _onSlot(e, now) {
        const space = this._space(this._active);
        const id = space.strip[e.n - 1];
        if (id === undefined)
            return;
        space.quietUntil = now + QUIET_MS;
        this._switchTo(this._entries.get(id), 'swap');
    }

    // "Open in current stage": the next window (of appId, if given) joins the stage
    _onJoinNext(e) {
        this._join = { appId: e.appId ?? null };
        this._fx.timers.push({ key: 'join', ms: JOIN_MS });
    }

    _onTimer(e) {
        if (e.key === 'join') {
            this._join = null;
            return;
        }
        for (const [ws, space] of this._spaces) {
            if (space.graceKey !== e.key)
                continue;
            space.graceKey = null;
            const pending = this._entries.get(space.pendingFocus);
            space.pendingFocus = null;
            if (space.stage !== null || space.desktop)
                return;
            const next = pending?.ws === ws ? pending : this._entries.get(space.strip[0]);
            if (next)
                this._switchTo(next, 'front', { focus: ws === this._active });
            return;
        }
    }

    // ---- moves ----------------------------------------------------------------------------

    _space(ws) {
        let s = this._spaces.get(ws);
        if (!s) {
            s = { stage: null, strip: [], desktop: false, desktopPrev: null, graceKey: null,
                pendingFocus: null, quietUntil: -Infinity };
            this._spaces.set(ws, s);
        }
        return s;
    }

    _newEntry(ws, windows = []) {
        const e = { id: `e${++this._seq}`, ws, windows, set: false, seq: this._seq };
        this._entries.set(e.id, e);
        return e;
    }

    _lead(entryId) {
        return this._entries.get(entryId)?.windows[0] ?? null;
    }

    // Root of a window: itself when managed or exempt; for an attached window, the managed or
    // exempt window its transient-for chain ends at. null for an orphan transient.
    _root(id) {
        let w = this._windows.get(id);
        for (let depth = 0; w && depth < MAX_DEPTH; depth++) {
            if (this._member.has(w.id))
                return w.id;
            if (w.parent === null || w.parent === undefined)
                return depth === 0 ? null : w.id;
            w = this._windows.get(w.parent);
        }
        return null;
    }

    // A managed window right now: a normal top-level window that is not exempt
    _isManagedNow(w) {
        if (w.type !== 'normal' || (w.parent !== null && w.parent !== undefined))
            return false;
        if (w.fullscreen)
            return false;   // never enters a set while full screen; it arrives when it leaves
        return exemptReason(w, this._primary) === null;
    }

    _reclassify(id, now) {
        const w = this._windows.get(id);
        const member = this._member.has(id);
        // A member that goes full screen stays in its entry (and on its stage)
        const want = member && w.fullscreen && w.type === 'normal' && !w.parent
            ? exemptReason(w, this._primary) === null
            : this._isManagedNow(w);
        if (member && !want)
            this._leave(id, now, {});
        else if (!member && want)
            this._arrive(id, now);
    }

    _entryForInit(w) {
        const space = this._space(w.workspace);
        if (this._config.allAtOnce) {
            const ids = space.stage !== null ? [space.stage, ...space.strip] : space.strip;
            const same = ids.map(id => this._entries.get(id)).find(e => !e.set && this._appOf(e) === w.appId);
            if (same && w.appId)
                return same;
        }
        return this._newEntry(w.workspace);
    }

    _appOf(entry) {
        return this._windows.get(entry.windows[0])?.appId ?? null;
    }

    // A managed window appears (new, moved in from another workspace, or no longer exempt)
    _arrive(id, now) {
        const w = this._windows.get(id);
        if (w.minimized)
            this._fx.unminimize.push(id);
        const space = this._space(w.workspace);
        const stage = this._entries.get(space.stage) ?? null;
        const join = this._join && (this._join.appId === null || this._join.appId === w.appId);
        const inStage = stage && !space.desktop;
        let target = null;
        if (join && inStage) {
            target = stage;
            this._join = null;
            this._fx.cancels.push('join');
        } else if (this._config.allAtOnce && w.appId) {
            if (inStage && stage.windows.some(x => this._windows.get(x)?.appId === w.appId))
                target = stage;
            else
                target = space.strip.map(x => this._entries.get(x)).find(e => !e.set && this._appOf(e) === w.appId) ?? null;
        }
        if (!target && this._config.newWindows === 'join' && inStage)
            target = stage;
        if (target) {
            const mixed = target.windows.some(x => this._windows.get(x)?.appId !== w.appId);
            target.windows.unshift(id);
            this._member.set(id, target.id);
            if (mixed)
                target.set = true;
            if (target === stage) {
                this._fx.focus = w.workspace === this._active ? id : this._fx.focus;
                this._fx.strip.add(w.workspace);
                return;
            }
            this._switchTo(target, 'front', { focus: w.workspace === this._active, focusId: id });
            space.quietUntil = now + QUIET_MS;
            return;
        }
        const entry = this._newEntry(w.workspace, [id]);
        this._member.set(id, entry.id);
        this._switchTo(entry, 'front', { focus: w.workspace === this._active });
        space.quietUntil = now + QUIET_MS;
    }

    // Take a managed window out of its entry (dropping an empty entry). Returns the entry.
    _detach(id) {
        const entry = this._entries.get(this._member.get(id));
        this._member.delete(id);
        entry.windows = entry.windows.filter(x => x !== id);
        if (entry.windows.length < 2)
            entry.set = false;
        const space = this._space(entry.ws);
        this._fx.strip.add(entry.ws);
        if (entry.windows.length === 0) {
            this._entries.delete(entry.id);
            space.strip = space.strip.filter(x => x !== entry.id);
            if (space.stage === entry.id)
                space.stage = null;
            if (space.desktopPrev === entry.id)
                space.desktopPrev = null;
            if (space.pendingFocus === entry.id)
                space.pendingFocus = null;
        }
        return entry;
    }

    // A managed window goes away (closed, moved to another workspace, became exempt)
    _leave(id, now, { closed = false } = {}) {
        const ws = this._entries.get(this._member.get(id)).ws;
        const wasStage = this._space(ws).stage === this._member.get(id);
        const entry = this._detach(id);
        const space = this._space(ws);
        if (!wasStage)
            return;
        if (space.stage === entry.id) {
            if (closed)
                this._fx.focus = entry.windows[0];
            return;
        }
        if (!space.desktop) {
            // The stage emptied: wait a moment for a new window (an Open dialog's document)
            this._cancelGrace(space);
            space.graceKey = `empty:${entry.ws}:${++this._seq}`;
            space.pendingFocus = null;
            this._fx.timers.push({ key: space.graceKey, ms: GRACE_MS });
        }
    }

    _cancelGrace(space) {
        if (!space.graceKey)
            return;
        this._fx.cancels.push(space.graceKey);
        space.graceKey = null;
        space.pendingFocus = null;
    }

    // Put an entry on its space's stage. 'swap': the old stage takes the strip slot the entry
    // leaves; 'front': the old stage goes to the top of the strip.
    _switchTo(entry, placement, { focus = true, focusId = null } = {}) {
        const space = this._space(entry.ws);
        this._cancelGrace(space);
        if (space.desktop) {
            space.desktop = false;
            space.desktopPrev = null;
            if (entry.ws === this._active)
                this._fx.desktop = false;
        }
        if (focus)
            this._fx.focus = focusId ?? entry.windows[0];
        if (space.stage === entry.id)
            return;
        const old = space.stage;
        const slot = space.strip.indexOf(entry.id);
        if (slot >= 0)
            space.strip.splice(slot, 1);
        if (old !== null) {
            if (placement === 'swap' && slot >= 0)
                space.strip.splice(slot, 0, old);
            else
                space.strip.unshift(old);
        }
        space.stage = entry.id;
        this._fx.strip.add(entry.ws);
    }

    _toFront(entry, id) {
        const i = entry.windows.indexOf(id);
        if (i > 0) {
            entry.windows.splice(i, 1);
            entry.windows.unshift(id);
            this._fx.strip.add(entry.ws);
        }
    }

    // Add the windows of `from` to `into` (a set), on top
    _merge(from, into) {
        const space = this._space(from.ws);
        into.windows = [...from.windows, ...into.windows];
        for (const id of from.windows)
            this._member.set(id, into.id);
        into.set = true;
        this._entries.delete(from.id);
        space.strip = space.strip.filter(x => x !== from.id);
        if (space.desktopPrev === from.id)
            space.desktopPrev = null;
        this._fx.strip.add(from.ws);
    }

    // One window leaves its entry for a new entry of its own at the top of the strip
    _split(entry, id, now) {
        const space = this._space(entry.ws);
        this._detach(id);
        const own = this._newEntry(entry.ws, [id]);
        this._member.set(id, own.id);
        const at = space.strip.indexOf(entry.id);
        space.strip.splice(at < 0 ? 0 : at + 1, 0, own.id);
        space.quietUntil = now + QUIET_MS;
        if (space.stage === entry.id)
            this._fx.focus = entry.windows[0];
    }

    // A window of the set on the stage was maximized: it stays on the stage alone, and the
    // others leave for the strip as one entry of their own. Unmaximizing does not regroup.
    _splitOnMaximize(id, now) {
        const entry = this._entries.get(this._member.get(id));
        const space = this._space(entry.ws);
        if (space.stage !== entry.id || entry.windows.length < 2)
            return;
        const others = entry.windows.filter(x => x !== id);
        const own = this._newEntry(entry.ws, others);
        own.set = entry.set && others.length > 1;
        for (const x of others)
            this._member.set(x, own.id);
        entry.windows = [id];
        entry.set = false;
        space.strip.unshift(own.id);
        space.quietUntil = now + QUIET_MS;
        this._fx.strip.add(entry.ws);
        this._fx.focus = id;
    }

    // Minimize: the window goes to the strip. Alone on the stage, its whole entry goes and the
    // stage stays empty (the desktop and the strip show); in a set, it gets its own entry.
    _minimize(id, now) {
        const entry = this._entries.get(this._member.get(id));
        const space = this._space(entry.ws);
        if (space.stage !== entry.id)
            return;
        space.quietUntil = now + QUIET_MS;
        if (entry.windows.length > 1) {
            this._split(entry, id, now);
            return;
        }
        this._cancelGrace(space);
        space.strip.unshift(entry.id);
        space.stage = null;
        this._fx.strip.add(entry.ws);
        this._fx.focus = null;
    }

    // ---- effects ----------------------------------------------------------------------------

    _flush() {
        const fx = this._fx;
        const out = [];
        for (const ws of fx.strip)
            out.push({ type: 'strip', ws });
        if (fx.tile)
            out.push({ type: 'tile', ...fx.tile });
        const after = new Set(this.hidden());
        const hide = [...after].filter(id => !this._hiddenBefore.has(id));
        const show = [...this._hiddenBefore].filter(id => !after.has(id) && this._windows.has(id));
        if (hide.length)
            out.push({ type: 'hide', ids: hide, animate: fx.animate });
        if (show.length) {
            // Back to front: the lead of its entry last, so it ends on top
            const rank = id => {
                const e = this._entries.get(this._member.get(this._root(id)));
                return e ? -e.windows.indexOf(this._root(id)) : 0;
            };
            show.sort((a, b) => rank(a) - rank(b));
            out.push({ type: 'show', ids: show, animate: fx.animate });
        }
        for (const id of fx.unminimize)
            out.push({ type: 'unminimize', id });
        if (fx.focus !== undefined)
            out.push({ type: 'focus', id: fx.focus });
        if (fx.desktop !== null)
            out.push({ type: 'desktop', shown: fx.desktop });
        for (const key of fx.cancels)
            out.push({ type: 'cancel', key });
        for (const t of fx.timers)
            out.push({ type: 'timer', key: t.key, ms: t.ms });
        this._fx = null;
        this._hiddenBefore = null;
        return out;
    }

    // ---- invariants (tests) -----------------------------------------------------------------

    /** @returns {string[]} broken rules, [] when the state is sound */
    checkInvariants() {
        const bad = [];
        const seen = new Map();
        for (const [ws, space] of this._spaces) {
            const ids = space.stage !== null ? [space.stage, ...space.strip] : [...space.strip];
            if (new Set(ids).size !== ids.length)
                bad.push(`ws${ws}: an entry is listed twice`);
            for (const id of ids) {
                const e = this._entries.get(id);
                if (!e)
                    bad.push(`ws${ws}: unknown entry ${id}`);
                else if (e.ws !== ws)
                    bad.push(`${id} listed on ws${ws} but belongs to ws${e.ws}`);
                seen.set(id, (seen.get(id) ?? 0) + 1);
            }
            if (space.desktop && space.stage !== null)
                bad.push(`ws${ws}: desktop shown with a stage`);
        }
        for (const [id, e] of this._entries) {
            if (seen.get(id) !== 1)
                bad.push(`${id} is listed ${seen.get(id) ?? 0} times`);
            if (e.windows.length === 0)
                bad.push(`${id} is empty`);
            if (e.set && e.windows.length < 2)
                bad.push(`${id} is a set of one`);
            for (const w of e.windows) {
                if (this._member.get(w) !== id)
                    bad.push(`window ${w} in ${id} but member of ${this._member.get(w)}`);
                const info = this._windows.get(w);
                if (!info)
                    bad.push(`window ${w} in ${id} is gone`);
                else if (info.workspace !== e.ws)
                    bad.push(`window ${w} on ws${info.workspace} in ${id} of ws${e.ws}`);
            }
        }
        for (const [w, entryId] of this._member) {
            if (!this._entries.get(entryId)?.windows.includes(w))
                bad.push(`window ${w} points at ${entryId} which does not hold it`);
        }
        for (const [id, w] of this._windows) {
            const kind = this.kindOf(id);
            if (kind === 'managed' && !this._isManagedNow(w) && !w.fullscreen)
                bad.push(`window ${id} managed but should not be`);
            if (kind === 'exempt' && this.isHidden(id))
                bad.push(`exempt window ${id} hidden`);
            if (kind !== 'managed' && kind !== 'attached' && this._isManagedNow(w))
                bad.push(`window ${id} should be managed`);
        }
        return bad;
    }
}

const HANDLERS = Object.freeze({
    'config': StageMachine.prototype._onConfig,
    'monitors': StageMachine.prototype._onMonitors,
    'workspace': StageMachine.prototype._onWorkspace,
    'init': StageMachine.prototype._onInit,
    'add': StageMachine.prototype._onAdd,
    'change': StageMachine.prototype._onChange,
    'remove': StageMachine.prototype._onRemove,
    'focus': StageMachine.prototype._onFocus,
    'activate': StageMachine.prototype._onActivate,
    'minimize': StageMachine.prototype._onMinimize,
    'remove-from-set': StageMachine.prototype._onRemoveFromSet,
    'move-to-entry': StageMachine.prototype._onMoveToEntry,
    'group': StageMachine.prototype._onGroup,
    'toggle-desktop': StageMachine.prototype._onToggleDesktop,
    'cycle': StageMachine.prototype._onCycle,
    'slot': StageMachine.prototype._onSlot,
    'join-next': StageMachine.prototype._onJoinNext,
    'timer': StageMachine.prototype._onTimer,
});
