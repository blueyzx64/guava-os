// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight model: matching, ranking, grouping and keyboard selection. Pure (no gi imports),
// unit-tested in tests/spotlightModel.test.js. The view and the providers only feed it data.
//
// Item shape (what providers return):
//   { id, kind, title, subtitle?, group?, boost?, keywords?[], ...providerData }
//   kind: 'app' | 'setting' | 'action' | 'file' | 'external' | 'clipboard' | 'calc' | 'web'
//         | 'command' (a Guava action) | 'app-action' (a .desktop action) | 'menu' (an app menu item)
//         | 'filter' (a "/" filter suggestion) | 'history' (a past query)
//   External search-provider results other than Files set `group: 'other'`.

export const GROUPS = ['top', 'apps', 'actions', 'menu', 'settings', 'documents', 'clipboard', 'calculator', 'other', 'web'];

/** Fixed order of the sections after the top hit. */
export const GROUP_ORDER = ['apps', 'actions', 'menu', 'settings', 'documents', 'clipboard', 'calculator', 'other', 'web'];

/** Default row limits per section. */
export const GROUP_LIMITS = {
    top: 1, apps: 6, actions: 4, menu: 4, settings: 4, documents: 5, clipboard: 4, calculator: 1, other: 4, web: 1,
};

// A weak match must not become the top hit.
export const TOP_HIT_MIN_SCORE = 400;

const COMBINING = /[̀-ͯ]/g;

/** Lowercase, strip accents, collapse spaces. Cheap enough to run per keystroke. */
export function normalize(text) {
    return String(text ?? '').normalize('NFD').replace(COMBINING, '').toLowerCase()
        .replace(/\s+/g, ' ').trim();
}

/**
 * Score one query token against one already-normalised text.
 * exact 1000 · prefix 800 · word prefix 600 · substring 400 · in-order letters 100-300.
 * Earlier and shorter beats later and longer. -1 means no match.
 */
export function scoreToken(token, text) {
    if (!token)
        return 0;
    if (!text)
        return -1;
    if (text === token)
        return 1000;
    if (text.startsWith(token))
        return 800 - Math.min(text.length - token.length, 100) * 0.5;
    const wordAt = text.indexOf(` ${token}`);
    if (wordAt >= 0)
        return 600 - Math.min(wordAt, 100) * 0.5;
    // word starts across separators: "-", "_", "."
    const sepAt = text.search(new RegExp(`[-_.]${escapeRegExp(token)}`));
    if (sepAt >= 0)
        return 560 - Math.min(sepAt, 100) * 0.5;
    const at = text.indexOf(token);
    if (at >= 0)
        return 400 - Math.min(at, 100) * 0.5;
    return subsequenceScore(token, text);
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Letters in order ("ffx" in "firefox"). Needs 3+ letters so two letters never match noise.
function subsequenceScore(token, text) {
    if (token.length < 3)
        return -1;
    let ti = 0;
    let gaps = 0;
    let last = -1;
    let firstAt = -1;
    for (let i = 0; i < text.length && ti < token.length; i++) {
        if (text[i] !== token[ti])
            continue;
        if (firstAt < 0)
            firstAt = i;
        if (last >= 0 && i !== last + 1)
            gaps++;
        // matching a word start is worth more
        last = i;
        ti++;
    }
    if (ti < token.length)
        return -1;
    return Math.max(100, 300 - gaps * 25 - firstAt * 2 - (text.length - token.length) * 0.5);
}

/**
 * Score a whole query against several fields. Every token must match some field.
 * @param {string} query already normalised or raw
 * @param {string[]} fields searchable strings, most important first
 * @returns {number} -1 for no match
 */
export function scoreFields(query, fields) {
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (tokens.length === 0)
        return 0;
    const norm = fields.map(normalize).filter(Boolean);
    let total = 0;
    for (const token of tokens) {
        let best = -1;
        norm.forEach((field, i) => {
            const s = scoreToken(token, field);
            // later fields (keywords, ids) count a bit less than the title
            const weighted = s < 0 ? -1 : s - Math.min(i, 3) * 40;
            if (weighted > best)
                best = weighted;
        });
        if (best < 0)
            return -1;
        total += best;
    }
    return total / tokens.length;
}

/** Score an item by title, subtitle and keywords. Provider `boost` is added after a match. */
export function scoreItem(query, item) {
    const base = scoreFields(query, [item.title, ...(item.keywords ?? []), item.subtitle ?? '']);
    return base < 0 ? -1 : base + (item.boost ?? 0);
}

/**
 * Filter and sort items for a query, best first. Stable: ties keep provider order, then title.
 * @returns {Array<object>} copies with `score`
 */
export function rank(items, query, limit = Infinity) {
    const out = [];
    items.forEach((item, order) => {
        const score = scoreItem(query, item);
        if (score >= 0)
            out.push({ ...item, score, _order: order });
    });
    out.sort((a, b) => b.score - a.score || a._order - b._order ||
        a.title.localeCompare(b.title));
    for (const o of out)
        delete o._order;
    return Number.isFinite(limit) ? out.slice(0, limit) : out;
}

/** Rank bonus for the n-th most used app (0 = most used). Small: it breaks ties, it never beats a better match. */
export function usageBoost(index) {
    return index < 0 ? 0 : Math.max(0, 40 - index * 4);
}

/** Which section an item belongs to. Providers may set `group` themselves. */
export function groupOf(item) {
    if (item.group && GROUPS.includes(item.group))
        return item.group;
    switch (item.kind) {
    case 'app': return 'apps';
    case 'setting': case 'action': return 'settings';
    case 'command': case 'app-action': return 'actions';
    case 'menu': return 'menu';
    case 'clipboard': return 'clipboard';
    case 'calc': return 'calculator';
    case 'web': return 'web';
    default: return 'documents';
    }
}

/**
 * Build the visible sections from per-group, already ranked items.
 * The best item overall (above the threshold) becomes the Top Hit and leaves its group.
 * A calculator result is the top hit when there is one: it is what the user typed for.
 *
 * @param {Object<string, object[]>} byGroup ranked items keyed by group id
 * @param {{limits?:Object<string,number>, topMin?:number}} [opts]
 * @returns {Array<{id:string, items:object[]}>}
 */
export function buildSections(byGroup, opts = {}) {
    const limits = { ...GROUP_LIMITS, ...(opts.limits ?? {}) };
    const topMin = opts.topMin ?? TOP_HIT_MIN_SCORE;
    const groups = {};
    for (const id of GROUP_ORDER)
        groups[id] = [...(byGroup[id] ?? [])];

    let topId = null;
    if (groups.calculator.length > 0) {
        topId = 'calculator';
    } else {
        let best = topMin - 1;
        for (const id of GROUP_ORDER) {
            if (id === 'web')
                continue;
            const first = groups[id][0];
            if (first && (first.score ?? 0) > best) {
                best = first.score;
                topId = id;
            }
        }
    }

    const sections = [];
    if (topId) {
        sections.push({ id: 'top', items: [groups[topId].shift()] });
    }
    for (const id of GROUP_ORDER) {
        const items = groups[id].slice(0, limits[id]);
        if (items.length > 0)
            sections.push({ id, items });
    }
    return sections;
}

/**
 * Empty query: recent results and searches (search history), the most used apps, and the
 * recent clipboard (only when the caller passes it: it is off by default for privacy).
 */
export function buildEmptySections(recentApps, recentClips, opts = {}) {
    const limits = { recent: 4, history: 3, suggestions: 6, clipboard: 4, ...(opts.limits ?? {}) };
    const sections = [];
    const recent = opts.recent ?? [];
    const history = opts.history ?? [];
    if (recent.length > 0)
        sections.push({ id: 'recent', items: recent.slice(0, limits.recent) });
    if (history.length > 0)
        sections.push({ id: 'history', items: history.slice(0, limits.history) });
    const recentIds = new Set(recent.map(r => r.id));
    const apps = recentApps.filter(a => !recentIds.has(a.id));
    if (apps.length > 0)
        sections.push({ id: 'suggestions', items: apps.slice(0, limits.suggestions) });
    if (recentClips.length > 0)
        sections.push({ id: 'clipboard', items: recentClips.slice(0, limits.clipboard) });
    return sections;
}

// ---- Keyboard selection over sections --------------------------------------

export function flatten(sections) {
    return sections.flatMap(s => s.items);
}

/** Move by `delta` rows; wraps at both ends. Returns the new flat index. */
export function moveSelection(sections, index, delta) {
    const n = flatten(sections).length;
    if (n === 0)
        return -1;
    const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
    return ((from + delta) % n + n) % n;
}

/** Tab: first row of the next section (wraps). Shift+Tab: the previous section. */
export function jumpGroup(sections, index, backwards = false) {
    if (sections.length === 0)
        return -1;
    const starts = [];
    let n = 0;
    for (const s of sections) {
        starts.push(n);
        n += s.items.length;
    }
    let cur = 0;
    for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= index)
            cur = i;
    }
    const next = (cur + (backwards ? -1 : 1) + sections.length) % sections.length;
    return starts[next];
}

/** The section id and the row for a flat index. */
export function locate(sections, index) {
    let i = index;
    for (const s of sections) {
        if (i < s.items.length)
            return i >= 0 ? { section: s.id, item: s.items[i] } : null;
        i -= s.items.length;
    }
    return null;
}

/**
 * Keep the selection on the same item after the sections change (results stream in).
 * Falls back to the first row. The user's own movement is never overridden once they moved:
 * pass `moved=true` to keep `index` when the item vanished.
 */
export function reselect(oldSections, oldIndex, newSections, moved) {
    const cur = locate(oldSections, oldIndex)?.item;
    const flat = flatten(newSections);
    if (flat.length === 0)
        return -1;
    if (cur && moved) {
        const at = flat.findIndex(x => x.id === cur.id);
        if (at >= 0)
            return at;
        return Math.min(Math.max(oldIndex, 0), flat.length - 1);
    }
    return 0;
}

// ---- Web search ---------------------------------------------------------------

export const ENGINES = {
    duckduckgo: 'https://duckduckgo.com/?q=%s',
    google: 'https://www.google.com/search?q=%s',
    bing: 'https://www.bing.com/search?q=%s',
    brave: 'https://search.brave.com/search?q=%s',
    startpage: 'https://www.startpage.com/do/search?q=%s',
    ecosia: 'https://www.ecosia.org/search?q=%s',
};

/**
 * Build the search URL. `engine` is an id from ENGINES or a custom https:// template that
 * contains %s. Anything else falls back to DuckDuckGo. Only https is ever returned.
 * @returns {string|null} null for an empty query
 */
export function webSearchUrl(engine, query) {
    const q = String(query ?? '').trim();
    if (!q)
        return null;
    let template = ENGINES[engine];
    if (!template && typeof engine === 'string' && /^https:\/\/[^\s]+$/.test(engine) &&
        engine.includes('%s'))
        template = engine;
    template ??= ENGINES.duckduckgo;
    return template.replace('%s', () => encodeURIComponent(q));
}

const TLDS = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'edu', 'gov', 'co', 'uk', 'de', 'fr', 'jp',
    'es', 'it', 'nl', 'ru', 'cn', 'in', 'br', 'au', 'ca', 'ch', 'se', 'no', 'fi', 'pl', 'info', 'me', 'tv',
    'xyz', 'ai', 'eu', 'us']);

/**
 * True when the query looks like a web address: it has http(s)://, starts with www., or ends in
 * a well-known top-level domain. "main.py" and "notes.md" are file names, not addresses.
 */
export function looksLikeUrl(query) {
    const q = String(query ?? '').trim();
    if (/^https?:\/\/[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(q))
        return true;
    const m = /^((?:[a-z0-9-]+\.)+)([a-z]{2,})(?:[/?#]\S*)?$/i.exec(q);
    if (!m)
        return false;
    return /^www\./i.test(q) || TLDS.has(m[2].toLowerCase());
}

// ---- Search session ------------------------------------------------------------

/**
 * One search run over several async providers. Results stream in: `onUpdate` is called each
 * time a provider answers. A newer `start()` cancels the previous run and its late answers
 * are dropped. Each provider has its own timeout, and a provider that throws or times out
 * only loses its own results.
 *
 * Providers: `{ id, group?, timeoutMs?, search(query, cancellable) -> Promise<item[]> }`.
 * Environment (injected so the model stays pure):
 *   schedule(ms, fn) -> cancelFn, makeCancellable() -> {cancel(), is_cancelled()}
 */
export class SearchSession {
    constructor({ providers, schedule, makeCancellable, onUpdate, onError, defaultTimeoutMs = 1500 }) {
        this._providers = providers;
        this._schedule = schedule;
        this._makeCancellable = makeCancellable;
        this._onUpdate = onUpdate;
        this._onError = onError ?? (() => {});
        this._defaultTimeout = defaultTimeoutMs;
        this._generation = 0;
        this._cancellable = null;
        this._timers = [];
        this.results = new Map();
        this.pending = new Set();
    }

    /** Swap the provider list (external providers load async). Takes effect on the next start(). */
    setProviders(providers) {
        this._providers = providers;
    }

    get busy() {
        return this.pending.size > 0;
    }

    start(query) {
        this.cancel();
        const generation = ++this._generation;
        this.results = new Map();
        this.pending = new Set();
        const cancellable = this._makeCancellable();
        this._cancellable = cancellable;
        for (const provider of this._providers) {
            this.pending.add(provider.id);
            let settled = false;
            const settle = items => {
                if (settled || generation !== this._generation)
                    return;
                settled = true;
                this.pending.delete(provider.id);
                this.results.set(provider.id, items);
                this._onUpdate(this);
            };
            this._timers.push(this._schedule(provider.timeoutMs ?? this._defaultTimeout, () => {
                if (!settled && generation === this._generation)
                    this._onError(provider.id, new Error('timeout'));
                settle([]);
            }));
            let promise;
            try {
                promise = Promise.resolve(provider.search(query, cancellable));
            } catch (e) {
                promise = Promise.reject(e);
            }
            promise.then(items => settle(Array.isArray(items) ? items : []), e => {
                if (!cancellable.is_cancelled() && generation === this._generation && !settled)
                    this._onError(provider.id, e);
                settle([]);
            });
        }
        if (this._providers.length === 0)
            this._onUpdate(this);
        return generation;
    }

    /** Stop the current run. Late answers are ignored. */
    cancel() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const cancelTimer of this._timers)
            cancelTimer();
        this._timers = [];
        this.pending = new Set();
    }

    /** All items so far, grouped by `groupOf` and ranked for `query`. */
    byGroup(query, limitPerGroup = 12) {
        const grouped = {};
        for (const items of this.results.values()) {
            for (const item of items) {
                const g = groupOf(item);
                (grouped[g] ??= []).push(item);
            }
        }
        for (const g of Object.keys(grouped)) {
            // provider-ranked items (external providers, apps) keep their score; the rest are
            // matched against the query here
            const scored = [];
            grouped[g].forEach((item, order) => {
                const score = typeof item.score === 'number' ? item.score : scoreItem(query, item);
                if (score >= 0)
                    scored.push({ ...item, score, order });
            });
            scored.sort((x, y) => y.score - x.score || x.order - y.order);
            grouped[g] = scored.slice(0, limitPerGroup).map(({ order, ...item }) => item);
        }
        return grouped;
    }
}

// ---- Super tap while open ---------------------------------------------------------

/** A press and release of Super longer than this is a hold, not a tap. */
export const SUPER_TAP_MAX_MS = 400;

/**
 * Decides whether a Super press and release was a bare tap. Anything else seen in between (a key,
 * a key release, a Shell or mutter keybinding such as Super+Space) taints it, and so does holding
 * Super too long. Times are in ms (event times or monotonic, as long as they are consistent).
 */
export class SuperTapTracker {
    constructor(maxMs = SUPER_TAP_MAX_MS) {
        this._maxMs = maxMs;
        this.reset();
    }

    reset() {
        this._down = false;
        this._tainted = false;
        this._at = 0;
    }

    press(time) {
        this._down = true;
        this._tainted = false;
        this._at = time;
    }

    /** Some other key or keybinding happened. */
    other() {
        if (this._down)
            this._tainted = true;
    }

    /** @returns {boolean} true for a bare tap */
    release(time) {
        const tap = this._down && !this._tainted && time >= this._at &&
            time - this._at <= this._maxMs;
        this.reset();
        return tap;
    }
}
