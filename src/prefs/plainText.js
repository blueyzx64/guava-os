// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// Preferences text is plain text, never Pango markup. Adw rows (and group titles) parse their
// text as markup by default, so a title such as "Left & Right" fails to parse and the row shows
// no text at all. plainTextTree() makes a built widget tree safe: every Adw.PreferencesRow gets
// use-markup off, and every Adw.PreferencesGroup title (groups have no such switch) is escaped.
// The row helpers in prefs/widgets.js also turn markup off for rows added later.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';

// A title that would not survive markup parsing: an ampersand that does not start an entity, or <
const UNSAFE = /&(?![a-zA-Z]+;|#[0-9]+;|#x[0-9a-fA-F]+;)|</;

export function plainText(row) {
    if (row instanceof Adw.PreferencesRow)
        row.use_markup = false;
    return row;
}

export function plainTextTree(root) {
    const stack = [root];
    while (stack.length) {
        const w = stack.pop();
        if (w instanceof Adw.PreferencesRow) {
            w.use_markup = false;
        } else if (w instanceof Adw.PreferencesGroup) {
            if (w.title && UNSAFE.test(w.title))
                w.title = GLib.markup_escape_text(w.title, -1);
            if (w.description && UNSAFE.test(w.description))
                w.description = GLib.markup_escape_text(w.description, -1);
        }
        for (let c = w.get_first_child(); c; c = c.get_next_sibling())
            stack.push(c);
    }
}
