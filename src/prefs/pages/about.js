// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 blueyzx64
//
// About: logo, name, version, the Setup Assistant row, project links, credits, the legal sheet
// and a folded list of extensions that work well beside Guava. Adw/Gtk only (the prefs process).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import * as onboardingPrefs from '../../features/onboarding/prefs.js';
import { addFeatureGroups, linkRow } from '../widgets.js';
import {
    REPO_URL, ISSUES_URL, LICENSE_URL, CREDITS, RECOMMENDED, versionLabel, releaseUrl,
} from '../aboutModel.js';

export const PAGE = { id: 'about', icon: 'help-about-symbolic' };

const COPYRIGHT_LINE = '© 2026 blueyzx64';
const WARRANTY = 'This program is free software: you can redistribute it and/or modify it under the terms of the ' +
    'GNU General Public License as published by the Free Software Foundation, either version 3 of the License, ' +
    'or (at your option) any later version.';

function headerGroup({ extension, title, _ }) {
    const column = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8, halign: Gtk.Align.CENTER,
        margin_top: 12, margin_bottom: 12,
    });
    const logo = new Gtk.Picture({
        file: Gio.File.new_for_path(`${extension.path}/icons/guava_logo.png`),
        content_fit: Gtk.ContentFit.CONTAIN,
        width_request: 128, height_request: 128,
        can_shrink: true, halign: Gtk.Align.CENTER,
    });
    column.append(logo);
    column.append(new Gtk.Label({
        use_markup: true,
        label: `<span size="xx-large" weight="bold">${GLib.markup_escape_text(title, -1)}</span>`,
    }));
    column.append(new Gtk.Label({ label: 'blueyzx64', css_classes: ['dim-label'] }));

    const { 'version-name': name, version } = extension.metadata;
    const pill = new Gtk.Button({
        label: versionLabel(name, version),
        tooltip_text: _('Change log'),
        css_classes: ['guava-version-button', 'pill'],
        halign: Gtk.Align.CENTER,
        margin_top: 4,
    });
    pill.connect('clicked', () => Gtk.show_uri(null, releaseUrl(name), Gdk.CURRENT_TIME));
    column.append(pill);
    column.append(new Gtk.Label({
        label: _('EXPERIMENTAL: no known major bugs, but laggy'),
        css_classes: ['warning', 'caption-heading'],
        halign: Gtk.Align.CENTER,
        margin_top: 6,
    }));

    const group = new Adw.PreferencesGroup();
    group.add(column);
    return group;
}

function creditsRow(_) {
    const row = new Adw.ExpanderRow({
        title: _('Credits'),
        subtitle: _('Code and inspiration'),
    });
    for (const credit of CREDITS)
        row.add_row(linkRow(credit.title, credit.url, _(credit.subtitle)));
    return row;
}

function legalDialog(window, _) {
    const dialog = new Adw.Dialog({
        title: _('Legal'), content_width: 420, content_height: 560,
        presentation_mode: Adw.DialogPresentationMode.BOTTOM_SHEET,
    });
    const page = new Adw.PreferencesPage();
    const license = new Adw.PreferencesGroup({
        title: _('License'),
        description: _('Guava is free and open source software'),
    });
    license.add(linkRow('GNU General Public License v3.0', LICENSE_URL,
        _('View the full license text on GitHub')));
    page.add(license);

    const copyright = new Adw.PreferencesGroup({ title: _('Copyright') });
    copyright.add(new Gtk.Label({
        label: `${COPYRIGHT_LINE}\n\n${_(WARRANTY)}`,
        wrap: true, xalign: 0, selectable: true,
    }));
    page.add(copyright);

    const toolbar = new Adw.ToolbarView({ content: page });
    toolbar.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(toolbar);
    dialog.present(window);
}

function linksGroups({ window, _ }) {
    const website = new Adw.PreferencesGroup();
    website.add(linkRow(_('Website'), REPO_URL));
    const issues = new Adw.PreferencesGroup();
    issues.add(linkRow(_('Report an Issue'), ISSUES_URL));

    const about = new Adw.PreferencesGroup();
    about.add(creditsRow(_));
    const legal = new Adw.ActionRow({ title: _('Legal'), activatable: true });
    legal.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
    legal.connect('activated', () => legalDialog(window, _));
    about.add(legal);
    return [website, issues, about];
}

function recommendedGroup(_) {
    const group = new Adw.PreferencesGroup();
    const expander = new Adw.ExpanderRow({
        title: _('Other Recommended Extensions'),
        subtitle: _('Extensions that are compatible with Guava'),
    });
    for (const [title, author, url] of RECOMMENDED)
        expander.add_row(linkRow(title, url, author));
    group.add(expander);
    return group;
}

/**
 * @param {{settings, extension, window, _: Function, breakpoints: Adw.Breakpoint[], title: string}} args
 * @returns {Adw.PreferencesPage}
 */
export function build(args) {
    const { _ } = args;
    const page = new Adw.PreferencesPage({ title: _('About'), icon_name: PAGE.icon });
    page.add(headerGroup(args));
    addFeatureGroups(page, onboardingPrefs, args);
    for (const group of linksGroups(args))
        page.add(group);
    page.add(recommendedGroup(_));
    return page;
}
