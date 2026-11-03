// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight query model: browse views, "/" filters, Quick Keys, search history, recent
// results, grid navigation and the LocalSearch (SPARQL) file query. Pure (no gi imports),
// unit-tested in tests/spotlightQuery.test.js.
//
//   parseQuery('/pdf tax', { available })  -> { raw, text: 'tax', filter: {id: 'pdf', ...} }
//   parseQuery('/pd', { available })       -> { raw, text: '', filter: null, suggest: [pdf] }
//   quickKeyHit(parseQuickKeys(['sd=action:show-desktop']), 'sd')  -> { targets, args }
//   pushHistory(['a'], 'b')                 -> ['b', 'a']
//   fileQuery({ text: 'tax', filter })      -> { sparql, bindings: { q0: 'tax' } }

const N_ = s => s;

// ---- browse views ------------------------------------------------------------------------

/** Tahoe's four browse views, in Super+1..4 order. */
export const VIEWS = Object.freeze([
    { id: 'apps', title: N_('Applications'), icon: 'view-app-grid-symbolic' },
    { id: 'files', title: N_('Files'), icon: 'folder-symbolic' },
    { id: 'actions', title: N_('Actions'), icon: 'system-run-symbolic' },
    { id: 'clipboard', title: N_('Clipboard'), icon: 'edit-paste-symbolic' },
]);

/** Super+digit: the view id for 1..4, or null. */
export function viewForDigit(digit) {
    return VIEWS[digit - 1]?.id ?? null;
}

/** Clicking or pressing the shortcut of the open view closes it again. */
export function toggleView(current, wanted) {
    return current === wanted ? null : wanted;
}

// ---- "/" filters ---------------------------------------------------------------------------

/**
 * Slash filters. `groups` are the result groups the filter keeps; `files` asks LocalSearch for
 * files whose MIME type is in `mime` or starts with one of `mimePrefix` (none: every file).
 * `needs` names a capability the adapter must report in `available` ('menu', 'clipboard',
 * 'files'); filters without it are always on.
 */
export const FILTERS = Object.freeze([
    { id: 'apps', aliases: ['apps', 'applications', 'app'], label: N_('Applications'), groups: ['apps'] },
    { id: 'files', aliases: ['files', 'file'], label: N_('Files'), groups: ['documents'], needs: 'files', files: {} },
    { id: 'folders', aliases: ['folders', 'folder'], label: N_('Folders'), groups: ['documents'], needs: 'files', files: { mime: ['inode/directory'] } },
    { id: 'documents', aliases: ['documents', 'docs'], label: N_('Documents'), groups: ['documents'], needs: 'files',
        files: { mime: ['application/msword', 'application/rtf', 'application/x-abiword'],
            mimePrefix: ['text/', 'application/vnd.oasis.opendocument', 'application/vnd.openxmlformats', 'application/vnd.ms-'] } },
    { id: 'pdf', aliases: ['pdf'], label: N_('PDF'), groups: ['documents'], needs: 'files', files: { mime: ['application/pdf'] } },
    { id: 'images', aliases: ['images', 'image', 'photos', 'pictures'], label: N_('Images'), groups: ['documents'], needs: 'files', files: { mimePrefix: ['image/'] } },
    { id: 'music', aliases: ['music', 'audio'], label: N_('Music'), groups: ['documents'], needs: 'files', files: { mimePrefix: ['audio/'] } },
    { id: 'videos', aliases: ['videos', 'video', 'movies'], label: N_('Videos'), groups: ['documents'], needs: 'files', files: { mimePrefix: ['video/'] } },
    { id: 'actions', aliases: ['actions', 'action'], label: N_('Actions'), groups: ['actions'] },
    { id: 'settings', aliases: ['settings'], label: N_('Settings'), groups: ['settings'] },
    { id: 'clipboard', aliases: ['clipboard'], label: N_('Clipboard'), groups: ['clipboard'], needs: 'clipboard' },
    { id: 'menu', aliases: ['menu', 'menus'], label: N_('Menu Items'), groups: ['menu'], needs: 'menu' },
]);

const FILTER_RE = /^\/(\S*)(?:\s+([\s\S]*))?$/;

function usable(filter, available) {
    return !filter.needs || !!available?.has?.(filter.needs);
}

/** The filter with this id (for chips and Tab-to-scope), or null. */
export function filterById(id) {
    return FILTERS.find(f => f.id === id) ?? null;
}

/**
 * Filters whose alias starts with `token`, in table order; each once.
 * @param {string} token what follows the slash
 * @param {Set<string>} available capabilities
 */
export function filterSuggestions(token, available) {
    const t = String(token ?? '').toLowerCase();
    return FILTERS.filter(f => usable(f, available) && f.aliases.some(a => a.startsWith(t)));
}

/**
 * Split the field's text into an optional filter and the search text.
 * A filter applies once its alias is typed in full ("/pdf" or "/pdf tax"); while the alias is
 * still being typed ("/pd") the matching filters are offered as suggestions.
 *
 * @param {string} raw the field's text
 * @param {{available?: Set<string>}} [opts]
 * @returns {{raw:string, text:string, filter:?object, suggest:?object[]}}
 */
export function parseQuery(raw, { available = new Set() } = {}) {
    const trimmed = String(raw ?? '').replace(/^\s+/, '');
    const out = { raw: trimmed.trim(), text: trimmed.trim(), filter: null, suggest: null };
    const m = FILTER_RE.exec(trimmed);
    if (!m)
        return out;
    const token = m[1].toLowerCase();
    const filter = FILTERS.find(f => usable(f, available) && f.aliases.includes(token));
    if (filter) {
        out.filter = filter;
        out.text = (m[2] ?? '').trim();
        return out;
    }
    // "/pd" is a filter being typed; "/usr/bin" is a path to search for
    if (m[2] === undefined && /^[a-z]*$/.test(token)) {
        out.text = '';
        out.suggest = filterSuggestions(token, available);
    }
    return out;
}

/** Field text that applies a filter, ready for the user to type the search after it. */
export function filterText(filter, rest = '') {
    return `/${filter.aliases[0]} ${rest}`.replace(/\s+$/, ' ');
}

// ---- LocalSearch (Tracker 3) file query ------------------------------------------------------

const MAX_TOKENS = 4;

function sparqlString(s) {
    return `"${String(s).replace(/[\\"]/g, c => `\\${c}`).replace(/\n/g, '\\n')}"`;
}

/**
 * The SPARQL for a file search over LocalSearch (org.freedesktop.LocalSearch3). File names
 * are matched per word through bound parameters (~q0..~q3), never pasted into the query; the
 * MIME types come from FILTERS only. An empty text lists the most recently modified files.
 *
 * @param {{text?:string, filter?:?object, limit?:number}} opts
 * @returns {{sparql:string, bindings:Object<string,string>}}
 */
export function fileQuery({ text = '', filter = null, limit = 30 } = {}) {
    const tokens = normalizeWords(text).slice(0, MAX_TOKENS);
    const bindings = {};
    const where = [];
    tokens.forEach((t, i) => {
        bindings[`q${i}`] = t;
        where.push(`FILTER (CONTAINS(LCASE(?name), ~q${i}))`);
    });
    const spec = filter?.files ?? {};
    const tests = [
        ...(spec.mime ?? []).map(m => `?mime = ${sparqlString(m)}`),
        ...(spec.mimePrefix ?? []).map(p => `STRSTARTS(?mime, ${sparqlString(p)})`),
    ];
    if (tests.length > 0)
        where.push(`FILTER (${tests.join(' || ')})`);
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    const sparql = [
        'SELECT DISTINCT ?url ?name ?mime ?modified WHERE {',
        '  GRAPH tracker:FileSystem {',
        '    ?file a nfo:FileDataObject ; nie:url ?url ; nfo:fileName ?name ;',
        '          nfo:fileLastModified ?modified ; nie:dataSource/tracker:available true .',
        '  }',
        '  ?content nie:isStoredAs ?file ; nie:mimeType ?mime .',
        ...where.map(w => `  ${w}`),
        `} ORDER BY DESC(?modified) LIMIT ${n}`,
    ].join('\n');
    return { sparql, bindings };
}

function normalizeWords(text) {
    return String(text ?? '').normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Score a file row: name matches beat recency; newer files break ties. `rank` is the row's
 * position in the LocalSearch answer (newest first).
 */
export function fileScore(name, text, rank) {
    const n = String(name ?? '').toLowerCase();
    const q = normalizeWords(text).join(' ');
    let base = 300;
    if (q && n === q)
        base = 900;
    else if (q && n.startsWith(q))
        base = 700;
    else if (q && n.includes(q))
        base = 500;
    return base - Math.min(rank, 100);
}

/** A home-relative folder for the subtitle: file:///home/u/Docs/a.pdf -> ~/Docs. */
export function displayFolder(uri, home) {
    let path;
    try {
        path = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
    } catch (e) {
        path = String(uri).replace(/^file:\/\//, '');
    }
    const dir = path.replace(/\/[^/]*\/?$/, '') || '/';
    if (home && (dir === home || dir.startsWith(`${home}/`)))
        return `~${dir.slice(home.length)}`;
    return dir;
}

// ---- Quick Keys ------------------------------------------------------------------------------

/** macOS: 1-12 lowercase letters and digits. */
export const QUICK_KEY_RE = /^[a-z0-9]{1,12}$/;
const TARGET_RE = /^(action|app):[A-Za-z0-9._:-]+$/;

export function validAlias(alias) {
    return QUICK_KEY_RE.test(String(alias ?? ''));
}

export function validTarget(target) {
    return TARGET_RE.test(String(target ?? ''));
}

/**
 * Read the spotlight-quick-keys strings ("alias=target"). Invalid entries are dropped, and an
 * alias may name several targets (macOS lists every action that shares a key).
 * @returns {{alias:string, target:string}[]}
 */
export function parseQuickKeys(strv) {
    const out = [];
    const seen = new Set();
    for (const s of strv ?? []) {
        const at = String(s).indexOf('=');
        if (at <= 0)
            continue;
        const alias = String(s).slice(0, at).trim().toLowerCase();
        const target = String(s).slice(at + 1).trim();
        const key = `${alias}=${target}`;
        if (!validAlias(alias) || !validTarget(target) || seen.has(key))
            continue;
        seen.add(key);
        out.push({ alias, target });
    }
    return out;
}

export function serializeQuickKeys(list) {
    return parseQuickKeys(list.map(({ alias, target }) => `${alias}=${target}`))
        .map(({ alias, target }) => `${alias}=${target}`);
}

/** Add (or keep) one alias -> target pair. */
export function addQuickKey(strv, alias, target) {
    return serializeQuickKeys([...parseQuickKeys(strv), { alias: String(alias).toLowerCase(), target }]);
}

export function removeQuickKey(strv, alias, target) {
    return serializeQuickKeys(parseQuickKeys(strv).filter(q => !(q.alias === alias && q.target === target)));
}

/**
 * The targets of the quick key typed as the query's first word, and the words after it (an
 * action's parameter: "tm 5" with tm -> timer).
 * @returns {?{alias:string, targets:string[], args:string}}
 */
export function quickKeyHit(list, query) {
    const words = String(query ?? '').trim().split(/\s+/);
    const first = (words[0] ?? '').toLowerCase();
    if (!first)
        return null;
    const targets = list.filter(q => q.alias === first).map(q => q.target);
    if (targets.length === 0)
        return null;
    return { alias: first, targets, args: words.slice(1).join(' ') };
}

// ---- search history ------------------------------------------------------------------------

export const HISTORY_MAX = 50;
export const RECENT_MAX = 12;

/** The query goes to the front; a repeat moves up instead of being added twice. */
export function pushHistory(list, query, max = HISTORY_MAX) {
    const q = String(query ?? '').trim();
    if (!q)
        return [...(list ?? [])].slice(0, max);
    const lower = q.toLowerCase();
    return [q, ...(list ?? []).filter(x => String(x).toLowerCase() !== lower)].slice(0, max);
}

/**
 * Walk the history with Up/Down in the field, like a shell.
 * `index` -1 is the live (empty) field; Up goes to older queries, Down back toward the field.
 * @returns {{index:number, text:string}}
 */
export function historyStep(list, index, direction) {
    const n = list?.length ?? 0;
    if (n === 0)
        return { index: -1, text: '' };
    const next = Math.max(-1, Math.min(n - 1, index + (direction < 0 ? 1 : -1)));
    return { index: next, text: next < 0 ? '' : list[next] };
}

const RECENT_KINDS = new Set(['app', 'file', 'command', 'app-action', 'setting']);

/** One activated result as a stored string (small: what is needed to show and reopen it). */
export function encodeRecent(item) {
    if (!RECENT_KINDS.has(item?.kind) || !item.id || !item.title)
        return null;
    const out = { k: item.kind, i: item.id, t: String(item.title).slice(0, 200) };
    if (item.subtitle)
        out.s = String(item.subtitle).slice(0, 200);
    if (item.kind === 'file' && item.uri)
        out.u = item.uri;
    if (item.mime)
        out.m = item.mime;
    return JSON.stringify(out);
}

/** @returns {?{kind, id, title, subtitle?, uri?, mime?}} null for anything malformed */
export function decodeRecent(s) {
    let o;
    try {
        o = JSON.parse(s);
    } catch (e) {
        return null;
    }
    if (!o || typeof o !== 'object' || !RECENT_KINDS.has(o.k) || typeof o.i !== 'string' ||
        typeof o.t !== 'string')
        return null;
    if (o.k === 'file' && !/^file:\/\//.test(o.u ?? ''))
        return null;
    const out = { kind: o.k, id: o.i, title: o.t };
    if (typeof o.s === 'string')
        out.subtitle = o.s;
    if (o.k === 'file')
        out.uri = o.u;
    if (typeof o.m === 'string')
        out.mime = o.m;
    return out;
}

/** Put an activated result at the front of the recent list (strings from encodeRecent). */
export function pushRecent(list, item, max = RECENT_MAX) {
    const s = encodeRecent(item);
    if (!s)
        return [...(list ?? [])].slice(0, max);
    return [s, ...(list ?? []).filter(x => decodeRecent(x)?.id !== item.id)].slice(0, max);
}

// ---- Apps view -------------------------------------------------------------------------------

/**
 * The Apps view, as Tahoe draws it: the most used apps on top, then every app A to Z. The
 * same records as the search index (AppsProvider), so it stays in step with the app grid.
 * @param {object[]} apps records with appId and title
 * @param {string[]} mostUsed app ids, most used first
 */
export function appsBrowse(apps, mostUsed, top = 6) {
    const byId = new Map(apps.map(a => [a.appId, a]));
    const suggestions = [];
    for (const id of mostUsed) {
        const a = byId.get(id);
        if (a)
            suggestions.push(a);
        if (suggestions.length >= top)
            break;
    }
    const all = [...apps].sort((a, b) => a.title.localeCompare(b.title));
    const sections = [];
    if (suggestions.length > 0)
        sections.push({ id: 'suggestions', layout: 'grid', items: suggestions.map(a => ({ ...a, id: `top:${a.id}` })) });
    if (all.length > 0)
        sections.push({ id: 'all-apps', layout: 'grid', items: all });
    return sections;
}

// ---- keyboard movement over list and grid sections ---------------------------------------------

/**
 * Move the selection with an arrow key over sections that are lists (one item per row) or
 * grids (`layout: 'grid'`, `cols` items per row). Up/Down keep the column across grid rows
 * and sections; Left/Right step one item and only move inside grids.
 *
 * @param {Array<{items:object[], layout?:string}>} sections
 * @param {number} index flat index (-1: nothing selected)
 * @param {'up'|'down'|'left'|'right'} key
 * @param {number} cols items per grid row
 * @returns {number} the new flat index
 */
export function moveIn(sections, index, key, cols) {
    const rows = [];
    let flat = 0;
    for (const s of sections) {
        const per = s.layout === 'grid' ? Math.max(1, cols) : 1;
        for (let i = 0; i < s.items.length; i += per)
            rows.push({ start: flat + i, count: Math.min(per, s.items.length - i), grid: per > 1 });
        flat += s.items.length;
    }
    if (flat === 0)
        return -1;
    if (index < 0)
        return key === 'up' ? flat - 1 : 0;
    const r = rows.findIndex(row => index >= row.start && index < row.start + row.count);
    const row = rows[r];
    const col = index - row.start;
    switch (key) {
    case 'left':
        return row.grid && col > 0 ? index - 1 : index;
    case 'right':
        return row.grid && col < row.count - 1 ? index + 1 : index;
    case 'up':
    case 'down': {
        const to = rows[(r + (key === 'up' ? -1 : 1) + rows.length) % rows.length];
        return to.start + Math.min(col, to.count - 1);
    }
    default:
        return index;
    }
}
