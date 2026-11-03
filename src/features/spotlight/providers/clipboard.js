// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard rows from the clipboard feature's history (the running clipboard-history
// instance, looked up at use time; null while that feature is off, so the group then simply
// does not exist). Text entries
// are matched on their text; images only show in the empty-query list.

import { rank } from '../model.js';

const MAX_SCAN = 200;
const MAX_RESULTS = 6;

function toItem(entry, _) {
    const isImage = entry.kind === 'image';
    return {
        id: `clip:${entry.id}`,
        kind: 'clipboard',
        title: isImage ? _('Image') : (entry.preview ?? entry.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        subtitle: entry.app ? `${_('Clipboard')} · ${entry.app}` : _('Clipboard'),
        keywords: isImage ? [] : [entry.text?.slice(0, 400) ?? ''],
        iconName: isImage ? 'image-x-generic-symbolic' : 'edit-paste-symbolic',
        entry,
    };
}

export class ClipboardProvider {
    /**
     * @param {Function} gettext
     * @param {() => ?object} history the running clipboard-history feature, or null
     */
    constructor(gettext, history) {
        this._ = gettext;
        this._history = history;
    }

    get available() {
        return !!this._history();
    }

    searchSync(query) {
        const source = this._history();
        if (!source)
            return [];
        const items = source.latest(MAX_SCAN)
            .filter(e => e.kind === 'text' && typeof e.text === 'string')
            .map(e => toItem(e, this._));
        // Newest first is the tie-break; rank() is stable
        return rank(items, query, MAX_RESULTS);
    }

    recent(limit = 4) {
        const source = this._history();
        return source ? source.latest(limit).map(e => toItem(e, this._)) : [];
    }

    /** Copy (never paste: Spotlight is not a paste target). */
    activate(item) {
        this._history()?.copy(item.entry);
        return true;
    }
}
