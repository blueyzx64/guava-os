// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history policy. Pure: no gi imports, no Shell, no I/O, so it runs under
// plain `gjs -m` (tests/clipboardModel.test.js). index.js feeds it facts (offered mime
// types, focused app, sizes, a content hash) and acts on what it returns.

export const MiB = 1024 * 1024;

export const DEFAULTS = Object.freeze({
    maxItems: 25,                // unpinned entries kept; pinned ones never count or expire
    maxTextBytes: 256 * 1024,    // longer text is not recorded
    maxImageBytes: 5 * MiB,      // bigger images are not recorded
    maxPreviewChars: 400,        // stored preview length for list rows
    images: true,
    ignoreSensitive: true,
    maxTotalImageBytes: 256 * MiB,   // all image bytes kept (64 MiB when nothing is saved to disk)
    maxTotalTextBytes: 4 * MiB,      // all text bytes kept; keeps history.json small
    maxPinned: 50,
    maxImageSide: 8192,              // px, either side; bigger images are not recorded
    maxImagePixels: 40_000_000,      // width * height
    maxAgeMs: 0,                 // 0 = no expiry for unpinned entries
});

export const MIN_ITEMS = 1;
export const MAX_ITEMS = 500;

/** Mime types a password manager adds to mark a secret (KeePassXC, Klipper/CopyQ convention). */
export const SECRET_MIMES = Object.freeze(['x-kde-passwordManagerHint']);

/**
 * Lowercased app ids / WM classes of password managers. Matched against the focused window
 * when the clipboard changed, as a whole id or as the last dotted part ("org.keepassxc.KeePassXC").
 */
export const PASSWORD_MANAGER_APPS = Object.freeze([
    'keepassxc', 'keepass2', 'keepassx', 'bitwarden', '1password', 'proton pass', 'proton-pass',
    'protonpass', 'enpass', 'lastpass', 'dashlane', 'nordpass', 'keeper', 'buttercup',
    'seahorse', 'gnome-keyring', 'org.gnome.seahorse.application', 'org.gnome.world.secrets',
    'secrets', 'org.gnome.passwordsafe', 'passwordsafe', 'authenticator',
    'com.belmoussaoui.authenticator', 'authy', 'gopass', 'pass', 'passwords', 'psono',
    'strongbox', 'zoho vault', 'roboform', 'myki', 'pwsafe', 'revelation',
    'com.bitwarden.desktop', 'com.1password.1password', '1password-beta', 'me.proton.pass',
    'proton.pass', 'proton-pass-desktop', 'org.keepassxc.keepassxc', 'keepassxc-browser',
    'org.gnome.seahorse', 'com.enpass.enpass', 'org.gnome.secrets', 'io.github.seadve.secrets',
]);

const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
// No SVG: a tiny file can take the Shell's renderer arbitrarily long to draw
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
export const TEXT_MIME = 'text/plain;charset=utf-8';

export const IMAGE_EXT = Object.freeze({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/bmp': 'bmp',
});

/** @returns {string} normalised app key: lowercase, trimmed */
function appKey(app) {
    return typeof app === 'string' ? app.trim().toLowerCase() : '';
}

/** True if the focused app (WM class / app id) is a known or user-listed password manager. */
export function isPasswordManagerApp(app, extra = []) {
    const key = appKey(app);
    if (!key)
        return false;
    const list = new Set([...PASSWORD_MANAGER_APPS, ...extra.map(appKey).filter(Boolean)]);
    if (list.has(key))
        return true;
    const base = key.replace(/\.desktop$/, '');
    if (list.has(base))
        return true;
    const last = base.split('.').pop();
    return list.has(last) && last.length > 4;      // "pass", "secrets" must match the whole id
}

/** True if the offered mime types carry a "this is a secret" marker. */
export function hasSecretHint(mimes) {
    return (mimes ?? []).some(m => SECRET_MIMES.includes(m));
}

/**
 * Should a clipboard change be skipped as a secret?
 *
 * @param {{mimes: string[], app?: string, ignoreSensitive?: boolean, extraApps?: string[]}} f
 */
export function isSecret({ mimes, app, ignoreSensitive = true, extraApps = [] }) {
    if (!ignoreSensitive)
        return false;
    return hasSecretHint(mimes) || isPasswordManagerApp(app, extraApps);
}

/**
 * Pick what to read from the offered mime types.
 *
 * @param {string[]} offered
 * @param {{images?: boolean}} [opts]
 * @returns {{kind: 'text'|'image', mime: string}|null} text wins over an image: apps that copy
 *   both (a spreadsheet cell) want the text, and file managers offer only text/uri-list.
 */
export function pickMime(offered, { images = true } = {}) {
    const list = offered ?? [];
    const text = TEXT_MIMES.find(m => list.includes(m));
    if (text)
        return { kind: 'text', mime: text };
    if (images) {
        const img = IMAGE_MIMES.find(m => list.includes(m));
        if (img)
            return { kind: 'image', mime: img };
    }
    return null;
}

/**
 * @returns {'ok'|'empty'|'too-large'|'disabled'}
 */
export function checkSize(kind, size, limits = {}) {
    const l = { ...DEFAULTS, ...limits };
    if (kind === 'image' && !l.images)
        return 'disabled';
    if (!(size > 0))
        return 'empty';
    const max = kind === 'image' ? l.maxImageBytes : l.maxTextBytes;
    return size > max ? 'too-large' : 'ok';
}

/* ------------------------------------------------------- image header */

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u32le = (b, i) => ((b[i + 3] << 24) >>> 0) + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]);
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function _jpegSize(b) {
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff)
            return null;
        const m = b[i + 1];
        if (m === 0xff) {           // fill byte
            i++;
            continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
            i += 2;
            continue;
        }
        if (m === 0xda || m === 0xd9)   // start of scan / end: no frame header seen
            return null;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
            return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
        i += 2 + u16be(b, i + 2);
    }
    return null;
}

/**
 * Pixel size from the file header, without decoding (PNG, JPEG, GIF, BMP, WebP).
 *
 * @param {Uint8Array} b image bytes
 * @returns {{width: number, height: number}|null} null when the header is not understood
 */
export function imageDimensions(b) {
    if (!(b instanceof Uint8Array) || b.length < 30)
        return null;
    let d = null;
    if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR')
        d = { width: u32be(b, 16), height: u32be(b, 20) };
    else if (b[0] === 0xff && b[1] === 0xd8)
        d = _jpegSize(b);
    else if (ascii(b, 0, 4) === 'GIF8')
        d = { width: u16le(b, 6), height: u16le(b, 8) };
    else if (ascii(b, 0, 2) === 'BM')
        d = u32le(b, 14) === 12
            ? { width: u16le(b, 18), height: u16le(b, 20) }
            : { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
    else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
        const chunk = ascii(b, 12, 4);
        if (chunk === 'VP8 ')
            d = { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        else if (chunk === 'VP8L' && b[20] === 0x2f) {
            const bits = u32le(b, 21);
            d = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        } else if (chunk === 'VP8X') {
            d = {
                width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
                height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
            };
        }
    }
    return d && d.width > 0 && d.height > 0 ? d : null;
}

/**
 * Is an image small enough in pixels to decode in the Shell? Unknown size fails closed.
 *
 * @returns {'ok'|'too-large'|'unknown'}
 */
export function checkDimensions(dim, limits = {}) {
    const l = { ...DEFAULTS, ...limits };
    if (!dim || !(dim.width > 0) || !(dim.height > 0))
        return 'unknown';
    if (dim.width > l.maxImageSide || dim.height > l.maxImageSide ||
        dim.width * dim.height > l.maxImagePixels)
        return 'too-large';
    return 'ok';
}

/* ------------------------------------------------------ content secrets */

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const TOKEN_RES = [
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,     // JWT
    /\bgh[pousr]_[A-Za-z0-9]{30,}/,                                        // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{40,}/,
    /\bglpat-[A-Za-z0-9_-]{20,}/,                                          // GitLab
    /\bxox[abpr]-[A-Za-z0-9-]{10,}/,                                       // Slack
    /\bsk-[A-Za-z0-9_-]{20,}/,                                             // OpenAI and similar
    /\b[sr]k_live_[A-Za-z0-9]{16,}/,                                       // Stripe
    /\bAKIA[0-9A-Z]{16}\b/,                                                // AWS access key id
    /\bAIza[0-9A-Za-z_-]{35}\b/,                                           // Google API key
];

/** Luhn checksum over a digit string. */
export function luhnValid(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = digits.charCodeAt(digits.length - 1 - i) - 48;
        if (i % 2 === 1) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
    }
    return digits.length > 0 && sum % 10 === 0;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(text) {
    const counts = new Map();
    for (const ch of text)
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const n = [...text].length;
    let h = 0;
    for (const c of counts.values())
        h -= (c / n) * Math.log2(c / n);
    return h;
}

function _looksLikeCard(t) {
    if (!/^[0-9][0-9 -]{11,22}[0-9]$/.test(t))
        return false;
    const digits = t.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhnValid(digits);
}

function _looksLikeRandomToken(t) {
    if (t.length < 24 || t.length > 512 || /\s/.test(t))
        return false;
    // URLs, mail addresses and paths are long single words too; they are not secrets
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || /^www\./i.test(t) || t.includes('@') || /^[~./]/.test(t) || t.includes('/'))
        return false;
    // Random tokens mix lower case, upper case and digits; identifiers and words rarely do
    if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/[0-9]/.test(t))
        return false;
    return shannonEntropy(t) >= 4.0;
}

/**
 * Does copied text look like a secret? Private keys, API tokens, JWTs, a card number on its
 * own, or a long random single-word token. Tuned for few false positives on prose and code.
 */
export function looksSecret(text) {
    if (typeof text !== 'string')
        return false;
    if (PRIVATE_KEY_RE.test(text) || TOKEN_RES.some(re => re.test(text)))
        return true;
    const t = text.trim();
    return _looksLikeCard(t) || _looksLikeRandomToken(t);
}

/** Whitespace-only text is not worth keeping. */
export function isBlankText(text) {
    return typeof text !== 'string' || text.trim().length === 0;
}

/**
 * Is recording allowed right now?
 *
 * @param {{enabled: boolean, recording: boolean, locked: boolean}} s
 */
export function shouldRecord({ enabled, recording, locked }) {
    return !!enabled && !!recording && !locked;
}

const URL_RE = /^(?:https?|ftp|file|mailto|sftp|ssh):\/\/?[^\s]+$|^mailto:[^\s@]+@[^\s@]+$|^www\.[^\s.]+\.[^\s]+$/i;
const COLOR_RE = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^)]{3,60}\))$/i;

/** @returns {'link'|'color'|'text'} */
export function classifyText(text) {
    const t = (text ?? '').trim();
    if (!t || t.includes('\n'))
        return 'text';
    if (COLOR_RE.test(t))
        return 'color';
    if (URL_RE.test(t))
        return 'link';
    return 'text';
}

/** First-line preview, collapsed whitespace, cut to `max` characters. */
export function previewOf(text, max = DEFAULTS.maxPreviewChars) {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Build an entry. `hash` is the caller's content hash (sha256 hex of the bytes); two entries
 * with the same kind and hash are the same item.
 *
 * @param {object} p
 * @param {'text'|'image'} p.kind
 * @param {string} p.hash
 * @param {string} p.mime
 * @param {number} p.size bytes
 * @param {number} p.time ms since epoch
 * @param {string} [p.text] text entries
 * @param {string} [p.app] source app name
 * @param {string} [p.file] image file name inside the store (persisted images)
 * @param {number} [p.width] image px
 * @param {number} [p.height]
 */
export function makeEntry(p) {
    const e = {
        id: `${p.kind}:${p.hash}`,
        kind: p.kind,
        type: p.kind === 'image' ? 'image' : classifyText(p.text),
        hash: p.hash,
        mime: p.mime,
        size: p.size,
        time: p.time,
        app: p.app ?? '',
        pinned: false,
    };
    if (p.kind === 'text') {
        e.text = p.text;
        e.preview = previewOf(p.text);
    } else {
        e.file = p.file ?? '';
        if (p.width)
            e.width = p.width;
        if (p.height)
            e.height = p.height;
    }
    return e;
}

function clampItems(n) {
    const v = Math.trunc(Number(n));
    if (!Number.isFinite(v))
        return DEFAULTS.maxItems;
    return Math.min(MAX_ITEMS, Math.max(MIN_ITEMS, v));
}

/**
 * Newest-first history. Pinned entries sort first in list() but keep their own recency
 * order, never count toward the cap and never age out.
 */
export class History {
    constructor(opts = {}) {
        this._max = clampItems(opts.maxItems ?? DEFAULTS.maxItems);
        this._maxAge = Math.max(0, opts.maxAgeMs ?? DEFAULTS.maxAgeMs);
        this._maxImageTotal = opts.maxTotalImageBytes ?? DEFAULTS.maxTotalImageBytes;
        this._maxTextTotal = opts.maxTotalTextBytes ?? DEFAULTS.maxTotalTextBytes;
        this._maxPinned = opts.maxPinned ?? DEFAULTS.maxPinned;
        this._items = [];        // newest first
    }

    get maxItems() {
        return this._max;
    }

    get size() {
        return this._items.length;
    }

    /** Raw array, newest first (do not mutate). */
    get items() {
        return this._items;
    }

    get(id) {
        return this._items.find(e => e.id === id) ?? null;
    }

    /**
     * Add an entry.
     *
     * @param {object} entry from makeEntry()
     * @returns {{status: 'added'|'bumped'|'same', entry: object, evicted: object[]}}
     *   'same' = it is already the newest entry (nothing changed, e.g. our own paste).
     *   'bumped' = a duplicate moved to the top; pin and first-seen app are kept, time updates.
     *   'refused' = it can never fit the byte budget, because pinned entries already use it.
     *   evicted: entries pushed out by the cap; the store deletes their files.
     */
    add(entry) {
        const at = this._items.findIndex(e => e.id === entry.id);
        if (at === 0) {
            this._items[0].time = entry.time;
            return { status: 'same', entry: this._items[0], evicted: [] };
        }
        if (at > 0) {
            const [old] = this._items.splice(at, 1);
            old.time = entry.time;
            if (entry.app)
                old.app = entry.app;
            this._items.unshift(old);
            return { status: 'bumped', entry: old, evicted: [] };
        }
        if (!this._fits(entry))
            return { status: 'refused', entry, evicted: [] };
        this._items.unshift(entry);
        return { status: 'added', entry, evicted: this._trim() };
    }

    remove(id) {
        const at = this._items.findIndex(e => e.id === id);
        return at < 0 ? null : this._items.splice(at, 1)[0];
    }

    /** @returns {boolean|null} the new pinned state, null for an unknown id */
    togglePin(id) {
        const e = this.get(id);
        if (!e)
            return null;
        if (!e.pinned) {
            // Pinned entries are never evicted, so they are capped by count and by bytes
            if (this._items.filter(x => x.pinned).length >= this._maxPinned)
                return null;
            if (this._bytes(e.kind, true) + e.size > this._budget(e.kind))
                return null;
        }
        e.pinned = !e.pinned;
        return e.pinned;
    }

    /** Change limits (settings changed). @returns {object[]} evicted */
    configure(opts) {
        if (opts.maxItems !== undefined)
            this._max = clampItems(opts.maxItems);
        if (opts.maxTotalImageBytes !== undefined)
            this._maxImageTotal = opts.maxTotalImageBytes;
        if (opts.maxTotalTextBytes !== undefined)
            this._maxTextTotal = opts.maxTotalTextBytes;
        return this._trim();
    }

    _budget(kind) {
        return kind === 'image' ? this._maxImageTotal : this._maxTextTotal;
    }

    _bytes(kind, pinnedOnly = false) {
        let n = 0;
        for (const e of this._items) {
            if (e.kind === kind && (!pinnedOnly || e.pinned))
                n += e.size;
        }
        return n;
    }

    _fits(entry) {
        return this._bytes(entry.kind, true) + entry.size <= this._budget(entry.kind);
    }

    /**
     * Remove everything unpinned (or everything).
     *
     * @returns {object[]} removed entries
     */
    clear({ keepPinned = true } = {}) {
        const gone = this._items.filter(e => !(keepPinned && e.pinned));
        this._items = this._items.filter(e => keepPinned && e.pinned);
        return gone;
    }

    /** @returns {object[]} entries evicted by the new cap */
    setMaxItems(n) {
        this._max = clampItems(n);
        return this._trim();
    }

    /** Drop unpinned entries older than maxAge. @returns {object[]} removed */
    expire(now) {
        if (!this._maxAge)
            return [];
        const gone = this._items.filter(e => !e.pinned && now - e.time > this._maxAge);
        if (gone.length)
            this._items = this._items.filter(e => !gone.includes(e));
        return gone;
    }

    /**
     * Rows for a view: pinned first, then recent, each newest first.
     *
     * @param {{filter?: 'all'|'text'|'links'|'images', query?: string}} [q]
     * @returns {{pinned: object[], recent: object[]}}
     */
    view({ filter = 'all', query = '' } = {}) {
        const needle = query.trim().toLowerCase();
        const match = e => {
            if (filter === 'text' && !(e.kind === 'text' && e.type !== 'link'))
                return false;
            if (filter === 'links' && e.type !== 'link')
                return false;
            if (filter === 'images' && e.kind !== 'image')
                return false;
            if (!needle)
                return true;
            return e.kind === 'text'
                ? e.text.toLowerCase().includes(needle) || e.app.toLowerCase().includes(needle)
                : 'image'.includes(needle) || e.app.toLowerCase().includes(needle);
        };
        const rows = this._items.filter(match);
        return { pinned: rows.filter(e => e.pinned), recent: rows.filter(e => !e.pinned) };
    }

    /** File names (images) that live entries still need. */
    referencedFiles() {
        return new Set(this._items.filter(e => e.kind === 'image' && e.file).map(e => e.file));
    }

    _trim() {
        const evicted = [];
        let unpinned = 0;
        // Newest first: keep the first `max` unpinned entries, evict the rest
        this._items = this._items.filter(e => {
            if (e.pinned)
                return true;
            unpinned++;
            if (unpinned <= this._max)
                return true;
            evicted.push(e);
            return false;
        });
        // Byte budgets, per kind: drop the oldest unpinned until the total fits
        for (const kind of ['image', 'text']) {
            let total = this._bytes(kind);
            for (let i = this._items.length - 1; i >= 0 && total > this._budget(kind); i--) {
                const e = this._items[i];
                if (e.kind !== kind || e.pinned)
                    continue;
                this._items.splice(i, 1);
                evicted.push(e);
                total -= e.size;
            }
        }
        return evicted;
    }
}

/* ------------------------------------------------------------ persistence */

export const INDEX_VERSION = 1;

/** The JSON text of history.json. Images are not inlined: only their file names. */
export function serializeHistory(history) {
    return JSON.stringify({ version: INDEX_VERSION, items: history.items });
}

const SAFE_FILE = /^[0-9a-f]{64}\.(?:png|jpg|webp|gif|bmp)$/;

/** True if `name` is a file name the store itself would have written (no paths, no dots). */
export function isStoreFileName(name) {
    return typeof name === 'string' && SAFE_FILE.test(name);
}

/** The file name an image entry is stored under. */
export function imageFileName(hash, mime) {
    const ext = IMAGE_EXT[mime];
    return ext ? `${hash}.${ext}` : '';
}

/**
 * Rebuild entries from history.json text. Anything malformed is dropped, never thrown:
 * a damaged file must not stop the extension from enabling.
 *
 * @param {string} json
 * @param {object} [limits] see DEFAULTS; also re-applied here (the user may have lowered them)
 * @returns {object[]} entries, newest first
 */
export function parseHistory(json, limits = {}) {
    return parseHistoryChecked(json, limits).entries;
}

/**
 * Like parseHistory, but also says whether the file itself was readable as a history index.
 * `ok: false` (bad JSON, other version, wrong shape) means the caller must not treat the
 * result as "the history is empty": it keeps the file aside and deletes nothing.
 *
 * @returns {{ok: boolean, entries: object[]}}
 */
export function parseHistoryChecked(json, limits = {}) {
    let data;
    try {
        data = JSON.parse(json);
    } catch (_e) {
        return { ok: false, entries: [] };
    }
    if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.items))
        return { ok: false, entries: [] };
    return { ok: true, entries: _entriesFrom(data.items, limits) };
}

function _entriesFrom(items, limits) {
    const l = { ...DEFAULTS, ...limits };
    const seen = new Set();
    const out = [];
    for (const raw of items) {
        if (!raw || typeof raw !== 'object' || typeof raw.hash !== 'string' || !raw.hash)
            continue;
        const time = Number.isFinite(raw.time) ? raw.time : 0;
        const size = Number.isFinite(raw.size) ? raw.size : 0;
        let e;
        if (raw.kind === 'text' && typeof raw.text === 'string') {
            if (isBlankText(raw.text) || checkSize('text', size || raw.text.length, l) !== 'ok')
                continue;
            e = makeEntry({
                kind: 'text', hash: raw.hash, mime: TEXT_MIME, size, time,
                text: raw.text, app: typeof raw.app === 'string' ? raw.app : '',
            });
        } else if (raw.kind === 'image' && isStoreFileName(raw.file)) {
            if (checkSize('image', size, l) !== 'ok')
                continue;
            // Stored sizes too big to decode are dropped; missing ones are checked by the store
            const hasDim = raw.width !== undefined || raw.height !== undefined;
            if (hasDim && checkDimensions({ width: raw.width, height: raw.height }, l) !== 'ok')
                continue;
            e = makeEntry({
                kind: 'image', hash: raw.hash, mime: typeof raw.mime === 'string' ? raw.mime : 'image/png',
                size, time, file: raw.file, app: typeof raw.app === 'string' ? raw.app : '',
                width: raw.width, height: raw.height,
            });
        } else {
            continue;
        }
        if (seen.has(e.id))
            continue;
        seen.add(e.id);
        e.pinned = raw.pinned === true;
        out.push(e);
    }
    return out;
}

/**
 * Merge the saved history (loaded late, after enable) with entries recorded meanwhile.
 * Live entries win over saved copies of themselves (newer time, current pin state).
 *
 * @returns {{history: History, evicted: object[]}}
 */
export function mergeLoaded(live, saved, opts = {}) {
    const ids = new Set(live.map(e => e.id));
    return historyFrom([...live, ...saved.filter(e => !ids.has(e.id))], opts);
}

/** Build a History from parsed entries (applies the cap; returns evicted too). */
export function historyFrom(entries, opts = {}) {
    const h = new History(opts);
    h._items = [...entries].sort((a, b) => b.time - a.time);
    return { history: h, evicted: h._trim() };
}

/** Image files in the store folder that no entry references (safe to delete: Guava wrote them). */
export function orphanFiles(listed, history) {
    const used = history.referencedFiles();
    return listed.filter(name => isStoreFileName(name) && !used.has(name));
}

/* --------------------------------------------------------------- paste */

// Shared with every feature that types into a window (lib/pasteModel.js)
export { pasteChordFor } from '../../lib/pasteModel.js';

/* ---------------------------------------------------------------- view */

export const TYPE_ICON = Object.freeze({
    text: 'text-x-generic-symbolic',
    link: 'insert-link-symbolic',
    color: 'applications-graphics-symbolic',
    image: 'image-x-generic-symbolic',
});

/**
 * St.Icon constructor properties for a row's type tile. Never holds an `undefined` value:
 * GJS on GNOME 50 throws "Invalid value 'undefined' for property gicon in object
 * initializer", which aborted every popover and Quick Paste refresh at the first row.
 *
 * @param {string} type entry.type
 * @param {number} size tile size in px
 * @param {object|null} gicon thumbnail for images, or null for the type glyph
 */
export function tileIconProps(type, size, gicon = null) {
    if (gicon)
        return { gicon, icon_size: size, style_class: 'guava-clip-thumb' };
    return {
        icon_name: TYPE_ICON[type] ?? TYPE_ICON.text,
        icon_size: Math.round(size * 0.55),
        style_class: 'guava-clip-glyph',
    };
}

/** "2 min ago" style age as [unit, n] so the view can translate it. */
export function ageOf(then, now) {
    const s = Math.max(0, Math.floor((now - then) / 1000));
    if (s < 45)
        return ['now', 0];
    if (s < 3600)
        return ['minutes', Math.max(1, Math.round(s / 60))];
    if (s < 86400)
        return ['hours', Math.round(s / 3600)];
    return ['days', Math.round(s / 86400)];
}
