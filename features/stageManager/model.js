// SPDX-License-Identifier: GPL-3.0-or-later
// Stage Manager state machine. Pure: no gi imports, no clock, no Shell objects.
// Spec: docs/features/stage-manager.md (SM-n). Tests: tests/stageManagerModel.test.js (scenarios),
// tests/stageManagerFuzz.test.js (random event sequences, invariants after every event).
//
//   const sm = new StageModel({ allAtOnce: true, newWindows: 'replace' });
//   const effects = sm.dispatch({ type: 'add', window: info, now });
//
// Events in, effects out. The adapter (index.js) turns Mutter signals and input into events and
// applies the effects; it also reconciles the real windows against `hiddenIds()` after every
// dispatch, so a missed signal heals on the next event. Time arrives with the events (`now`, ms);
// delays leave as `timer` effects and come back as `timer` events.
//
// Vocabulary
//   window  a plain description: id, appId, type, parent (transient-for id), workspace (-1 = all),
//           monitor, fullscreen, above, skipTaskbar, title, minimized, flagged (another feature
//           set it aside)
//   set     {id, ws, ids}: windows shown and hidden together, most recently focused first
//   space   per workspace: {stage: set id | null, strip: [set id] most recent first, desktop}
//
// The rules every state obeys (checkInvariants() asserts them; the fuzz test runs it each event):
//   - a managed window is in exactly one set, of its own workspace; no set is empty;
//   - a set is the stage of its space or in its strip, never both, never twice;
//   - a managed window is hidden iff its set is not the stage; an attached window (a dialog of a
//     managed window) is hidden iff its root is; every other window is never hidden;
//   - a minimized window is in no set: Stage Manager never hides, shows or minimizes it (SM-8).
//
// Effects (in this order within one dispatch):
//   {type: 'hide', ids, animate}     these windows leave the stage
//   {type: 'show', ids, animate}     these come onto it
//   {type: 'focus', id}              give it the keyboard focus
//   {type: 'strip'}                  the strip's entries changed: redraw
//   {type: 'strip-visible', visible} slide the strip in or out
//   {type: 'desktop', shown}         Show Desktop changed
//   {type: 'timer', key, ms} / {type: 'cancel', key}
//
// No grace period (D-017): a stage emptied by a close or minimize is refilled at once by the most
// recent set; a clicked set takes the stage in the same dispatch.

/** After a switch the model made, focus moving to other sets is not obeyed this long. */
export const QUIET_MS = 300;
/** "Open in current stage" waits this long for the app's window. */
export const JOIN_MS = 10000;
/** The pointer rests on the edge this long to reveal the strip. */
export const DWELL_MS = 150;
/** The revealed strip stays this long after the pointer left it. */
export const LEAVE_MS = 500;
/** Keyboard reveal. */
export const FLASH_MS = 1500;
/** Sets listed in the strip. */
export const MAX_SHOWN = 6;

export const DEFAULT_CONFIG = Object.freeze({
    allAtOnce: true,        // stage-manager-group-by-app
    newWindows: 'replace',  // stage-manager-new-windows: 'replace' | 'join'
    showRecent: true,       // stage-manager-show-recent
    autohide: true,         // stage-manager-autohide
});

const PIP_TITLE = /picture[\s-]*in[\s-]*picture/i;
const FLOATING_APPS = ['org.gnome.NautilusPreviewer'];
const MAX_DEPTH = 16;

/** Why a window is left alone, or null when Stage Manager manages it (SM-7). */
export function exemptReason(w, primary) {
    if (w.type !== 'normal')
        return 'type';
    if (w.workspace === -1)
        return 'sticky';
    if (w.above)
        return 'above';
    if (w.skipTaskbar)
        return 'skip-taskbar';
    if (w.flagged)
        return 'flagged';
    if (w.appId && FLOATING_APPS.some(a => w.appId === a || w.appId === `${a}.desktop`))
        return 'floating';
    if (w.title && PIP_TITLE.test(w.title))
        return 'pip';
    if (w.monitor !== primary)
        return 'monitor';
    return null;
}

export class StageModel {
    constructor(config = {}) {
        this._cfg = { ...DEFAULT_CONFIG, ...config };
        this._win = new Map();      // id -> window description
        this._setOf = new Map();    // managed window id -> set id
        this._sets = new Map();     // set id -> {id, ws, ids}
        this._spaces = new Map();   // ws -> {stage, strip, desktop, stash}
        this._active = 0;
        this._primary = 0;
        this._focus = null;
        this._quietUntil = 0;
        this._join = null;          // {appId, until}
        this._seq = 0;
        this._ui = { overlapped: false, overview: false, revealed: false, atEdge: false, inStrip: false };
        this._shownVisible = true;
        this._hiddenNow = new Set();
        this._out = [];
        this._dirty = false;
        this._animate = true;
    }

    // ---- queries ----------------------------------------------------------------------------

    get activeWorkspace() {
        return this._active;
    }

    /** The set on the stage of a workspace: {id, ids} or null. */
    stage(ws = this._active) {
        const s = this._space(ws).stage;
        return s === null ? null : this._view(this._sets.get(s));
    }

    /** Every set waiting in the strip of a workspace, most recent first. */
    waiting(ws = this._active) {
        return this._space(ws).strip.map(id => this._view(this._sets.get(id)));
    }

    /** The sets the strip lists (at most MAX_SHOWN). */
    strip(ws = this._active) {
        return this.waiting(ws).slice(0, MAX_SHOWN);
    }

    desktopShown(ws = this._active) {
        return this._space(ws).desktop;
    }

    /** Ids of the windows on the stage of a workspace, attached windows included. */
    stageWindows(ws = this._active) {
        const out = [];
        for (const id of this._win.keys()) {
            const root = this._rootId(id);
            const set = this._sets.get(this._setOf.get(root));
            if (set && set.ws === ws && this._space(ws).stage === set.id)
                out.push(id);
        }
        return out;
    }

    /** Ids of every window that must be hidden now. */
    hiddenIds() {
        const out = new Set();
        for (const id of this._win.keys()) {
            const set = this._sets.get(this._setOf.get(this._rootId(id)));
            if (set && this._space(set.ws).stage !== set.id)
                out.add(id);
        }
        return out;
    }

    isManaged(id) {
        return this._setOf.has(id);
    }

    /** Is the strip slid in? */
    get stripVisible() {
        return this._visible();
    }

    // ---- dispatch ---------------------------------------------------------------------------

    dispatch(event) {
        this._out = [];
        this._dirty = false;
        this._animate = true;
        const now = event.now ?? 0;
        switch (event.type) {
        case 'init': this._onInit(event); break;
        case 'config': this._cfg = { ...this._cfg, ...event.config }; this._dirty = true; break;
        case 'monitors': this._primary = event.primary; this._reclassifyAll(now); break;
        case 'workspace': this._active = event.active; this._animate = false; this._dirty = true; break;
        case 'add': this._onAdd(event.window, now); break;
        case 'change': this._onChange(event.window, now); break;
        case 'remove': this._onRemove(event.id, now); break;
        case 'focus': this._onFocus(event.id, now); break;
        case 'activate': this._onActivate(event, now); break;
        case 'cycle': this._onCycle(event.dir, now); break;
        case 'slot': this._onSlot(event.n, now); break;
        case 'unset': this._onUnset(event.id, now, false); break;
        case 'stash': this._onUnset(event.id, now, true); break;
        case 'move-to': this._onMoveTo(event, now); break;
        case 'toggle-desktop': this._onToggleDesktop(now); break;
        case 'join-next': this._join = { appId: event.appId ?? null, until: now + JOIN_MS }; break;
        case 'overlap': this._ui.overlapped = !!event.on; break;
        case 'overview': this._ui.overview = !!event.on; break;
        case 'edge': this._onEdge(event.on); break;
        case 'strip-hover': this._onStripHover(event.on); break;
        case 'push': this._reveal(LEAVE_MS); break;
        case 'timer': this._onTimer(event.key, now); break;
        default: throw new Error(`StageModel: unknown event ${event.type}`);
        }
        this._finish();
        return this._out;
    }

    // ---- events -----------------------------------------------------------------------------

    _onInit({ windows, focus, active, primary }) {
        this._active = active;
        this._primary = primary;
        this._animate = false;
        for (const w of windows)
            this._win.set(w.id, w);
        // Most recent first: the sets end up in that order
        for (const w of windows) {
            if (this._managed(w))
                this._arrive(w.id, { init: true });
        }
        const fw = focus !== null ? this._setOf.get(this._rootId(focus)) : null;
        for (const [ws, space] of this._spaces) {
            const lead = fw && this._sets.get(fw).ws === ws ? fw : space.strip[0];
            if (lead !== undefined && space.stage === null)
                this._promote(this._sets.get(lead));
        }
        this._focus = focus;
        this._dirty = true;
    }

    _onAdd(w, now) {
        this._win.set(w.id, w);
        if (this._managed(w))
            this._arrive(w.id, { now });
    }

    _onChange(w, now) {
        const old = this._win.get(w.id);
        if (!old) {
            this._onAdd(w, now);
            return;
        }
        this._win.set(w.id, w);
        const member = this._setOf.has(w.id);
        const want = this._managed(w, member);
        if (member && (!want || w.workspace !== old.workspace)) {
            this._leave(w.id, now);
            if (want)
                this._arrive(w.id, { now, moved: true });
        } else if (!member && want) {
            // Restored from the Dock (SM-10), or no longer set aside
            this._animate = !w.minimized && old.minimized ? false : this._animate;
            this._arrive(w.id, { now });
        }
    }

    _onRemove(id, now) {
        if (!this._win.has(id))
            return;
        if (this._setOf.has(id))
            this._leave(id, now);
        this._win.delete(id);
        if (this._focus === id)
            this._focus = null;
        // Attached windows of a window that goes away stay visible: their root is unknown
        this._dirty = true;
    }

    _onFocus(id, now) {
        this._focus = id;
        const setId = id === null ? undefined : this._setOf.get(this._rootId(id));
        if (setId === undefined)
            return;
        const set = this._sets.get(setId);
        const root = this._rootId(id);
        if (set.ids[0] !== root)
            set.ids = [root, ...set.ids.filter(x => x !== root)];
        const space = this._space(set.ws);
        if (set.ws !== this._active || (space.stage === setId && !space.desktop))
            return;
        // Mutter's own focus after a close or minimize, or windows raising each other
        if (now < this._quietUntil) {
            if (space.stage !== null)
                this._out.push({ type: 'focus', id: this._lead(space.stage) });
            return;
        }
        this._switchTo(set, now);
    }

    _onActivate({ set: setId, add }, now) {
        const set = this._sets.get(setId);
        if (!set)
            return;
        const space = this._space(set.ws);
        if (add && space.stage !== null && space.stage !== setId && !space.desktop) {
            // Shift-click: the set joins the stage as one set (SM-5)
            const stage = this._sets.get(space.stage);
            stage.ids = [...set.ids, ...stage.ids];
            for (const id of set.ids)
                this._setOf.set(id, stage.id);
            this._drop(set);
            this._dirty = true;
            this._out.push({ type: 'focus', id: this._lead(stage.id) });
            return;
        }
        this._switchTo(set, now);
    }

    _onCycle(dir, now) {
        const strip = this._space(this._active).strip;
        if (strip.length === 0)
            return;
        // Next brings the most recent set, previous the oldest
        this._switchTo(this._sets.get(dir < 0 ? strip[strip.length - 1] : strip[0]), now);
        this._reveal(FLASH_MS);
    }

    _onSlot(n, now) {
        const id = this._space(this._active).strip[n - 1];
        if (id === undefined || n > MAX_SHOWN)
            return;
        this._switchTo(this._sets.get(id), now);
        this._reveal(FLASH_MS);
    }

    // Take a window out of its set into a set of its own, in the strip (SM-24, SM-25)
    _onUnset(id, now, stash) {
        const setId = this._setOf.get(id);
        if (setId === undefined)
            return;
        const set = this._sets.get(setId);
        const space = this._space(set.ws);
        if (set.ids.length > 1) {
            set.ids = set.ids.filter(x => x !== id);
            const own = this._newSet(set.ws, [id]);
            this._setOf.set(id, own.id);
            space.strip.unshift(own.id);
            this._dirty = true;
            if (space.stage === setId)
                this._out.push({ type: 'focus', id: this._lead(setId) });
        } else if (stash && space.stage === setId) {
            space.stage = null;
            space.strip.unshift(setId);
            this._dirty = true;
            this._refill(space, set.ws, now, setId);
        }
    }

    // A window dropped on a thumbnail leaves its set and joins that set (B31)
    _onMoveTo({ id, set: targetId }, now) {
        const srcId = this._setOf.get(id);
        const target = this._sets.get(targetId);
        if (srcId === undefined || !target || srcId === targetId)
            return;
        const src = this._sets.get(srcId);
        if (src.ws !== target.ws)
            return;
        const space = this._space(src.ws);
        src.ids = src.ids.filter(x => x !== id);
        target.ids = [id, ...target.ids];
        this._setOf.set(id, targetId);
        this._dirty = true;
        this._quietUntil = now + QUIET_MS;
        if (src.ids.length > 0) {
            if (space.stage === srcId && src.ws === this._active)
                this._out.push({ type: 'focus', id: this._lead(srcId) });
            return;
        }
        this._drop(src);
        if (space.stage === srcId) {
            space.stage = null;
            this._refill(space, src.ws, now);
        }
    }

    _onToggleDesktop(now) {
        const space = this._space(this._active);
        if (space.desktop) {
            const back = this._sets.get(space.stash) ?? this._sets.get(space.strip[0]);
            space.desktop = false;
            space.stash = null;
            if (back)
                this._switchTo(back, now);
            this._out.push({ type: 'desktop', shown: false });
            return;
        }
        if (space.stage === null)
            return;
        space.stash = space.stage;
        space.strip.unshift(space.stage);
        space.stage = null;
        space.desktop = true;
        this._dirty = true;
        this._out.push({ type: 'desktop', shown: true });
    }

    _onEdge(on) {
        const was = this._ui.atEdge;
        this._ui.atEdge = !!on;
        if (on && !was)
            this._out.push({ type: 'timer', key: 'dwell', ms: DWELL_MS });
        else if (!on && was)
            this._out.push({ type: 'cancel', key: 'dwell' });
        if (!on)
            this._scheduleLeave(LEAVE_MS);
    }

    _onStripHover(on) {
        this._ui.inStrip = !!on;
        if (on)
            this._out.push({ type: 'cancel', key: 'leave' });
        else
            this._scheduleLeave(LEAVE_MS);
    }

    _onTimer(key, now) {
        if (key === 'dwell') {
            if (this._ui.atEdge)
                this._reveal(LEAVE_MS);
        } else if (key === 'leave') {
            if (!this._ui.atEdge && !this._ui.inStrip)
                this._ui.revealed = false;
        }
    }

    // ---- sets -------------------------------------------------------------------------------

    _managed(w, member = false) {
        if (w.minimized || w.parent !== null && w.parent !== undefined)
            return false;
        // A member that goes full screen or Always on Top stays in its set (the Window menu's
        // next toggle must act on the same window); a window that opens that way stays exempt
        const probe = member ? { ...w, above: false } : w;
        return exemptReason(probe, this._primary) === null;
    }

    _reclassifyAll(now) {
        for (const [id, w] of this._win) {
            const member = this._setOf.has(id);
            const want = this._managed(w, member);
            if (member && !want)
                this._leave(id, now);
            else if (!member && want)
                this._arrive(id, { now, moved: true });
        }
    }

    _space(ws) {
        let s = this._spaces.get(ws);
        if (!s) {
            s = { stage: null, strip: [], desktop: false, stash: null };
            this._spaces.set(ws, s);
        }
        return s;
    }

    _newSet(ws, ids) {
        const set = { id: ++this._seq, ws, ids };
        this._sets.set(set.id, set);
        return set;
    }

    _view(set) {
        return { id: set.id, ws: set.ws, windows: [...set.ids] };
    }

    _lead(setId) {
        return this._sets.get(setId)?.ids[0] ?? null;
    }

    // The window a transient belongs to; itself when it has no (known) parent
    _rootId(id) {
        let cur = id;
        for (let i = 0; i < MAX_DEPTH; i++) {
            const p = this._win.get(cur)?.parent;
            if (p === null || p === undefined || !this._win.has(p))
                return cur;
            cur = p;
        }
        return cur;
    }

    _sameApp(ws, appId) {
        if (!appId)
            return null;
        for (const set of this._sets.values()) {
            if (set.ws === ws && set.ids.some(id => this._win.get(id)?.appId === appId))
                return set;
        }
        return null;
    }

    // A managed window appears (map, restore from the Dock, workspace move, no longer set aside)
    _arrive(id, { init = false, moved = false, now = 0 } = {}) {
        const w = this._win.get(id);
        const ws = w.workspace;
        const space = this._space(ws);
        let set = null;
        const join = this._join;
        if (join && now < join.until && (join.appId === null || join.appId === w.appId) && space.stage !== null) {
            set = this._sets.get(space.stage);
            this._join = null;
        } else if (this._cfg.allAtOnce) {
            set = this._sameApp(ws, w.appId);
        }
        if (!set && !init && this._cfg.newWindows === 'join' && space.stage !== null && !moved)
            set = this._sets.get(space.stage);
        if (set) {
            set.ids = [id, ...set.ids];
            this._setOf.set(id, set.id);
        } else {
            set = this._newSet(ws, [id]);
            this._setOf.set(id, set.id);
            space.strip.push(set.id);
        }
        this._dirty = true;
        if (init)
            return;
        if (ws !== this._active || moved) {
            if (space.stage === null && !space.desktop)
                this._promote(set);
            else if (space.stage !== set.id && !space.strip.includes(set.id))
                space.strip.unshift(set.id);
            return;
        }
        this._switchTo(set, now);
    }

    // Take a window out of its set (closed, minimized, left the workspace, now exempt)
    _leave(id, now) {
        const setId = this._setOf.get(id);
        if (setId === undefined)
            return;
        const set = this._sets.get(setId);
        const space = this._space(set.ws);
        this._setOf.delete(id);
        set.ids = set.ids.filter(x => x !== id);
        this._dirty = true;
        if (set.ids.length > 0) {
            if (space.stage === setId && set.ws === this._active) {
                // Mutter focuses its own next window now: keep the focus on the stage
                this._quietUntil = now + QUIET_MS;
                this._out.push({ type: 'focus', id: set.ids[0] });
            }
            return;
        }
        this._drop(set);
        if (space.stage === setId) {
            space.stage = null;
            this._quietUntil = now + QUIET_MS;
            this._refill(space, set.ws, now);
        }
    }

    // A set with no windows left, or merged into another
    _drop(set) {
        const space = this._space(set.ws);
        this._sets.delete(set.id);
        space.strip = space.strip.filter(x => x !== set.id);
        if (space.stash === set.id)
            space.stash = null;
        this._dirty = true;
    }

    _promote(set) {
        const space = this._space(set.ws);
        space.strip = space.strip.filter(x => x !== set.id);
        space.stage = set.id;
        space.desktop = false;
        this._dirty = true;
    }

    // The set becomes the stage; the old stage goes to the front of the strip (SM-2)
    _switchTo(set, now = 0) {
        const space = this._space(set.ws);
        if (space.stage === set.id && !space.desktop) {
            this._out.push({ type: 'focus', id: this._lead(set.id) });
            return;
        }
        const old = space.stage;
        space.strip = space.strip.filter(x => x !== set.id);
        if (old !== null && old !== set.id)
            space.strip.unshift(old);
        space.stage = set.id;
        const wasDesktop = space.desktop;
        space.desktop = false;
        space.stash = null;
        this._quietUntil = now + QUIET_MS;
        this._dirty = true;
        if (wasDesktop)
            this._out.push({ type: 'desktop', shown: false });
        this._out.push({ type: 'focus', id: this._lead(set.id) });
    }

    // An emptied stage is filled at once by the most recent set (not `skip`) when the workspace
    // is the active one; another workspace gets its stage without hide/show effects.
    _refill(space, ws, now, skip = null) {
        if (space.stage !== null || space.desktop)
            return;
        const id = space.strip.find(x => x !== skip);
        if (id === undefined)
            return;
        if (ws === this._active)
            this._switchTo(this._sets.get(id), now);
        else
            this._promote(this._sets.get(id));
    }

    // ---- the strip's visibility (SM-13 to SM-19) --------------------------------------------

    _reveal(hold) {
        this._ui.revealed = true;
        this._scheduleLeave(hold);
    }

    // The revealed strip goes again when the pointer is neither on the edge nor on it
    _scheduleLeave(ms) {
        if (!this._ui.revealed)
            return;
        if (this._ui.atEdge || this._ui.inStrip)
            return;
        this._out.push({ type: 'timer', key: 'leave', ms });
    }

    _fullscreenOnStage() {
        const space = this._space(this._active);
        if (space.stage === null)
            return false;
        return this.stageWindows().some(id => this._win.get(id)?.fullscreen);
    }

    _visible() {
        const u = this._ui;
        if (u.overview || this._fullscreenOnStage())
            return false;
        if (this.strip().length === 0)
            return false;
        if (u.revealed)
            return true;
        return this._cfg.showRecent && !(this._cfg.autohide && u.overlapped);
    }

    // ---- diff -------------------------------------------------------------------------------

    _finish() {
        const hidden = this.hiddenIds();
        const hide = [];
        const show = [];
        for (const id of hidden) {
            if (!this._hiddenNow.has(id))
                hide.push(id);
        }
        for (const id of this._hiddenNow) {
            if (!hidden.has(id) && this._win.has(id))
                show.push(id);
        }
        this._hiddenNow = hidden;
        const out = [];
        if (hide.length)
            out.push({ type: 'hide', ids: hide, animate: this._animate });
        if (show.length)
            out.push({ type: 'show', ids: show, animate: this._animate });
        this._out = [...out, ...this._out];
        if (this._dirty)
            this._out.push({ type: 'strip' });
        const visible = this._visible();
        if (visible !== this._shownVisible) {
            this._shownVisible = visible;
            this._out.push({ type: 'strip-visible', visible });
        }
    }

    // ---- invariants -------------------------------------------------------------------------

    /** Throws when a rule of the header is broken (tests call it after every event). */
    checkInvariants() {
        const seen = new Set();
        for (const [ws, space] of this._spaces) {
            const places = space.stage === null ? [...space.strip] : [space.stage, ...space.strip];
            for (const sid of places) {
                if (seen.has(sid))
                    throw new Error(`set ${sid} in two places`);
                seen.add(sid);
                const set = this._sets.get(sid);
                if (!set)
                    throw new Error(`set ${sid} unknown (workspace ${ws})`);
                if (set.ws !== ws)
                    throw new Error(`set ${sid} of workspace ${set.ws} listed in ${ws}`);
                if (set.ids.length === 0)
                    throw new Error(`set ${sid} is empty`);
            }
        }
        for (const sid of this._sets.keys()) {
            if (!seen.has(sid))
                throw new Error(`set ${sid} is nowhere`);
        }
        const inSets = new Map();
        for (const set of this._sets.values()) {
            for (const id of set.ids) {
                if (inSets.has(id))
                    throw new Error(`window ${id} in two sets`);
                inSets.set(id, set.id);
                if (this._setOf.get(id) !== set.id)
                    throw new Error(`window ${id} index disagrees`);
                const w = this._win.get(id);
                if (!w || w.minimized)
                    throw new Error(`window ${id} is minimized or unknown but in a set`);
                if (w.workspace !== set.ws)
                    throw new Error(`window ${id} of workspace ${w.workspace} in a set of ${set.ws}`);
            }
        }
        if (inSets.size !== this._setOf.size)
            throw new Error('window index has stale entries');
        for (const id of this.hiddenIds()) {
            if (!this._setOf.has(this._rootId(id)))
                throw new Error(`window ${id} hidden but its root is in no set`);
        }
        const strip = this.strip();
        if (strip.length > MAX_SHOWN)
            throw new Error('strip lists too many sets');
        for (const space of this._spaces.values()) {
            if (space.desktop && space.stage !== null)
                throw new Error('desktop shown with a stage');
        }
    }
}
